/**
 * describe-image — Vision bridge extension for Pi
 *
 * Provides a `describe_image` tool that sends images to a vision-capable model
 * resolved through Pi's model registry and returns text descriptions.
 *
 * Models are driven entirely by settings.json (no hardcoded endpoints). The
 * extension resolves a primary model and a fallback model, both as
 * "provider/modelId" strings, runs the call via pi-ai's `completeSimple`
 * (which uses each model's `api` field to pick the wire format), and uses the
 * registry for auth (API keys, OAuth subscriptions, command-backed keys).
 *
 * settings.json:
 *   "describeImage": {
 *     "model": "google/gemini-3.1-flash-lite",              // primary
 *     "fallbackModel": "xiaomi-token-plan-sgp/mimo-v2.5",   // fallback
 *     "timeout": 30000                                      // request timeout in ms
 *   }
 *
 * Defaults (applied when a key is absent):
 *   model          → google/gemini-3.1-flash-lite
 *   fallbackModel  → xiaomi-token-plan-sgp/mimo-v2.5
 *   timeout        → 30000
 *
 * Set a key to "" to disable that model. At least one of {model, fallbackModel}
 * must resolve to a registered, image-capable model with auth configured. If
 * neither is usable, the extension logs an error at session start.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, extname } from "node:path";

// ---------------------------------------------------------------------------
// Config (settings.json)
// ---------------------------------------------------------------------------

interface DescribeImageConfig {
   /** "provider/modelId", or "" to disable the primary model. */
   model: string;
   /** "provider/modelId", or "" to disable the fallback model. */
   fallbackModel: string;
   /** Request timeout in ms. */
   timeout: number;
}

const DEFAULT_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_FALLBACK_MODEL = "xiaomi-token-plan-sgp/mimo-v2.5";
const DEFAULT_TIMEOUT = 30000;

function agentDir(): string {
   return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function settingsFilePath(): string {
   return join(agentDir(), "settings.json");
}

function loadDescribeImageConfig(): DescribeImageConfig {
   const config: DescribeImageConfig = {
      model: DEFAULT_MODEL,
      fallbackModel: DEFAULT_FALLBACK_MODEL,
      timeout: DEFAULT_TIMEOUT
   };

   const path = settingsFilePath();
   if (!existsSync(path)) return config;

   try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return config;
      const cfg = (parsed as { describeImage?: unknown }).describeImage;
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return config;
      const c = cfg as {
         model?: unknown;
         fallbackModel?: unknown;
         timeout?: unknown;
      };
      // Absent → default. Present string (incl. "") → use as-is ("" disables).
      if (typeof c.model === "string") config.model = c.model;
      if (typeof c.fallbackModel === "string") config.fallbackModel = c.fallbackModel;
      if (typeof c.timeout === "number" && Number.isFinite(c.timeout) && c.timeout > 0) {
         config.timeout = c.timeout;
      }
   } catch {
      // ignore malformed settings.json; keep defaults
   }

   return config;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_FRAMES = ["░", "▒", "▓", "█", "▓", "▒", "░"];

function heartbeatBar(tick: number, width = 12): string {
   let s = "";
   for (let i = 0; i < width; i++) {
      s += HEARTBEAT_FRAMES[(i + tick) % HEARTBEAT_FRAMES.length];
   }
   return s;
}

const mimeMap: Record<string, string> = {
   png: "image/png",
   jpg: "image/jpeg",
   jpeg: "image/jpeg",
   gif: "image/gif",
   webp: "image/webp",
   bmp: "image/bmp"
};

type ResolvedImage = {
   data: string; // base64
   mimeType: string;
   source: string; // display label
};

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

function resolveFromFilesystem(name: string, cwd: string): ResolvedImage | null {
   let absPath: string | null = null;

   if (name.startsWith("~")) {
      name = join(homedir(), name.slice(1));
   }

   if (isAbsolute(name) && existsSync(name)) {
      absPath = name;
   } else {
      const resolved = resolve(cwd, name);
      if (existsSync(resolved)) absPath = resolved;
   }

   if (!absPath || !existsSync(absPath)) return null;

   const ext = extname(absPath).slice(1).toLowerCase();
   const mimeType = mimeMap[ext];
   if (!mimeType) return null; // not an image

   const buf = readFileSync(absPath);
   return {
      data: buf.toString("base64"),
      mimeType,
      source: absPath
   };
}

function resolveFromSession(ctx: ExtensionContext): ResolvedImage | null {
   const entries = ctx.sessionManager.getEntries();
   // Walk backwards to find the most recent user message with a clipboard image
   for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      const msg = (entry as { message: unknown }).message;
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      if (m.role !== "user") continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
         if (!part || typeof part !== "object") continue;
         const p = part as Record<string, unknown>;

         // Case 1: Pi stores clipboard images as temp file paths in text content
         if (p.type === "text" && typeof p.text === "string") {
            const text = p.text.trim();
            // Match clipboard temp paths like pi-clipboard-*.png
            if (text.includes("pi-clipboard-") && existsSync(text)) {
               const ext = extname(text).slice(1).toLowerCase();
               const mimeType = mimeMap[ext];
               if (mimeType) {
                  const buf = readFileSync(text);
                  return { data: buf.toString("base64"), mimeType, source: text };
               }
            }
         }

         // Case 2: Native ImageContent (base64 inline)
         if (p.type === "image") {
            const img = p as unknown as ImageContent;
            if (img.data && img.mimeType) {
               return { data: img.data, mimeType: img.mimeType, source: "session-clipboard" };
            }
         }
      }
   }
   return null;
}

