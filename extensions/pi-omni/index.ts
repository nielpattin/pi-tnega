/**
 * Omni Visual Inspection Extension
 *
 * Registers an `omni` tool and `/omni` command that read image files with a
 * hardcoded vision-capable model. Returns detailed text descriptions the
 * main model can understand.
 *
 * Hardcoded model, 30s timeout. Only "read" tool.
 */

import { getModel } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   SessionManager,
   SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const OMNI_MODEL = getModel("openai-codex", "gpt-5.4-mini");
const OMNI_TIMEOUT_MS = 30_000;

const OMNI_SYSTEM_PROMPT = [
   "You are an omni visual inspector. Your job is to look at an image and",
   "describe what you see in rich textual detail.",
   "",
   "When describing:",
   "- Start with the overall layout and structure.",
   "- Describe colors, typography, spacing, and visual hierarchy.",
   "- Note any text visible in the image (transcribe it).",
   "- Call out interactive elements: buttons, inputs, dropdowns, links.",
   "- Mention alignment issues, spacing inconsistencies, or visual bugs.",
   "- For diagrams/charts: describe axes, data trends, labels, and key values.",
   "- For code screenshots: transcribe the visible code accurately.",
   "",
   "Be thorough. Your output is consumed by another AI that cannot see images.",
   "Do NOT suggest changes. Only describe.",
].join("\n");

interface OmniResult {
   text: string;
   error?: string;
   logPath?: string;
}

function writeTranscriptLine(logPath: string, line: string) {
   appendFileSync(logPath, line + "\n", "utf-8");
}

function timeoutPromise(ms: number): Promise<never> {
   return new Promise((_, reject) => setTimeout(() => reject(new DOMException("Timed out", "TimeoutError")), ms));
}

function abortSignalPromise(signal?: AbortSignal): Promise<never> {
   return new Promise<never>((_, reject) => {
      if (signal?.aborted) {
         reject(new DOMException("Aborted", "AbortError"));
         return;
      }
      if (signal) {
         signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
         });
      }
   });
}

const OMNI_MODEL_STUB: Model<any> = OMNI_MODEL as Model<any>;

/**
 * Inspect an image. Both parent abort signal and 30s timeout cause immediate
 * return. session.abort() is called fire-and-forget.
 */
export async function runOmni(
   imagePath: string,
   cwd: string,
   options: {
      signal?: AbortSignal;
   },
): Promise<OmniResult> {
   if (options.signal?.aborted) {
      return { text: "Inspection cancelled." };
   }

   const agentDir = getAgentDir();
   const settingsManager = SettingsManager.inMemory();
   const sessionManager = SessionManager.inMemory(cwd);

   const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: OMNI_SYSTEM_PROMPT,
   });
   await resourceLoader.reload();

   // Transcript log - only when DEBUG_OMNI=1 is set.
   const debug = process.env.DEBUG_OMNI === "1";
   let logPath: string | undefined;
   if (debug) {
      const logDir = join(agentDir, "omni-logs");
      mkdirSync(logDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      logPath = join(logDir, `omni-${timestamp}.log`);
      writeFileSync(
         logPath,
         `# Omni transcript\n# File: ${imagePath}\n# Timeout: ${OMNI_TIMEOUT_MS}ms\n# Started: ${new Date().toISOString()}\n\n`,
         "utf-8",
      );
   }

   const elapsedStart = Date.now();

   const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      model: OMNI_MODEL_STUB,
      thinkingLevel: "off",
      tools: ["read"],
   });

   const unsub = debug
      ? session.subscribe((event) => {
           try {
              writeTranscriptLine(logPath!, JSON.stringify(event));
           } catch {
              // Must not throw.
           }
        })
      : () => {};

   // Also fire session.abort() when parent signal fires (in case agent loop reads it).
   let abortHandler: (() => void) | undefined;
   if (options.signal) {
      abortHandler = () => session.abort();
      options.signal.addEventListener("abort", abortHandler, { once: true });
   }

   let description = "";
   let earlyExit: "timeout" | "userAbort" | null = null;

   try {
      if (!session.model) {
         return {
            text: "",
            error: "Omni model not available. Check your auth with /auth or models with /models.",
            logPath,
         };
      }

      try {
         await Promise.race([
            session.prompt(`Read the file at "${imagePath}" and describe it in detail.`),
            timeoutPromise(OMNI_TIMEOUT_MS),
            abortSignalPromise(options.signal),
         ]);
      } catch (e) {
         if (e instanceof DOMException && e.name === "TimeoutError") {
            earlyExit = "timeout";
            if (debug) {
               writeTranscriptLine(logPath!, `{"type":"omni_timeout","elapsedMs":${Date.now() - elapsedStart}}`);
            }
            session.abort().catch(() => {});
         } else if (e instanceof DOMException && e.name === "AbortError") {
            earlyExit = "userAbort";
            session.abort().catch(() => {});
         } else {
            throw e;
         }
      }

      // Drain remaining streaming if not already killed.
      if (!earlyExit) {
         const deadline = Date.now() + 5000;
         while (session.isStreaming && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
         }
      }

      description = session.getLastAssistantText() ?? "";
   } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: "", error: `Omni error: ${message}`, logPath };
   } finally {
      if (abortHandler && options.signal) {
         options.signal.removeEventListener("abort", abortHandler);
      }
      unsub();
      session.dispose();
   }

   if (earlyExit === "userAbort") {
      const msg = description ? `Aborted. Partial:\n\n${description}` : "Aborted.";
      return { text: `File: ${imagePath}\n\n${msg}`, logPath };
   }

   if (earlyExit === "timeout") {
      const msg = description
         ? `Timed out (${OMNI_TIMEOUT_MS / 1000}s). Partial:\n\n${description}`
         : `Timed out (${OMNI_TIMEOUT_MS / 1000}s).`;
      return { text: `File: ${imagePath}\n\n${msg}`, logPath };
   }

   return { text: `File: ${imagePath}\n\n${description}`, logPath };
}

