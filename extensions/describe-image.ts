/**
 * describe-image — Vision bridge extension for Pi
 *
 * Provides a `describe_image` tool that sends images to a vision API
 * (Gemini primary, HTTP fallback) and returns text descriptions.
 *
 * Resolves images from:
 * - Filesystem paths (absolute, relative, bare filename)
 * - Session entries ("clipboard" → most recent ImageContent in user messages)
 *
 * API keys are resolved from the Pi model registry (Google provider).
 * Fallback uses SEE_IMAGE_API_KEY env var if set.
 *
 * Env vars:
 *   SEE_IMAGE_API_KEY      — HTTP fallback API key
 *   SEE_IMAGE_ENDPOINT     — HTTP fallback endpoint (default: https://opencode.ai/zen/go/v1/messages)
 *   SEE_IMAGE_MODEL        — HTTP fallback model (default: minimax-m3)
 *   DESCRIBE_IMAGE_TIMEOUT — Request timeout in ms (default: 30000)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, extname } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT = parseInt(process.env.DESCRIBE_IMAGE_TIMEOUT || "30000", 10);

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
// Vision API calls
// ---------------------------------------------------------------------------

type VisionResult = {
   text: string;
   model: string;
   provider: string;
   tokens?: { input: number; output: number };
};

async function analyzeWithGemini(
   apiKey: string,
   base64: string,
   mimeType: string,
   prompt: string,
   signal?: AbortSignal
): Promise<VisionResult> {
   const model = "gemini-3.1-flash-lite";
   const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
            contents: [
               {
                  parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }]
               }
            ]
         }),
         signal
      }
   );

   if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
   }

   const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
   };
   const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No description generated";
   const usage = data.usageMetadata;
   return {
      text,
      model,
      provider: "gemini",
      tokens: usage ? { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 } : undefined
   };
}

async function analyzeWithHttp(
   b64: string,
   mediaType: string,
   prompt: string,
   signal?: AbortSignal
): Promise<VisionResult> {
   const endpoint = process.env.SEE_IMAGE_ENDPOINT || "https://opencode.ai/zen/go/v1/messages";
   const model = process.env.SEE_IMAGE_MODEL || "minimax-m3";
   const apiVersion = process.env.SEE_IMAGE_API_VERSION || "2023-06-01";
   const userAgent = process.env.SEE_IMAGE_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

   const apiKey = process.env.SEE_IMAGE_API_KEY;
   if (!apiKey) {
      throw new Error("SEE_IMAGE_API_KEY is not set. Cannot use HTTP fallback.");
   }

   const res = await fetch(endpoint, {
      method: "POST",
      headers: {
         "x-api-key": apiKey,
         "anthropic-version": apiVersion,
         "content-type": "application/json",
         "user-agent": userAgent
      },
      body: JSON.stringify({
         model,
         max_tokens: 2048,
         messages: [
            {
               role: "user",
               content: [
                  { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
                  { type: "text", text: prompt }
               ]
            }
         ]
      }),
      signal
   });

   if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP vision call failed: HTTP ${res.status}, ${errText.slice(0, 300)}`);
   }

   const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
   const text = data?.content
      ?.map((c) => c.text)
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .join("\n")
      .trim();

   if (!text) throw new Error(`Model returned no text. Response: ${JSON.stringify(data).slice(0, 300)}`);
   return { text, model, provider: "http-fallback" };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function describeImageExtension(pi: ExtensionAPI) {
   pi.registerTool({
      name: "describe_image",
      label: "Describe Image",
      description:
         "Analyze an image using a vision API. Use for screenshots, photos, diagrams, " +
         "or any visual content. Pass filePath as an absolute path, a bare filename, " +
         "or 'clipboard' for the most recent pasted image.",
      promptSnippet: "Analyze an image using a vision API (Gemini primary, HTTP fallback)",
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

         // Resolve Gemini API key from Pi's model registry
         const googleApiKey = await ctx.modelRegistry.getApiKeyForProvider("google");

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

         try {
            // Try Gemini first
            if (googleApiKey) {
               try {
                  const result = await analyzeWithGemini(
                     googleApiKey,
                     resolved.data,
                     resolved.mimeType,
                     prompt,
                     signal
                  );
                  const tokenInfo = result.tokens ? ` | ${result.tokens.input}+${result.tokens.output} tokens` : "";
                  const meta = `[${result.provider}/${result.model}${tokenInfo}]`;
                  onUpdate?.({
                     content: [{ type: "text", text: `describe_image: ${params.filePath}` }],
                     details: { source: resolved.source, provider: result.provider, model: result.model }
                  });
                  return {
                     content: [{ type: "text", text: `${result.text}\n\n${meta}` }],
                     details: {
                        source: resolved.source,
                        provider: result.provider,
                        model: result.model,
                        tokens: result.tokens
                     }
                  };
               } catch (geminiErr) {
                  // If Gemini fails and we have a fallback, try it
                  if (!process.env.SEE_IMAGE_API_KEY) throw geminiErr;
               }
            }

            // HTTP fallback
            if (process.env.SEE_IMAGE_API_KEY) {
               const result = await analyzeWithHttp(resolved.data, resolved.mimeType, prompt, signal);
               const tokenInfo = result.tokens ? ` | ${result.tokens.input}+${result.tokens.output} tokens` : "";
               const meta = `[${result.provider}/${result.model}${tokenInfo}]`;
               onUpdate?.({
                  content: [{ type: "text", text: `describe_image: ${params.filePath}` }],
                  details: { source: resolved.source, provider: result.provider, model: result.model }
               });
               return {
                  content: [{ type: "text", text: `${result.text}\n\n${meta}` }],
                  details: {
                     source: resolved.source,
                     provider: result.provider,
                     model: result.model,
                     tokens: result.tokens
                  }
               };
            }

            throw new Error(
               "No vision API available. Configure a Google provider in Pi settings, " +
                  "or set SEE_IMAGE_API_KEY for HTTP fallback."
            );
         } finally {
            clearInterval(heartbeat);
         }
      },

      renderCall(args, theme) {
         const path = (args as { filePath?: string }).filePath ?? "";
         const text = theme.fg("toolTitle", theme.bold("describe_image ")) + theme.fg("accent", path);
         return new Text(text, 0, 0);
      }
   });
}