function resolveImage(name: string, ctx: ExtensionContext): ResolvedImage {
   // "clipboard" or empty → scan session for most recent image
   if (!name || name === "clipboard") {
      const fromSession = resolveFromSession(ctx);
      if (fromSession) return fromSession;
      throw new Error(`describe_image: no image found in session. Paste an image first, or provide a file path.`);
   }

   const fromFs = resolveFromFilesystem(name, ctx.cwd);
   if (fromFs) return fromFs;

   throw new Error(`describe_image: could not find image "${name}". Pass an absolute path or paste an image first.`);
}

// ---------------------------------------------------------------------------
// Model resolution + vision call
// ---------------------------------------------------------------------------

type VisionResult = {
   text: string;
   model: string;
   provider: string;
   tokens?: { input: number; output: number };
};

type ModelCheck = { ok: true; model: Model<Api> } | { ok: false; reason: string };

/** Split "provider/modelId" on the first slash (modelIds may contain slashes). */
function parseModelRef(ref: string): { provider: string; modelId: string } | null {
   const idx = ref.indexOf("/");
   if (idx <= 0) return null;
   const provider = ref.slice(0, idx);
   const modelId = ref.slice(idx + 1);
   if (!provider || !modelId) return null;
   return { provider, modelId };
}

/**
 * Cheap, sync usability check: model exists, supports image input, and has auth
 * configured (does not refresh OAuth tokens). Safe to call at startup.
 */
function checkModel(ref: string, registry: ExtensionContext["modelRegistry"]): ModelCheck {
   if (!ref.trim()) return { ok: false, reason: "not configured (empty)" };
   const parsed = parseModelRef(ref);
   if (!parsed) return { ok: false, reason: `invalid "provider/modelId" ref "${ref}"` };
   const model = registry.find(parsed.provider, parsed.modelId);
   if (!model) return { ok: false, reason: `model "${ref}" not found in registry` };
   if (!model.input || !model.input.includes("image")) {
      return { ok: false, reason: `model "${ref}" does not support image input` };
   }
   if (!registry.hasConfiguredAuth(model)) {
      return { ok: false, reason: `no auth configured for "${ref}"` };
   }
   return { ok: true, model };
}

