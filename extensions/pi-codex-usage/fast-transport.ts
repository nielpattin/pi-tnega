import {
  registerSessionResourceCleanup,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  uuidv7,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { appendFileSync, statSync, unlinkSync } from "node:fs";
import { arch as osArch, platform as osPlatform, release as osRelease, tmpdir } from "node:os";

const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
function getPiUserAgent(): string {
  if (typeof process === "undefined") return "pi (browser)";
  try {
    return `pi (${osPlatform()} ${osRelease()}; ${osArch()})`;
  } catch {
    return `pi (${process.platform}; ${process.arch})`;
  }
}

function splitDeferredTools(
  context: Context,
  enabled: boolean,
): {
  immediate: NonNullable<Context["tools"]>;
  deferred: Map<string, NonNullable<Context["tools"]>[number]>;
} {
  const uniqueTools = new Map<string, NonNullable<Context["tools"]>[number]>();
  for (const tool of context.tools ?? []) uniqueTools.set(tool.name, tool);
  if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

  const deferredNames = new Set<string>();
  const usedNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") usedNames.add(block.name);
      }
    } else if (message.role === "toolResult") {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) deferredNames.add(name);
      }
    }
  }

  const immediate: NonNullable<Context["tools"]> = [];
  const deferred = new Map<string, NonNullable<Context["tools"]>[number]>();
  for (const [name, tool] of uniqueTools) {
    if (deferredNames.has(name)) deferred.set(name, tool);
    else immediate.push(tool);
  }
  return { immediate, deferred };
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES = "responses=experimental";
/** Bump when the fast transport changes; surfaced in /codex-usage output. */
export const FAST_TRANSPORT_REV = "2026-09-15k";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

type CodexModel = Model<"openai-codex-responses">;
type FastVerbosity = "low" | "medium" | "high";
type FastServiceTier = "default" | "flex" | "priority";
type FastStreamOptions = StreamOptions & {
  reasoningEffort?: string;
  reasoningSummary?: string;
  serviceTier?: FastServiceTier;
  textVerbosity?: FastVerbosity;
  toolChoice?: "auto" | "none" | "required";
};
type ResponseStreamEvent =
  Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;

type WebSocketListener = (event: unknown) => void;

type WebSocketLike = {
  readonly readyState: number;
  addEventListener(type: string, listener: WebSocketListener): void;
  removeEventListener(type: string, listener: WebSocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type WebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

export interface FastModeProviderSettings {
  isFastMode: () => boolean;
  getVerbosity?: () => FastVerbosity;
}

export interface FastModeHeaderOptions {
  accountId: string;
  token: string;
  requestId: string;
  sessionId?: string;
  modelId: string;
  transport?: "sse" | "websocket";
  additionalHeaders?: Record<string, string | null>;
}

/**
 * Build the final Codex request identity. This intentionally runs after caller
 * headers are merged: Pi's stock Codex adapter otherwise overwrites the
 * `originator` value with `pi`.
 */
export function buildFastModeHeaders(
  initHeaders: ConstructorParameters<typeof Headers>[0],
  options: FastModeHeaderOptions,
): Headers {
  const headers = new Headers(initHeaders);
  for (const [key, value] of Object.entries(options.additionalHeaders ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }

  headers.set("Authorization", `Bearer ${options.token}`);
  headers.set("chatgpt-account-id", options.accountId);
  headers.set("originator", "codex_cli_rs");
  headers.set("User-Agent", getPiUserAgent());
  headers.set("x-codex-routing-hint", `model=${options.modelId};tier=priority`);

  if (options.transport === "websocket") {
    headers.delete("accept");
    headers.delete("content-type");
    headers.delete("OpenAI-Beta");
    headers.delete("openai-beta");
    headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  } else {
    headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES);
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
  }

  const requestId =
    options.transport === "websocket" || options.transport === undefined
      ? options.requestId
      : options.sessionId;
  if (requestId) {
    headers.set("x-client-request-id", requestId);
    headers.set("session-id", requestId);
    headers.set("thread-id", requestId);
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeTokenPayload(segment: string): Record<string, unknown> {
  const raw =
    typeof Buffer !== "undefined"
      ? Buffer.from(segment, "base64").toString("utf8")
      : (() => {
          const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
          const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
          return atob(padded);
        })();
  return JSON.parse(raw) as Record<string, unknown>;
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error("Invalid token");
    const payload = decodeTokenPayload(parts[1]);
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") {
      throw new Error("No account ID in token");
    }
    return auth.chatgpt_account_id;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

function applyAdditionalHeaders(
  headers: Headers,
  values: Record<string, string | null> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
}

function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl: string | undefined): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

function clampReasoningEffort(modelId: string, effort: string): string {
  if (effort === "none") return effort;
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
  const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1]!, 10) : undefined;
  if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini")
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

function buildFastRequestBody(
  model: CodexModel,
  context: Context,
  options: FastStreamOptions | undefined,
  verbosity: FastVerbosity,
): Record<string, unknown> {
  const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
  const deferredToolsMode = model.compat?.supportsAdditionalTools
    ? "additional-tools"
    : model.compat?.supportsToolSearch
      ? "tool-search"
      : undefined;
  const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
  const grammarToolInputProperties = createGrammarToolInputProperties(
    context.tools,
    supportsOpenAIGrammarTools,
  );
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties,
    deferredTools: toolPlacement.deferred,
    deferredToolsMode,
    toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
  });
  const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input: messages,
    text: { verbosity: options?.textVerbosity ?? verbosity },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: clampOpenAIPromptCacheKey(cacheSessionId),
    tool_choice: options?.toolChoice ?? "auto",
    parallel_tool_calls: true,
    ...(options?.sessionId
      ? { client_metadata: { session_id: options.sessionId, thread_id: options.sessionId } }
      : {}),
  };

  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (toolPlacement.immediate.length > 0) {
    body.tools = convertResponsesTools(toolPlacement.immediate, {
      strict: null,
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    });
  }
  if (options?.reasoningEffort !== undefined) {
    const effort =
      options.reasoningEffort === "none"
        ? (model.thinkingLevelMap?.off ?? "none")
        : ((model.thinkingLevelMap as Record<string, string | null> | undefined)?.[
            options.reasoningEffort
          ] ?? options.reasoningEffort);
    if (effort !== null) {
      body.reasoning = {
        effort: clampReasoningEffort(model.id, effort),
        summary: options.reasoningSummary ?? "auto",
      };
    }
  }
  return body;
}

