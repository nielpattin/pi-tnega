import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchCodexUsage, formatCodexUsage } from "./usage";
import { openCodexUsageScreen } from "./usage-screen";
import { openCodexSettingsScreen } from "./settings-screen";
import {
   applyCodexRequestOptions,
   CODEX_VERBOSITY_LEVELS,
   loadCodexUsageConfig,
   normalizeCodexVerbosity,
   saveCodexUsageConfig,
   type CodexUsageConfig,
   type CodexVerbosity
} from "./config";

const CODEX_USAGE_COMMAND_USAGE =
   "Usage: /codex-usage [settings|fast [on|off]|low|medium|high|verbosity [low|medium|high]]";

/** Register the standalone `/codex-usage` command and screens. */
export default async function codexUsageExtension(pi: ExtensionAPI): Promise<void> {
   let config = await loadCodexUsageConfig();

   pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model?.provider !== "openai-codex") return undefined;
      return applyCodexRequestOptions(event.payload, config);
   });

   const applyConfig = async (next: CodexUsageConfig): Promise<void> => {
      config = next;
      await saveCodexUsageConfig(next);
   };

   const setVerbosity = async (nextVerbosity: CodexVerbosity, ctx: ExtensionCommandContext): Promise<void> => {
      try {
         await applyConfig({ ...config, verbosity: nextVerbosity });
         ctx.ui.notify(`Codex verbosity set to ${nextVerbosity}.`, "info");
      } catch (error) {
         ctx.ui.notify(
            `Could not save Codex verbosity: ${error instanceof Error ? error.message : String(error)}`,
            "error"
         );
      }
   };

   const setFastMode = async (fast: boolean, ctx: ExtensionCommandContext): Promise<void> => {
      try {
         await applyConfig({ ...config, fast });
         ctx.ui.notify(`Codex fast mode ${fast ? "enabled" : "disabled"}.`, "info");
      } catch (error) {
         ctx.ui.notify(
            `Could not save Codex fast mode: ${error instanceof Error ? error.message : String(error)}`,
            "error"
         );
      }
   };

   const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
      await openCodexSettingsScreen(ctx, config, (next) => {
         config = next;
      });
   };

   pi.registerCommand("codex-usage", {
      description: "Show Codex usage or set response options (verbosity, fast mode)",
      getArgumentCompletions: (prefix) => {
         const normalizedPrefix = prefix.toLowerCase();
         const verbosityPrefix = normalizedPrefix.startsWith("verbosity ");
         const query = (verbosityPrefix ? normalizedPrefix.slice("verbosity ".length) : normalizedPrefix).trim();
         const options = verbosityPrefix
            ? CODEX_VERBOSITY_LEVELS
            : ["settings", "fast", "low", "medium", "high", "verbosity"];
         const matches = options
            .filter((option) => !query || option.startsWith(query))
            .map((value) => ({ value, label: value }));
         return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx) => {
         const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
         if (tokens.length > 0) {
            if (tokens[0] === "settings") {
               if (tokens.length > 1) {
                  ctx.ui.notify(CODEX_USAGE_COMMAND_USAGE, "warning");
                  return;
               }
               if (ctx.hasUI && ctx.mode === "tui") {
                  await openSettings(ctx);
                  return;
               }
               ctx.ui.notify(
                  `Codex settings: fast mode ${config.fast ? "on" : "off"}, verbosity ${config.verbosity}.`,
                  "info"
               );
               return;
            }

            if (tokens[0] === "fast") {
               if (tokens.length > 2) {
                  ctx.ui.notify(CODEX_USAGE_COMMAND_USAGE, "warning");
                  return;
               }
               let fast: boolean;
               if (tokens[1] === "on" || tokens[1] === "off") {
                  fast = tokens[1] === "on";
               } else if (!tokens[1]) {
                  fast = !config.fast;
               } else {
                  ctx.ui.notify(CODEX_USAGE_COMMAND_USAGE, "warning");
                  return;
               }
               await setFastMode(fast, ctx);
               return;
            }

            const isVerbosityCommand = tokens[0] === "verbosity";
            if ((!isVerbosityCommand && tokens.length > 1) || tokens.length > 2) {
               ctx.ui.notify(CODEX_USAGE_COMMAND_USAGE, "warning");
               return;
            }

            let requestedVerbosity = isVerbosityCommand ? tokens[1] : tokens[0];
            if (isVerbosityCommand && !requestedVerbosity) {
               if (!ctx.hasUI) {
                  ctx.ui.notify(`Current Codex verbosity: ${config.verbosity}. ${CODEX_USAGE_COMMAND_USAGE}`, "info");
                  return;
               }
               const selectedVerbosity = await ctx.ui.select("Codex response verbosity", [...CODEX_VERBOSITY_LEVELS]);
               if (!selectedVerbosity) return;
               requestedVerbosity = selectedVerbosity;
            }

            const nextVerbosity = normalizeCodexVerbosity(requestedVerbosity);
            if (!nextVerbosity) {
               ctx.ui.notify(CODEX_USAGE_COMMAND_USAGE, "warning");
               return;
            }
            await setVerbosity(nextVerbosity, ctx);
            return;
         }

         if (ctx.hasUI && ctx.mode === "tui") {
            const action = await openCodexUsageScreen(ctx);
            if (action === "settings") await openSettings(ctx);
            return;
         }

         try {
            ctx.ui.notify(
               `${formatCodexUsage(await fetchCodexUsage(ctx))}\nFast mode: ${config.fast ? "on" : "off"}\nVerbosity: ${config.verbosity}`,
               "info"
            );
         } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
         }
      }
   });
}
