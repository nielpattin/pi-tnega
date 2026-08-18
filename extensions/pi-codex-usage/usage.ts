import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

type RuntimeModel = Model<Api>;

export interface CodexUsageWindow {
   usedPercent?: number;
   windowMinutes?: number;
   resetsAt?: number;
}

export interface CodexUsageLimit {
   limitId: string;
   limitName?: string;
   primary?: CodexUsageWindow;
   secondary?: CodexUsageWindow;
}

export interface CodexUsageSnapshot {
   planType?: string;
   limits: CodexUsageLimit[];
   raw: unknown;
}

/** Injectable knobs for `fetchCodexUsage`, used by tests to avoid real network calls. */
export interface CodexUsageFetchOptions {
   /** Replace the global fetch (test seam). Defaults to `fetch`. */
   fetchImpl?: typeof fetch;
   /** Delay before the single transient-failure retry, in milliseconds. */
   retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
   return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
   return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function buildCodexUsageUrl(): string {
   return `${DEFAULT_CODEX_BASE_URL}/wham/usage`;
}

function applyProviderHeaders(target: Headers, source: ProviderHeaders | undefined): void {
   for (const [key, value] of Object.entries(source ?? {})) {
      if (value === null) target.delete(key);
      else target.set(key, value);
   }
}

function extractBearerToken(headers: Headers): string | undefined {
   const authorization = headers.get("authorization")?.trim();
   const match = authorization?.match(/^Bearer\s+(.+)$/i);
   return match?.[1]?.trim();
}

function extractAccountId(token: string): string | undefined {
   try {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8")) as unknown;
      const authClaims = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
      const accountId = isRecord(authClaims) ? authClaims.chatgpt_account_id : undefined;
      return stringValue(accountId);
   } catch {
      return undefined;
   }
}

async function buildCodexUsageHeaders(ctx: ExtensionContext, model: RuntimeModel): Promise<Headers> {
   const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
   if (!auth.ok) throw new Error(auth.error);

   const headers = new Headers();
   applyProviderHeaders(headers, model.headers);
   applyProviderHeaders(headers, auth.headers);
   if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);

   const token = auth.apiKey ?? extractBearerToken(headers);
   const accountId = token ? extractAccountId(token) : undefined;
   if (accountId) headers.set("chatgpt-account-id", accountId);

   headers.set("accept", "application/json");
   headers.set("OAI-Language", "en");
   headers.set("originator", "pi");
   return headers;
}

function parseWindow(value: unknown): CodexUsageWindow | undefined {
   if (!isRecord(value)) return undefined;

   const usedPercent = numberValue(value.used_percent);
   const limitWindowSeconds = numberValue(value.limit_window_seconds);
   const windowMinutes =
      numberValue(value.window_minutes) ??
      (limitWindowSeconds === undefined ? undefined : Math.ceil(limitWindowSeconds / 60));
   const resetsAt = numberValue(value.resets_at) ?? numberValue(value.reset_at);

   return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined
      ? undefined
      : { usedPercent, windowMinutes, resetsAt };
}

function parseRateLimit(value: unknown): {
   primary?: CodexUsageWindow;
   secondary?: CodexUsageWindow;
} {
   if (!isRecord(value)) return {};

   const primary = parseWindow(value.primary_window) ?? parseWindow(value.primary);
   const secondary = parseWindow(value.secondary_window) ?? parseWindow(value.secondary);
   if (primary?.windowMinutes === WEEKLY_WINDOW_MINUTES && !secondary) return { secondary: primary };
   return { primary, secondary };
}

export function parseCodexUsagePayload(payload: unknown): CodexUsageSnapshot {
   const root = isRecord(payload) ? payload : {};
   const limits: CodexUsageLimit[] = [];

   const addLimit = (limitId: string, limitName: string | undefined, source: unknown) => {
      const rateLimit = isRecord(source) && "rate_limit" in source ? source.rate_limit : source;
      const parsed = parseRateLimit(rateLimit);
      limits.push({
         limitId,
         ...(limitName ? { limitName } : {}),
         ...(parsed.primary ? { primary: parsed.primary } : {}),
         ...(parsed.secondary ? { secondary: parsed.secondary } : {})
      });
   };

   addLimit("codex", undefined, root.rate_limit);
   if (Array.isArray(root.additional_rate_limits)) {
      for (const item of root.additional_rate_limits) {
         if (!isRecord(item)) continue;
         addLimit(stringValue(item.metered_feature) ?? "additional", stringValue(item.limit_name), item);
      }
   }

   return {
      planType: stringValue(root.plan_type),
      limits,
      raw: payload
   };
}

