/**
 * Explorer Sub-Agent Extension
 *
 * Registers an `explore_codebase` tool and `/explore` command that spawn a
 * lightweight, stateless background agent session restricted to read-only
 * tools (read, grep, find, ls). The background session uses in-memory
 * persistence and loads no extensions to prevent recursion.
 */

import { getModel } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   keyHint,
   SessionManager,
   SettingsManager
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXPLORER_TOOLS = ["read", "grep", "find", "ls"] as const;
const EXPLORER_MODEL = getModel("opencode-go", "deepseek-v4-flash");
const EXPLORER_MODEL_STUB: Model<any> = EXPLORER_MODEL as Model<any>;

const EXPLORER_SYSTEM_PROMPT = [
   "You are a codebase explorer. Your job is to scan and analyze the project to gather context for the main agent.",
   "You have access to read-only tools: read, grep, find, ls.",
   "Do NOT attempt to modify any files. Do NOT suggest code changes as fixes. Only report findings and verification steps.",
   "Your output helps the main agent verify quickly. Do not sound like a final diagnosis.",
   'When diagnosing issues, describe the most likely cause, needs verification. Do not use phrases like "Primary Root Cause" unless runtime evidence proves it.',
   "Separate observed file:line evidence from interpretation. Evidence must be concrete facts from reads/searches; interpretation must include confidence.",
   "Rank findings as primary, secondary, or speculative. Keep direct causes above secondary or speculative contributors.",
   "Be concise: collapse low-value context such as large call-site dumps, unrelated matches, and broad backend context unless it directly answers the prompt.",
   "Always state Not verified / limits. Read-only analysis cannot reproduce browser timing, measure latency, or confirm runtime behavior.",
   "Always end with Recommended next checks: exact reads, searches, or commands the main agent should run to confirm or falsify the interpretation.",
   "Use this final answer template: Summary; Evidence observed; Interpretation + confidence; Primary / secondary / speculative ranking; Not verified / limits; Recommended next checks."
].join("\n");

interface ExploreResult {
   text: string;
   toolsExecuted: number;
   error?: string;
}

export async function runExplorer(
   prompt: string,
   cwd: string,
   options: {
      signal?: AbortSignal;
      onToolStart?: (toolName: string, args?: unknown) => void;
      onFindings?: (findings: string[]) => void;
   }
): Promise<ExploreResult> {
   // Early return if parent signal already aborted.
   if (options.signal?.aborted) {
      return { text: "Exploration cancelled.", toolsExecuted: 0 };
   }

   let toolsExecuted = 0;

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
      systemPrompt: EXPLORER_SYSTEM_PROMPT
   });
   await resourceLoader.reload();

   // Abort controller for the background session.
   const ac = new AbortController();

   // Wire parent signal: call session.abort() immediately.
   let abortHandler: (() => void) | undefined;
   if (options.signal) {
      abortHandler = () => {
         ac.abort();
         session.abort();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
   }

   const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      model: EXPLORER_MODEL_STUB,
      thinkingLevel: "high",
      tools: [...EXPLORER_TOOLS]
   });

   // Subscribe to events for progress reporting and findings extraction.
   const toolArgs = new Map<string, unknown>();
   const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
         toolsExecuted++;
         options.onToolStart?.(event.toolName, event.args);
         toolArgs.set(event.toolCallId, event.args);
      }

      if (event.type === "tool_execution_end" && !event.isError) {
         const args = toolArgs.get(event.toolCallId);
         toolArgs.delete(event.toolCallId);

         const paths: string[] = [];

         // 1. Extract from result content.
         const content = event.result?.content;
         if (Array.isArray(content)) {
            for (const item of content) {
               if (item.type === "text" && item.text) {
                  const lines = item.text.split("\n").filter(Boolean);
                  for (const line of lines) {
                     // grep: "path/to/file.ext:line:content"
                     const grepMatch = line.match(/^([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+):/);
                     if (grepMatch) {
                        paths.push(grepMatch[1]);
                        continue;
                     }
                     // ls/find result: standalone path-ish token
                     const trimmed = line.trim();
                     if (/^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(trimmed)) {
                        paths.push(trimmed);
                     }
                  }
               }
            }
         }

         // 2. read tool always has path in args.
         if (args && typeof args === "object") {
            const argPath = (args as Record<string, unknown>)["path"];
            if (typeof argPath === "string" && argPath.length > 0) {
               paths.push(argPath);
            }
         }

         if (paths.length > 0) {
            options.onFindings?.(paths);
         }
      }
   });

   const abortPromise = new Promise<never>((_, reject) => {
      if (options.signal) {
         if (options.signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
         }
         const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
         options.signal.addEventListener("abort", onAbort, { once: true });
      }
   });

   try {
      if (!session.model) {
         return {
            text: "",
            toolsExecuted: 0,
            error: "No model configured. Set a model with /model or in settings before using the explorer."
         };
      }

      await Promise.race([session.prompt(prompt), abortPromise]);

      // Wait for the agent to finish (it may still be streaming after prompt returns).
      const deadline = Date.now() + 300_000;
      while (session.isStreaming && Date.now() < deadline) {
         if (ac.signal.aborted) {
            await session.abort();
            break;
         }
         await new Promise((r) => setTimeout(r, 200));
      }

      const text = session.getLastAssistantText();

      return { text: text ?? "", toolsExecuted };
   } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: "", toolsExecuted, error: `Explorer error: ${message}` };
   } finally {
      if (abortHandler && options.signal) {
         options.signal.removeEventListener("abort", abortHandler);
      }
      unsubscribe();
      session.dispose();
   }
}