function applyFastModePayload(payload: unknown, verbosity: FastVerbosity): Record<string, unknown> {
  const body = isRecord(payload) ? payload : {};
  const text = isRecord(body.text) ? body.text : {};
  return { ...body, service_tier: "priority", text: { ...text, verbosity } };
}

function compressRequestBodyZstd(bodyJson: string): Uint8Array | undefined {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return undefined;
  }

  const zlib = process.getBuiltinModule?.("node:zlib") as
    | {
        constants?: { ZSTD_c_compressionLevel?: number };
        zstdCompressSync?: (data: string, options?: unknown) => Uint8Array;
      }
    | undefined;
  if (!zlib?.zstdCompressSync) return undefined;

  try {
    const level = zlib.constants?.ZSTD_c_compressionLevel;
    return zlib.zstdCompressSync(
      bodyJson,
      level === undefined ? undefined : { params: { [level]: REQUEST_COMPRESSION_ZSTD_LEVEL } },
    );
  } catch {
    return undefined;
  }
}

const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function isTerminalRateLimitError(errorText: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage_limit_reached|usage_not_included|rate_limit_exceeded|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
    errorText,
  );
}

function isRetryableError(status: number, errorText: string): boolean {
  if (status === 429 && isTerminalRateLimitError(errorText)) return false;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504)
    return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null) {
    const milliseconds = Number(retryAfterMs);
    if (Number.isFinite(milliseconds)) return Math.max(0, milliseconds);
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

class RetryDelayExceededError extends Error {}

function validateRetryDelayMs(delayMs: number, options: FastStreamOptions): number {
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
    throw new RetryDelayExceededError(
      `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
    );
  }
  return delayMs;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeTimeout(value: number | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid timeoutMs: ${String(value)}`);
  return Math.floor(value);
}

function createRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs === undefined || timeoutMs <= 0) return { signal: parent, cleanup: () => {} };

  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function readErrorResponse(response: Response): Promise<Error> {
  const raw = await response.text();
  let message = raw || response.statusText || `Codex request failed (${response.status})`;
  let friendlyMessage: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    if (error) {
      const code =
        typeof error.code === "string"
          ? error.code
          : typeof error.type === "string"
            ? error.type
            : "";
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) ||
        response.status === 429
      ) {
        const plan =
          typeof error.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : "";
        const resetsAt =
          typeof error.resets_at === "number" && Number.isFinite(error.resets_at)
            ? error.resets_at
            : undefined;
        const minutes =
          resetsAt === undefined
            ? undefined
            : Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
        const when = minutes === undefined ? "" : ` Try again in ~${minutes} min.`;
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      const errorMessage = typeof error.message === "string" ? error.message : undefined;
      message = errorMessage || friendlyMessage || message;
    }
  } catch {
    // Keep the raw response when the provider returns a non-JSON error body.
  }
  return new Error(friendlyMessage || message);
}