async function analyzeWithModel(
   model: Model<Api>,
   registry: ExtensionContext["modelRegistry"],
   base64: string,
   mimeType: string,
   prompt: string,
   signal: AbortSignal,
   timeoutMs: number
): Promise<VisionResult> {
   const auth = await registry.getApiKeyAndHeaders(model);
   if (!auth.ok) {
      throw new Error(`auth resolution failed: ${auth.error}`);
   }

   const result = await completeSimple(
      model,
      {
         messages: [
            {
               role: "user",
               content: [
                  { type: "image", data: base64, mimeType },
                  { type: "text", text: prompt }
               ],
               timestamp: Date.now()
            }
         ]
      },
      {
         apiKey: auth.apiKey,
         headers: auth.headers,
         signal,
         timeoutMs,
         maxTokens: 2048
      }
   );

   if (result.errorMessage) {
      throw new Error(`vision call failed (${result.stopReason}): ${result.errorMessage}`);
   }

   const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

   if (!text) throw new Error("model returned no text");

   return {
      text,
      model: result.responseModel ?? result.model,
      provider: String(result.provider),
      tokens: { input: result.usage.input, output: result.usage.output }
   };
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

let startupChecked = false;

function validateAtStartup(ctx: ExtensionContext): void {
   if (startupChecked) return;
   startupChecked = true;

   const config = loadDescribeImageConfig();
   const primary = checkModel(config.model, ctx.modelRegistry);
   const fallback = checkModel(config.fallbackModel, ctx.modelRegistry);

   if (primary.ok || fallback.ok) return;

   const msg =
      `[describe-image] No usable vision model configured. ` +
      `Set "describeImage.model" (and optionally "describeImage.fallbackModel") ` +
      `in settings.json to a "provider/modelId" that supports image input and has auth. ` +
      `Primary "${config.model}": ${primary.reason}. ` +
      `Fallback "${config.fallbackModel}": ${fallback.reason}.`;
   console.error(msg);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function describeImageExtension(pi: ExtensionAPI) {
   pi.on("session_start", (_event, ctx) => {
      validateAtStartup(ctx);
   });

   pi.registerTool({
      name: "describe_image",
      label: "Describe Image",
      description:
         "Analyze an image using a vision API. Use for screenshots, photos, diagrams, " +
         "or any visual content. Pass filePath as an absolute path, a bare filename, " +
         "or 'clipboard' for the most recent pasted image.",
      promptSnippet: "Analyze an image using a vision model resolved from Pi's model registry",
      promptGuidelines: [
         "Use describe_image when the user asks to describe, analyze, or interpret an image.",
         "For clipboard pastes, use filePath='clipboard' — the tool finds the most recent image automatically.",
         "Do NOT use describe_image for text files — use read instead.",
         "If your model supports images natively, you can use read on image files directly."
      ],
      parameters: Type.Object({
         filePath: Type.String({
            description:
               "Path to the image file. Absolute path, a bare filename like 'Screenshot.png', " +
               "or the literal string 'clipboard' for pasted images."
         }),
         prompt: Type.Optional(
            Type.String({
               description:
                  "Question about the image. Defaults to 'Describe this image in detail'. " +
                  "Tailor it to the situation for much better results."
            })
         )
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         // Guard: if the model has native vision, redirect to read tool
         if (ctx.model?.input?.includes("image")) {
            return {
               content: [
                  {
                     type: "text",
                     text: `This model supports native image input. Use the 'read' tool directly on the image file instead of describe_image. The model can see and analyze images natively.`
                  }
               ],
               details: { nativeVision: true }
            };
         }

         const resolved = resolveImage(params.filePath ?? "", ctx);

         const prompt = params.prompt?.trim()
            ? params.prompt
            : "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely.";

         const config = loadDescribeImageConfig();

         // Combine the caller's signal with a timeout-derived abort
         const timeoutController = new AbortController();
         const timeoutTimer = setTimeout(() => timeoutController.abort(), config.timeout);
         const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

         // Resolve which models are usable (cheap sync check), then try in order.
         const primaryCheck = checkModel(config.model, ctx.modelRegistry);
         const fallbackCheck = checkModel(config.fallbackModel, ctx.modelRegistry);

         const attempts: { label: string; model: Model<Api> }[] = [];
         const primaryReason = primaryCheck.ok ? "" : primaryCheck.reason;
         const fallbackReason = fallbackCheck.ok ? "" : fallbackCheck.reason;
         if (primaryCheck.ok) attempts.push({ label: config.model, model: primaryCheck.model });
         if (fallbackCheck.ok) attempts.push({ label: config.fallbackModel, model: fallbackCheck.model });

         if (attempts.length === 0) {
            clearTimeout(timeoutTimer);
            throw new Error(
               `describe_image: no usable vision model. ` +
                  `Primary "${config.model}": ${primaryReason}. ` +
                  `Fallback "${config.fallbackModel}": ${fallbackReason}. ` +
                  `Configure "describeImage.model" / "describeImage.fallbackModel" in settings.json.`
            );
         }

         const started = Date.now();
         let tick = 0;
         const render = () => {
            const secs = Math.round((Date.now() - started) / 1000);
            onUpdate?.({
               content: [{ type: "text", text: `describe_image ${heartbeatBar(++tick)} ${secs}s` }],
               details: { working: true, elapsedSeconds: secs }
            });
         };
         render();
         const heartbeat = setInterval(render, 500);

         async function tryAttempts(remaining: typeof attempts): Promise<ReturnType<typeof analyzeWithModel>> {
            const attempt = remaining[0];
            if (!attempt) {
               throw new Error("describe_image: all vision models failed");
            }
            try {
               return await analyzeWithModel(
                  attempt.model,
                  ctx.modelRegistry,
                  resolved.data,
                  resolved.mimeType,
                  prompt,
                  combinedSignal,
                  config.timeout
               );
            } catch (err) {
               if (remaining.length === 1) {
                  throw err instanceof Error ? err : new Error(String(err));
               }
               return tryAttempts(remaining.slice(1));
            }
         }

         try {
            const result = await tryAttempts(attempts);
            const tokenInfo = result.tokens ? ` | ${result.tokens.input}+${result.tokens.output} tokens` : "";
            const meta = `[${result.provider}/${result.model}${tokenInfo}]`;
            onUpdate?.({
               content: [{ type: "text", text: `describe_image: ${params.filePath}` }],
               details: {
                  source: resolved.source,
                  provider: result.provider,
                  model: result.model,
                  via: attempts[0]?.label ?? ""
               }
            });
            return {
               content: [{ type: "text", text: `${result.text}\n\n${meta}` }],
               details: {
                  source: resolved.source,
                  provider: result.provider,
                  model: result.model,
                  via: attempts[0]?.label ?? "",
                  tokens: result.tokens
               }
            };
         } finally {
            clearInterval(heartbeat);
            clearTimeout(timeoutTimer);
         }
      },

      renderCall(args, theme) {
         const path = (args as { filePath?: string }).filePath ?? "";
         const text = theme.fg("toolTitle", theme.bold("describe_image ")) + theme.fg("accent", path);
         return new Text(text, 0, 0);
      }
   });
}