export default function omniExtension(pi: ExtensionAPI) {
   pi.registerTool({
      name: "omni",
      label: "omni",
      description:
         "Inspect an image file using a vision-capable model. " +
         "Returns a detailed text description so the main model can understand visual content.",
      promptSnippet: "Inspect an image and return a visual description",
      promptGuidelines: [
         "Use omni when you need to see images, screenshots, UI mockups, diagrams, or any visual file.",
         "Pass the exact filepath as imagePath. The agent reads the file and returns a text description.",
         "The main model cannot see images directly. Omni bridges this gap.",
      ],
      parameters: Type.Object({
         imagePath: Type.String({
            description: "Absolute or relative path to the image file to inspect",
         }),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         let dots = 0;
         const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
         const elapsed = Date.now();
         const tick = setInterval(() => {
            dots = (dots + 1) % frames.length;
            const secs = Math.floor((Date.now() - elapsed) / 1000);
            onUpdate?.({
               content: [
                  {
                     type: "text",
                     text: `${frames[dots]} Omni: inspecting ${params.imagePath} (${secs}s)`,
                  },
               ],
               details: {},
            });
         }, 120);

         const result = await runOmni(params.imagePath, ctx.cwd, { signal });

         clearInterval(tick);

         if (result.error) {
            return {
               content: [{ type: "text" as const, text: result.error }],
               details: undefined,
            };
         }

         return {
            content: [{ type: "text" as const, text: result.text }],
            details: result.logPath ? { logPath: result.logPath } : {},
         };
      },
   });

   pi.registerCommand("omni", {
      description: "Inspect an image with a vision model",
      async handler(args, ctx) {
         let imagePath: string | undefined = args.trim() || undefined;

         if (!imagePath) {
            if (!ctx.hasUI) {
               ctx.ui.notify("Usage: /omni <path to image>", "warning");
               return;
            }

            imagePath = await ctx.ui.input("Omni", "Enter the image file path to inspect:");
            if (!imagePath) return;
         }

         ctx.ui.setWorkingMessage(`Omni: inspecting ${imagePath}...`);
         ctx.ui.setWorkingVisible(true);

         try {
            const result = await runOmni(imagePath, ctx.cwd, {});

            if (result.error) {
               ctx.ui.notify(result.error, "error");
               return;
            }

            await ctx.ui.editor("Omni Inspection Results", result.text);
         } finally {
            ctx.ui.setWorkingMessage();
            ctx.ui.setWorkingVisible(false);
         }
      },
   });
}