async function* parseSse(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncIterable<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer.trim()) buffer += "\n\n";
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") yield JSON.parse(data);
        separator = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // The reader may already be closed by the provider.
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have released its lock.
    }
  }
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (isRecord(data) && typeof data.arrayBuffer === "function") {
    const arrayBuffer = await data.arrayBuffer();
    if (arrayBuffer instanceof ArrayBuffer)
      return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}

const DEFAULT_PROXY_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 };
const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
  "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

function getProxyEnv(name: string, env?: Record<string, string>): string {
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  return (
    env?.[lower] ||
    env?.[upper] ||
    (typeof process !== "undefined" && process.env ? process.env[lower] : undefined) ||
    (typeof process !== "undefined" && process.env ? process.env[upper] : undefined) ||
    ""
  );
}

function proxyHostMatches(hostname: string, port: number, entry: string): boolean {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return false;
  const bracketed = trimmed.startsWith("[") ? trimmed.indexOf("]") : -1;
  const colon = bracketed >= 0 ? bracketed + 1 : trimmed.lastIndexOf(":");
  const host = (
    bracketed >= 0 ? trimmed.slice(1, bracketed) : colon > 0 ? trimmed.slice(0, colon) : trimmed
  )
    .replace(/^\*\.?/, "")
    .replace(/^\./, "");
  const entryPort =
    (bracketed >= 0 && trimmed[bracketed + 1] === ":"
      ? Number(trimmed.slice(bracketed + 2))
      : colon > 0
        ? Number(trimmed.slice(colon + 1))
        : 0) || 0;
  if (entryPort && entryPort !== port) return false;
  const targetHost = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return targetHost === host || targetHost.endsWith(`.${host}`);
}

function resolveHttpProxyUrlForTarget(
  targetUrl: string,
  env?: Record<string, string>,
): URL | undefined {
  const target = new URL(targetUrl);
  const protocol = target.protocol.slice(0, -1);
  const port = Number(target.port) || DEFAULT_PROXY_PORTS[protocol] || 0;
  const noProxy = getProxyEnv("no_proxy", env);
  if (
    noProxy === "*" ||
    noProxy.split(/[,\s]/).some((entry) => proxyHostMatches(target.hostname, port, entry))
  ) {
    return undefined;
  }
  let proxy = getProxyEnv(`${protocol}_proxy`, env) || getProxyEnv("all_proxy", env);
  if (!proxy) return undefined;
  if (!proxy.includes("://")) proxy = `${protocol}://${proxy}`;
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy);
  } catch (error) {
    throw new Error(`Invalid proxy URL ${JSON.stringify(proxy)}: ${formatError(error)}`, {
      cause: error,
    });
  }
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
  }
  return proxyUrl;
}

let cachedBunWebSocketConstructor: WebSocketConstructor | undefined;

function getWebSocketConstructor(env?: Record<string, string>): WebSocketConstructor | undefined {
  const globalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  if (typeof globalWebSocket !== "function") return undefined;
  if (typeof process === "undefined" || !process.versions?.bun) {
    return globalWebSocket as WebSocketConstructor;
  }
  if (!env && cachedBunWebSocketConstructor) return cachedBunWebSocketConstructor;

  const WebSocketBase = globalWebSocket as new (
    url: string,
    options?: { headers?: Record<string, string>; proxy?: string },
  ) => WebSocketLike;
  const WebSocketWithProxy = class extends WebSocketBase {
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      const targetUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
      const proxyUrl = resolveHttpProxyUrlForTarget(targetUrl, env);
      super(url, { ...options, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) });
    }
  };
  const constructor = WebSocketWithProxy as unknown as WebSocketConstructor;
  if (!env) cachedBunWebSocketConstructor = constructor;
  return constructor;
}