function findCodexModel(ctx: ExtensionContext): RuntimeModel | undefined {
   const activeModel = ctx.model;
   if (activeModel?.provider === "openai-codex") {
      const registeredActiveModel = ctx.modelRegistry.find(activeModel.provider, activeModel.id);
      return registeredActiveModel ?? activeModel;
   }

   return (
      ctx.modelRegistry.getAvailable().find((model) => model.provider === "openai-codex") ??
      ctx.modelRegistry.getAll().find((model) => model.provider === "openai-codex")
   );
}

/**
 * Format a thrown error including its cause chain, so transport-level failures
 * like `TypeError: fetch failed` reveal the underlying reason instead of hiding
 * it inside `error.cause`.
 *
 * @param error - The thrown value.
 * @returns A single-line message with the most relevant cause appended.
 */
export function formatFetchError(error: unknown): string {
   if (!(error instanceof Error)) return String(error);
   const causes: string[] = [];
   let current: Error = error;
   for (let depth = 0; depth < 5; depth++) {
      const cause = current.cause;
      if (cause === undefined || cause === current) break;
      if (cause instanceof Error) {
         causes.push(cause.message);
         current = cause;
      } else if (typeof cause === "string" && cause.trim()) {
         causes.push(cause);
         break;
      } else {
         break;
      }
   }
   if (causes.length === 0) return error.message;
   const summary = `${error.message} (${causes.join("; ")})`;
   return summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
}

function isAbortError(error: unknown): boolean {
   return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCodexUsage(
   ctx: ExtensionContext,
   options: CodexUsageFetchOptions = {}
): Promise<CodexUsageSnapshot> {
   const model = findCodexModel(ctx);
   if (!model) {
      throw new Error("No OpenAI Codex model is available. Log in with /login openai-codex first.");
   }

   const headers = await buildCodexUsageHeaders(ctx, model);
   const request = (): Promise<Response> =>
      (options.fetchImpl ?? fetch)(buildCodexUsageUrl(), {
         method: "GET",
         headers,
         ...(ctx.signal ? { signal: ctx.signal } : {})
      });

   let response: Response;
   try {
      response = await request();
   } catch (error) {
      if (isAbortError(error)) throw error;
      // Transient transport failure (TLS drop, reset connection): retry once
      // before surfacing. HTTP status errors are handled below without retry.
      await sleep(options.retryDelayMs ?? 1_000);
      try {
         response = await request();
      } catch (retryError) {
         throw new Error(formatFetchError(retryError), { cause: retryError });
      }
   }

   const text = await response.text();
   if (!response.ok) throw new Error(`Usage request failed (${response.status}): ${text || response.statusText}`);

   return parseCodexUsagePayload(JSON.parse(text));
}

function formatReset(timestampSeconds: number | undefined): string {
   if (!timestampSeconds) return "reset unknown";
   const minutes = Math.max(0, Math.round((timestampSeconds * 1000 - Date.now()) / 60_000));
   return minutes < 90 ? `resets in ~${minutes}m` : `resets ${new Date(timestampSeconds * 1000).toLocaleString()}`;
}

function formatWindow(label: string, window: CodexUsageWindow | undefined): string | undefined {
   if (!window) return undefined;
   const remainingPercent =
      window.usedPercent === undefined ? undefined : 100 - Math.max(0, Math.min(100, window.usedPercent));
   const percent = remainingPercent === undefined ? "?" : `${Math.round(remainingPercent)}%`;
   const span = window.windowMinutes ? `${Math.round(window.windowMinutes)}m` : "window";
   return `${label}: ${percent} left (${span}, ${formatReset(window.resetsAt)})`;
}

export function formatCodexUsage(snapshot: CodexUsageSnapshot): string {
   const lines = [`Codex usage${snapshot.planType ? ` (${snapshot.planType})` : ""}:`];
   for (const limit of snapshot.limits) {
      const title = limit.limitName ?? limit.limitId;
      const parts = [formatWindow("5h", limit.primary), formatWindow("weekly", limit.secondary)].filter(Boolean);
      lines.push(`- ${title}: ${parts.length ? parts.join("; ") : "no usage data"}`);
   }
   return lines.join("\n");
}
