/**
 * Explorer Sub-Agent Extension
 *
 * Registers an `explore_codebase` tool and `/explore` command that spawn a
 * lightweight, stateless background agent session restricted to read-only
 * tools (read, grep, find, ls). The background session uses in-memory
 * persistence and loads no extensions to prevent recursion.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   ModelRegistry,
   SessionManager,
   SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXPLORER_TOOLS = ["read", "grep", "find", "ls"] as const;

const EXPLORER_SYSTEM_PROMPT = [
   "You are a codebase explorer. Your job is to scan and analyze the project to gather context.",
   "You have access to read-only tools: read, grep, find, ls.",
   "Be thorough but efficient. Focus on answering the user's question accurately.",
   "Do NOT attempt to modify any files. Do NOT suggest changes. Only report findings.",
   "Keep your final answer concise and well-structured.",
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
      onToolStart?: (toolName: string) => void;
      model?: Model<any>;
      modelRegistry?: ModelRegistry;
      thinkingLevel?: ThinkingLevel;
   },
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
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
   });
   await resourceLoader.reload();

   // Abort controller for the background session. Links to parent signal if provided.
   const ac = new AbortController();
   if (options.signal) {
      options.signal.addEventListener("abort", () => ac.abort(), { once: true });
   }

   const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      model: options.model,
      modelRegistry: options.modelRegistry,
      thinkingLevel: options.thinkingLevel,
      tools: [...EXPLORER_TOOLS],
   });

   // Subscribe to events for progress reporting.
   const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
         toolsExecuted++;
         options.onToolStart?.(event.toolName);
      }
   });

   try {
      if (!session.model) {
         return {
            text: "",
            toolsExecuted: 0,
            error: "No model configured. Set a model with /model or in settings before using the explorer.",
         };
      }

      await session.prompt(prompt);

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
         "The explorer cannot modify files or run commands. It only reads.",
      ],
      parameters: Type.Object({
         prompt: Type.String({
            description: "Instructions for what the explorer should scan or find in the codebase",
         }),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         onUpdate?.({ content: [{ type: "text", text: "Explorer is scanning..." }], details: {} });

         const result = await runExplorer(params.prompt, ctx.cwd, {
            signal,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            thinkingLevel: pi.getThinkingLevel(),
            onToolStart(toolName) {
               onUpdate?.({ content: [{ type: "text", text: `Explorer: running ${toolName}...` }], details: {} });
            },
         });

         if (result.error) {
            return {
               content: [{ type: "text" as const, text: result.error }],
               details: undefined,
            };
         }

         return {
            content: [{ type: "text" as const, text: result.text }],
            details: { toolsExecuted: result.toolsExecuted },
         };
      },
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
               "Custom query...",
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
               model: ctx.model,
               modelRegistry: ctx.modelRegistry,
               thinkingLevel: pi.getThinkingLevel(),
               onToolStart(toolName) {
                  ctx.ui.setWorkingMessage(`Explorer: running ${toolName}...`);
               },
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
      },
   });
}