function connectWebSocket(
  url: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<WebSocketLike> {
  const webSocket = getWebSocketConstructor(env);
  if (!webSocket) throw new Error("WebSocket is not available in this runtime");

  return new Promise((resolve, reject) => {
    let socket: WebSocketLike;
    let settled = false;
    const timeout =
      timeoutMs > 0
        ? setTimeout(
            () => finish(new Error(`WebSocket connection timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        : undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket?.removeEventListener("open", onOpen);
      socket?.removeEventListener("error", onError);
      socket?.removeEventListener("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        try {
          socket?.close();
        } catch {
          // Ignore close failures while rejecting the connection.
        }
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onOpen = () => finish();
    const onError = (event: unknown) => {
      const message =
        isRecord(event) && typeof event.message === "string" ? event.message : "WebSocket error";
      finish(new Error(message));
    };
    const onClose = () => finish(new Error("WebSocket closed before it opened"));
    const onAbort = () => finish(new Error("Request was aborted"));

    try {
      // Match Pi's stock Codex transport and pi-codex-conversion: the
      // WebSocket handshake must not carry the SSE `OpenAI-Beta` value.
      const handshakeHeaders: Record<string, string> = Object.fromEntries(headers.entries());
      delete handshakeHeaders["OpenAI-Beta"];
      delete handshakeHeaders["openai-beta"];
      socket = new webSocket(url, { headers: handshakeHeaders });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

type CachedWebSocketContinuation = {
  lastRequestBody: Record<string, unknown>;
  lastResponseId: string;
  lastResponseItems: unknown[];
};

type SessionWebSocketEntry = {
  socket: WebSocketLike;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuation;
};

type AcquiredWebSocket = {
  socket: WebSocketLike;
  entry?: SessionWebSocketEntry;
  reused: boolean;
  release: (options?: { keep?: boolean }) => void;
};

const websocketSessionCache = new Map<string, Map<string, SessionWebSocketEntry>>();
const websocketSseFallbackSessions = new Set<string>();

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
  return typeof socket.readyState === "number" ? socket.readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
  const readyState = getWebSocketReadyState(socket);
  return readyState === undefined || readyState === 1;
}

function isWebSocketSessionExpired(entry: SessionWebSocketEntry): boolean {
  return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {
    // Closing an already-closed socket is harmless.
  }
}

function deleteWebSocketEntry(
  sessionId: string,
  accountId: string,
  entry: SessionWebSocketEntry,
): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  closeWebSocketSilently(entry.socket);
  const accountEntries = websocketSessionCache.get(sessionId);
  if (accountEntries?.get(accountId) === entry) accountEntries.delete(accountId);
  if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
}

function scheduleSessionWebSocketExpiry(
  sessionId: string,
  accountId: string,
  entry: SessionWebSocketEntry,
): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    deleteWebSocketEntry(sessionId, accountId, entry);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
  (entry.idleTimer as unknown as { unref?: () => void }).unref?.();
}

export function closeFastModeWebSocketSessions(sessionId?: string): void {
  if (sessionId) {
    for (const [accountId, entry] of websocketSessionCache.get(sessionId) ?? []) {
      deleteWebSocketEntry(sessionId, accountId, entry);
    }
    websocketSessionCache.delete(sessionId);
    websocketSseFallbackSessions.delete(sessionId);
    return;
  }

  for (const [cachedSessionId, accountEntries] of websocketSessionCache) {
    for (const [accountId, entry] of accountEntries) {
      deleteWebSocketEntry(cachedSessionId, accountId, entry);
    }
  }
  websocketSessionCache.clear();
  websocketSseFallbackSessions.clear();
}

registerSessionResourceCleanup(closeFastModeWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
  if (!sessionId) return;
  websocketSseFallbackSessions.add(sessionId);
  fastDebug(`ws fallback armed: ${formatError(error)}`);
}

function releaseCachedWebSocket(
  sessionId: string,
  accountId: string,
  entry: SessionWebSocketEntry,
  keep: boolean,
): void {
  if (!keep || !isWebSocketReusable(entry.socket)) {
    deleteWebSocketEntry(sessionId, accountId, entry);
    return;
  }
  entry.busy = false;
  scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  accountId: string,
  signal: AbortSignal | undefined,
  connectTimeoutMs: number,
  env?: Record<string, string>,
): Promise<AcquiredWebSocket> {
  if (!sessionId) {
    const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
    return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
  }

  let accountEntries = websocketSessionCache.get(sessionId);
  const cached = accountEntries?.get(accountId);
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && isWebSocketSessionExpired(cached)) {
      deleteWebSocketEntry(sessionId, accountId, cached);
    } else if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        reused: true,
        release: ({ keep } = {}) =>
          releaseCachedWebSocket(sessionId, accountId, cached, keep !== false),
      };
    } else if (cached.busy) {
      const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
      return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
    } else {
      deleteWebSocketEntry(sessionId, accountId, cached);
    }
  }

  const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
  const entry: SessionWebSocketEntry = { socket, busy: true, createdAt: Date.now() };
  accountEntries = websocketSessionCache.get(sessionId);
  if (!accountEntries) {
    accountEntries = new Map();
    websocketSessionCache.set(sessionId, accountEntries);
  }
  accountEntries.set(accountId, entry);
  return {
    socket,
    entry,
    reused: false,
    release: ({ keep } = {}) => releaseCachedWebSocket(sessionId, accountId, entry, keep !== false),
  };
}

function requestBodyWithoutInput(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function responseInputsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function getCachedWebSocketInputDelta(
  body: Record<string, unknown>,
  continuation: CachedWebSocketContinuation,
): unknown[] | undefined {
  if (
    JSON.stringify(requestBodyWithoutInput(body)) !==
    JSON.stringify(requestBodyWithoutInput(continuation.lastRequestBody))
  ) {
    return undefined;
  }
  const currentInput = Array.isArray(body.input) ? body.input : [];
  const previousInput = Array.isArray(continuation.lastRequestBody.input)
    ? continuation.lastRequestBody.input
    : [];
  const baseline = [...previousInput, ...continuation.lastResponseItems];
  if (currentInput.length < baseline.length) return undefined;
  if (!responseInputsEqual(currentInput.slice(0, baseline.length), baseline)) return undefined;
  return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(
  entry: SessionWebSocketEntry,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const continuation = entry.continuation;
  if (!continuation) return body;
  const delta = getCachedWebSocketInputDelta(body, continuation);
  if (!delta || !continuation.lastResponseId) {
    entry.continuation = undefined;
    return body;
  }
  return { ...body, previous_response_id: continuation.lastResponseId, input: delta };
}

function responseItemsForContinuation(
  model: CodexModel,
  output: AssistantMessage,
  grammarToolInputProperties?: ReadonlyMap<string, string>,
): unknown[] {
  return convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties,
  }).filter(
    (item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output",
  );
}

function createWebSocketEventStream(
  socket: WebSocketLike,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number | undefined,
  onFirstEvent?: () => void,
): { events: AsyncIterable<unknown>; dispose: () => void } {
  const queue: unknown[] = [];
  let failed: Error | undefined;
  let done = false;
  let waiter: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const wake = () => {
    const next = waiter;
    waiter = undefined;
    next?.();
  };
  const fail = (error: Error) => {
    failed ??= error;
    done = true;
    wake();
  };
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      fail(new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`));
      try {
        socket.close(1000, "idle_timeout");
      } catch {
        // Ignore close failures after an idle timeout.
      }
    }, idleTimeoutMs);
  };
  const onMessage = (event: unknown) => {
    void (async () => {
      try {
        if (!isRecord(event) || !("data" in event)) return;
        const text = await decodeWebSocketData(event.data);
        if (!text) return;
        const parsed: unknown = JSON.parse(text);
        if (!isRecord(parsed)) return;
        const isErrorEvent = parsed.type === "error" || parsed.type === "response.failed";
        // API errors are queued for the typed mapper without marking the stream started.
        if (!isErrorEvent) onFirstEvent?.();
        if (
          parsed.type === "response.completed" ||
          parsed.type === "response.done" ||
          parsed.type === "response.incomplete"
        ) {
          done = true;
        }
        queue.push(parsed);
        armIdleTimer();
        wake();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  };
  const onError = (event: unknown) => {
    const message =
      isRecord(event) && typeof event.message === "string" ? event.message : "WebSocket error";
    fail(new Error(message));
  };
  const onClose = (event: unknown) => {
    if (!done) {
      const reason = isRecord(event) && typeof event.reason === "string" ? event.reason : "";
      fail(new Error(reason ? `WebSocket closed: ${reason}` : "WebSocket closed"));
    } else {
      wake();
    }
  };
  const onAbort = () => fail(new Error("Request was aborted"));

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  armIdleTimer();

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    done = true;
    wake();
  };

  async function* iterate(): AsyncIterable<unknown> {
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (failed) throw failed;
        if (done) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    } finally {
      dispose();
    }
  }

  return { events: iterate(), dispose };
}

class CodexApiError extends Error {
  readonly code?: string;
  readonly payload?: unknown;

  constructor(message: string, options?: { code?: string; payload?: unknown; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexApiError";
    this.code = options?.code;
    this.payload = options?.payload;
  }
}

class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexProtocolError";
    this.payload = options?.payload;
  }
}

function isCodexNonTransportError(error: unknown): boolean {
  return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function extractCodexEventError(event: Record<string, unknown>): {
  code?: string;
  message?: string;
} {
  const nested = isRecord(event.error) ? event.error : undefined;
  return {
    code:
      typeof event.code === "string"
        ? event.code
        : typeof nested?.code === "string"
          ? nested.code
          : undefined,
    message:
      typeof event.message === "string"
        ? event.message
        : typeof nested?.message === "string"
          ? nested.message
          : undefined,
  };
}

async function* mapCodexEvents(
  events: AsyncIterable<unknown>,
  output: AssistantMessage,
): AsyncIterable<ResponseStreamEvent> {
  for await (const event of events) {
    if (!isRecord(event)) continue;
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;

    if (type === "error") {
      const { code, message } = extractCodexEventError(event);
      throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
        code,
        payload: event,
      });
    }
    if (type === "response.failed") {
      const response = isRecord(event.response) ? event.response : undefined;
      const error = response && isRecord(response.error) ? response.error : undefined;
      const code = typeof error?.code === "string" ? error.code : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      throw new CodexApiError(message || "Codex response failed", { code, payload: event });
    }
    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      const response = isRecord(event.response) ? event.response : undefined;
      if (typeof response?.end_turn === "boolean") output.endTurn = response.end_turn;
      const normalizedResponse = response
        ? {
            ...response,
            status:
              typeof response.status === "string" && CODEX_RESPONSE_STATUSES.has(response.status)
                ? response.status
                : undefined,
          }
        : response;
      yield {
        ...event,
        type: "response.completed",
        ...(normalizedResponse ? { response: normalizedResponse } : {}),
      } as unknown as ResponseStreamEvent;
      return;
    }
    yield event as unknown as ResponseStreamEvent;
  }
}