export default function exploreSubagentExtension(pi: ExtensionAPI) {
   // Register the LLM-callable tool.
   pi.registerTool({
      name: "explore_codebase",
      label: "explore codebase",
      description:
         "Scan the codebase using a lightweight background agent with read-only tools " +
         "(read, grep, find, ls). Use this to gather project context, find patterns, " +
         "locate files, or answer structural questions without consuming main context. " +
         "The explorer runs in isolation and returns findings back to the main session.",
      promptSnippet: "Spawn a read-only background explorer to scan the codebase and return findings",
      promptGuidelines: [
         "Use explore_codebase when you need broad codebase context (project structure, dependency analysis, pattern searches) without polluting the main conversation context.",
         "The explorer cannot modify files or run commands. It only reads."
      ],
      parameters: Type.Object({
         prompt: Type.String({
            description: "Instructions for what the explorer should scan or find in the codebase"
         })
      }),

      renderResult(result, { expanded, isPartial }, theme) {
         const text = result.content.find((item) => item.type === "text")?.text ?? "";

         if (isPartial) {
            return new Text(theme.fg("toolOutput", text), 0, 0);
         }

         if (expanded) {
            return new Text(theme.fg("toolOutput", text), 0, 0);
         }

         const details = result.details as { toolsExecuted?: number } | undefined;
         const toolCount = typeof details?.toolsExecuted === "number" ? details.toolsExecuted : 0;
         const toolLabel = toolCount === 1 ? "tool" : "tools";
         const summary = `Explorer finished (${toolCount} ${toolLabel}). ${keyHint("app.tools.expand", "to expand")}`;
         return new Text(theme.fg("muted", summary), 0, 0);
      },

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         const elapsed = Date.now();
         const doneLines: string[] = [];
         let activeLine = "";
         const spinners = ["\u25D0", "\u25D1", "\u25D2", "\u25D3"];

         // onToolStart: capture active tool call + args for display.
         const onToolStart = (toolName: string, args?: unknown) => {
            let label = toolName;
            if (args && typeof args === "object") {
               const a = args as Record<string, unknown>;
               const target = a["path"] || a["pattern"] || a["dir"] || a["file"];
               if (typeof target === "string") label = toolName + ": " + target;
               else if (typeof target === "number") label = toolName + ": " + target;
            }
            if (typeof args === "string" && args.length > 0 && args.length < 60) {
               label = toolName + ": " + args;
            }
            if (activeLine) doneLines.push("  \u2713 " + activeLine);
            activeLine = label;
         };

         // Run and wait for result.
         let count = 0;
         const tick = setInterval(() => {
            const secs = Math.floor((Date.now() - elapsed) / 1000);
            const past = doneLines.slice(-4).join("\n");
            const spinner = spinners[count++ % spinners.length];
            const active = activeLine ? spinner + " " + activeLine : "";
            const lines = [past, active, "  [" + secs + "s]"].filter(Boolean).join("\n");
            onUpdate?.({ content: [{ type: "text", text: lines }], details: {} });
         }, 200);

         const result = await runExplorer(params.prompt, ctx.cwd, {
            signal,
            onToolStart
         });

         clearInterval(tick);

         if (activeLine) doneLines.push("  \u2713 " + activeLine);

         const secs = Math.floor((Date.now() - elapsed) / 1000);
         const text = doneLines.slice(-8).join("\n") + "\n  [" + secs + "s]";
         onUpdate?.({ content: [{ type: "text", text }], details: {} });

         if (result.error) {
            return {
               content: [{ type: "text" as const, text: result.error }],
               details: undefined
            };
         }

         return {
            content: [{ type: "text" as const, text: result.text }],
            details: { toolsExecuted: result.toolsExecuted }
         };
      }
   });

   // Register the /explore slash command.
   pi.registerCommand("explore", {
      description: "Explore the codebase with a background read-only agent",
      async handler(args, ctx) {
         let prompt = args.trim();

         if (!prompt) {
            if (!ctx.hasUI) {
               ctx.ui.notify("Usage: /explore <query>", "warning");
               return;
            }

            const choice = await ctx.ui.select("Explore Codebase", [
               "Find all TODOs and FIXMEs",
               "Summarize project structure",
               "Analyze dependencies",
               "Custom query..."
            ]);

            if (!choice) return;

            if (choice === "Custom query...") {
               const custom = await ctx.ui.input("Explore", "What should the explorer look for?");
               if (!custom) return;
               prompt = custom;
            } else {
               prompt = choice;
            }
         }

         ctx.ui.setWorkingMessage("Explorer is scanning...");
         ctx.ui.setWorkingVisible(true);

         try {
            const result = await runExplorer(prompt, ctx.cwd, {
               onToolStart(toolName) {
                  ctx.ui.setWorkingMessage(`Explorer: running ${toolName}...`);
               }
            });

            if (result.error) {
               ctx.ui.notify(result.error, "error");
               return;
            }

            await ctx.ui.editor("Explorer Results", result.text);
         } finally {
            ctx.ui.setWorkingMessage();
            ctx.ui.setWorkingVisible(false);
         }
      }
   });
}