function resolveServiceTier(
  responseTier: unknown,
  requestTier: unknown,
): FastServiceTier | undefined {
  if (responseTier === "default" && (requestTier === "flex" || requestTier === "priority")) {
    return requestTier;
  }
  if (responseTier === "default" || responseTier === "flex" || responseTier === "priority")
    return responseTier;
  if (requestTier === "default" || requestTier === "flex" || requestTier === "priority")
    return requestTier;
  return undefined;
}

function applyServiceTierPricing(
  usage: AssistantMessage["usage"],
  serviceTier: FastServiceTier | undefined,
  model: CodexModel,
): void {
  if (serviceTier !== "priority") return;
  const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

async function processFastResponse(
  events: AsyncIterable<unknown>,
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: CodexModel,
  requestTier: FastServiceTier,
  grammarToolInputProperties?: ReadonlyMap<string, string>,
): Promise<void> {
  await processResponsesStream(mapCodexEvents(events, output), output, stream, model, {
    grammarToolInputProperties,
    serviceTier: requestTier,
    resolveServiceTier: (responseTier, requestedTier) =>
      resolveServiceTier(responseTier, requestedTier),
    applyServiceTierPricing: (usage, serviceTier) =>
      applyServiceTierPricing(usage, resolveServiceTier(serviceTier, requestTier), model),
  });
}

async function runSse(
  model: CodexModel,
  body: Record<string, unknown>,
  headers: Headers,
  options: FastStreamOptions,
  signal: AbortSignal | undefined,
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  grammarToolInputProperties: ReadonlyMap<string, string> | undefined,
  onStart: () => void,
): Promise<void> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is not available in this runtime");
  const bodyJson = JSON.stringify(body);
  const compressedBody = compressRequestBodyZstd(bodyJson);
  const requestHeaders = new Headers(headers);
  if (compressedBody) requestHeaders.set("content-encoding", "zstd");
  const requestBody = compressedBody ?? bodyJson;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let response: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Request was aborted");
    try {
      response = await fetcher(resolveCodexUrl(model.baseUrl), {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
        signal,
      });
      await options.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        model,
      );
      fastDebug(`sse status=${response.status} model=${model.id} attempt=${attempt + 1}`);
      if (response.ok) break;

      const errorText = await response.text();
      if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
        const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
        const delayMs =
          retryAfterDelayMs === undefined
            ? BASE_DELAY_MS * 2 ** attempt
            : validateRetryDelayMs(retryAfterDelayMs, options);
        await sleep(delayMs, signal);
        continue;
      }
      const errorResponse = new Response(errorText, {
        status: response.status,
        statusText: response.statusText,
      });
      throw await readErrorResponse(errorResponse);
    } catch (error) {
      if (signal?.aborted) throw new Error("Request was aborted", { cause: error });
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt < maxRetries &&
        !(lastError instanceof RetryDelayExceededError) &&
        !/usage limit|quota exceeded|insufficient_quota|billing/i.test(lastError.message)
      ) {
        await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
        continue;
      }
      throw lastError;
    }
  }

  if (!response?.ok) throw lastError ?? new Error("Failed after retries");
  if (!response.body) throw new Error("No response body");
  onStart();
  await processFastResponse(
    parseSse(response, signal),
    output,
    stream,
    model,
    "priority",
    grammarToolInputProperties,
  );
}

const FAST_DEBUG_MAX_BYTES = 512 * 1024;

/**
 * Redacted one-line telemetry for Codex requests through this provider.
 * Always on; logs routing decisions, transports, statuses, and error
 * messages - never headers, tokens, account ids, or bodies.
 */
export function fastDebug(message: string): void {
  try {
    if (typeof process === "undefined") return;
    const file = `${tmpdir()}/pi-codex-fast-debug.log`;
    try {
      if (statSync(file).size > FAST_DEBUG_MAX_BYTES) unlinkSync(file);
    } catch {
      // Missing file (or stat failure): append below creates it.
    }
    appendFileSync(
      file,
      `${new Date().toISOString()} pid=${typeof process === "undefined" ? "?" : process.pid} ${message}\n`,
    );
  } catch {
    // Logging must never break requests.
  }
}

export interface FastLastResult {
  at: string;
  outcome: "done" | "error" | "aborted";
  detail: string;
}

let lastFastResult: FastLastResult | undefined;

export function getLastFastResult(): FastLastResult | undefined {
  return lastFastResult;
}

export function formatLastFastResult(): string {
  const last = lastFastResult;
  if (!last) return "none yet";
  return last.outcome + " (" + last.detail + ") at " + last.at;
}

function recordFastResult(outcome: FastLastResult["outcome"], detail: string): void {
  lastFastResult = { at: new Date().toISOString(), outcome, detail: detail.slice(0, 300) };
}

/**
 * Fail fast when the socket is already closed (e.g. the server closed it
 * between `open` and listener attach so the close event was missed). The
 * caller falls back to SSE; without this the request hangs to idle timeout.
 */
export function assertWebSocketOpen(socket: WebSocketLike): void {
  if (typeof socket.readyState === "number" && socket.readyState !== 1) {
    throw new Error(`WebSocket not open (readyState=${socket.readyState})`);
  }
}
async function runWebSocket(
  model: CodexModel,
  body: Record<string, unknown>,
  headers: Headers,
  options: FastStreamOptions,
  signal: AbortSignal | undefined,
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  grammarToolInputProperties: ReadonlyMap<string, string> | undefined,
  onStart: () => void,
): Promise<void> {
  const connectTimeoutMs =
    normalizeTimeout(options.websocketConnectTimeoutMs, DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS) ?? 0;
  const cacheSessionId =
    options.cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options.sessionId);
  const accountId = headers.get("chatgpt-account-id") ?? "unknown";
  const acquired = await acquireWebSocket(
    resolveCodexWebSocketUrl(model.baseUrl),
    headers,
    cacheSessionId,
    accountId,
    signal,
    connectTimeoutMs,
    options.env,
  );
  const { socket, entry, reused, release } = acquired;
  const useCachedContext =
    options.transport === "websocket-cached" ||
    options.transport === "auto" ||
    options.transport === undefined;
  const requestBody =
    useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, body) : body;
  let keepConnection = true;
  let eventStream: ReturnType<typeof createWebSocketEventStream> | undefined;
  try {
    // A close landing between open and listener attach is otherwise missed
    // and hangs to idle timeout; fail fast so the caller can use SSE.
    assertWebSocketOpen(socket);
    fastDebug(`ws ${reused ? "reused" : "connected"}`);
    let startEmitted = false;
    eventStream = createWebSocketEventStream(
      socket,
      signal,
      normalizeTimeout(options.timeoutMs),
      () => {
        if (startEmitted) return;
        startEmitted = true;
        onStart();
        fastDebug("ws first event");
      },
    );
    socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    await processFastResponse(
      eventStream.events,
      output,
      stream,
      model,
      "priority",
      grammarToolInputProperties,
    );
    if (signal?.aborted) {
      keepConnection = false;
    } else if (useCachedContext && entry && output.responseId) {
      entry.continuation = {
        lastRequestBody: body,
        lastResponseId: output.responseId,
        lastResponseItems: responseItemsForContinuation(model, output, grammarToolInputProperties),
      };
    }
  } catch (error) {
    if (entry) entry.continuation = undefined;
    keepConnection = false;
    throw error;
  } finally {
    eventStream?.dispose();
    release({ keep: keepConnection });
  }
}

function createAssistantOutput(model: CodexModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function successfulStopReason(
  output: AssistantMessage,
): "stop" | "length" | "toolUse" | "deferred" {
  if (
    output.stopReason === "stop" ||
    output.stopReason === "length" ||
    output.stopReason === "toolUse" ||
    output.stopReason === "deferred"
  ) {
    return output.stopReason;
  }
  if (output.stopReason === "pending") throw new Error("Codex stream ended without a stop reason");
  throw new Error(output.errorMessage || "An unknown Codex error occurred");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function streamFast(
  model: CodexModel,
  context: Context,
  options: FastStreamOptions | undefined,
  settings: FastModeProviderSettings,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const output = createAssistantOutput(model);
  const verbosity = settings.getVerbosity?.() ?? "low";

  void (async () => {
    let started = false;
    let requestSignal: ReturnType<typeof createRequestSignal> | undefined;
    try {
      requestSignal = createRequestSignal(options?.signal, normalizeTimeout(options?.timeoutMs));
      fastDebug(
        `fast-stream rev=${FAST_TRANSPORT_REV} model=${model.id} transport=${options?.transport ?? "auto"} hasApiKey=${Boolean(options?.apiKey)} hasSession=${Boolean(options?.sessionId)}`,
      );
      const apiKey = options?.apiKey;
      if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
      const accountId = extractAccountId(apiKey);
      const baseBody = buildFastRequestBody(model, context, options, verbosity);
      const nextBody = await options?.onPayload?.(baseBody, model);
      const body = applyFastModePayload(nextBody === undefined ? baseBody : nextBody, verbosity);
      const grammarToolInputProperties = createGrammarToolInputProperties(
        context.tools,
        model.compat?.supportsOpenAIGrammarTools ?? false,
      );

      const requestId = clampOpenAIPromptCacheKey(options?.sessionId) || uuidv7();
      const initialHeaders = new Headers(model.headers);
      applyAdditionalHeaders(initialHeaders, options?.headers);
      const transport = options?.transport ?? "auto";
      const websocketHeaders = buildFastModeHeaders(initialHeaders, {
        accountId,
        token: apiKey,
        requestId,
        modelId: model.id,
        transport: "websocket",
        sessionId: options?.sessionId,
      });
      const sseHeaders = buildFastModeHeaders(initialHeaders, {
        accountId,
        token: apiKey,
        requestId,
        modelId: model.id,
        transport: "sse",
        sessionId: options?.sessionId ? clampOpenAIPromptCacheKey(options.sessionId) : undefined,
      });

      const cacheSessionId =
        options?.cacheRetention === "none"
          ? undefined
          : clampOpenAIPromptCacheKey(options?.sessionId);
      const websocketDisabledForSession =
        transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
      if (transport !== "sse" && !websocketDisabledForSession) {
        let websocketStarted = false;
        let retriedWebSocketConnectionLimit = false;
        let retriedMissingWebSocketContinuation = false;
        while (true) {
          websocketStarted = false;
          try {
            await runWebSocket(
              model,
              body,
              websocketHeaders,
              options ?? {},
              requestSignal.signal,
              output,
              stream,
              grammarToolInputProperties,
              () => {
                websocketStarted = true;
                if (!started) {
                  started = true;
                  stream.push({ type: "start", partial: output });
                }
              },
            );
            break;
          } catch (error) {
            const aborted = requestSignal.signal?.aborted;
            const connectionLimitBeforeStart =
              !websocketStarted && isWebSocketConnectionLimitReachedError(error);
            const previousResponseNotFound = isPreviousResponseNotFoundError(error);
            if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
              retriedMissingWebSocketContinuation = true;
              continue;
            }
            if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
              retriedWebSocketConnectionLimit = true;
              continue;
            }
            if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
              throw error;
            }
            recordWebSocketFailure(cacheSessionId, error);
            if (websocketStarted) throw error;
            fastDebug(`ws fail pre-start, falling back to SSE: ${formatError(error)}`);
            break;
          }
        }
      }

      if (!started) {
        await runSse(
          model,
          body,
          sseHeaders,
          options ?? {},
          requestSignal.signal,
          output,
          stream,
          grammarToolInputProperties,
          () => {
            started = true;
            stream.push({ type: "start", partial: output });
          },
        );
      }
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const reason = successfulStopReason(output);
      fastDebug(`fast-stream done reason=${reason}`);
      recordFastResult("done", `reason=${reason} model=${model.id}`);
      stream.push({ type: "done", reason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatError(error);
      fastDebug(`fast-stream ${output.stopReason}: ${output.errorMessage}`);
      recordFastResult(output.stopReason, output.errorMessage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      requestSignal?.cleanup();
    }
  })();

  return stream;
}

/**
 * Wrap the active Codex provider. Normal requests stay on Pi's stock adapter;
 * Fast Mode owns both request transports so the CLI identity cannot be
 * overwritten by the stock WebSocket/SSE header builders.
 */
export function createFastModeProvider(
  baseProvider: Provider,
  settings: FastModeProviderSettings,
): Provider {
  const provider: Provider = {
    ...baseProvider,
    stream(model, context, options) {
      const fast = settings.isFastMode();
      fastDebug(
        `provider stream rev=${FAST_TRANSPORT_REV} fast=${fast} provider=${model.provider} api=${model.api} model=${model.id}`,
      );
      if (!fast || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
        return baseProvider.stream(model, context, options);
      }
      return streamFast(model as CodexModel, context, options as FastStreamOptions, settings);
    },
    streamSimple(model, context, options) {
      const fast = settings.isFastMode();
      fastDebug(
        `provider streamSimple rev=${FAST_TRANSPORT_REV} fast=${fast} provider=${model.provider} api=${model.api} model=${model.id}`,
      );
      if (!fast || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
        return baseProvider.streamSimple(model, context, options);
      }
      if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
      const clampedReasoning = options.reasoning
        ? clampThinkingLevel(model, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      return streamFast(
        model as CodexModel,
        context,
        {
          ...buildBaseOptions(model, context, options, options.apiKey),
          toolChoice: options.toolChoice,
          reasoningEffort,
        },
        settings,
      );
    },
  };
  return provider;
}
