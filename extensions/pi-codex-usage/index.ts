import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchCodexUsage, formatCodexUsage } from "./usage";
import { openCodexUsageScreen } from "./usage-screen";
import {
   applyCodexVerbosity,
   CODEX_VERBOSITY_LEVELS,
   loadCodexVerbosity,
   normalizeCodexVerbosity,
   saveCodexVerbosity,
   type CodexVerbosity
} from "./verbosity";

const CODEX_USAGE_COMMAND_USAGE = "Usage: /codex-usage [low|medium|high|verbosity [low|medium|high]]";

/** Register the standalone `/codex-usage` command and screen. */
export default async function codexUsageExtension(pi: ExtensionAPI): Promise<void> {
   let verbosity = await loadCodexVerbosity();

   pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model?.provider !== "openai-codex") return undefined;
      return applyCodexVerbosity(event.payload, verbosity);
   });

   const setVerbosity = async (nextVerbosity: CodexVerbosity, ctx: ExtensionCommandContext): Promise<void> => {
      try {
         await saveCodexVerbosity(nextVerbosity);
         verbosity = nextVerbosity;
         ctx.ui.notify(`Codex verbosity set to ${nextVerbosity}.`, "info");
      } catch (error) {
         ctx.ui.notify(
            `Could not save Codex verbosity: ${error instanceof Error ? error.message : String(error)}`,
            "error"
         );
      }
   };

   pi.registerCommand("codex-usage", {
      description: "Show Codex usage or set response verbosity",
      getArgumentCompletions: (prefix) => {
         const normalizedPrefix = prefix.toLowerCase();
         const verbosityPrefix = normalizedPrefix.startsWith("verbosity ");
         const query = (verbosityPrefix ? normalizedPrefix.slice("verbosity ".length) : normalizedPrefix).trim();
         const options = verbosityPrefix ? CODEX_VERBOSITY_LEVELS : ["low", "medium", "high", "verbosity"];
         const matches = options
            .filter((option) => !query || option.startsWith(query))
            .map((value) => ({ value, label: value }));
         return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx) => {
         const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
         if (tokens.length > 0) {
            const isVerbosityCommand = tokens[0] === "verbosity";
            if ((!isVerbosityCommand && tokens.length > 1) || tokens.length > 2) {
               ctx.ui.notify(CODEX_USAGE_COMMAND_USAGE, "warning");
               return;
            }

            let requestedVerbosity = isVerbosityCommand ? tokens[1] : tokens[0];
            if (isVerbosityCommand && !requestedVerbosity) {
               if (!ctx.hasUI) {
                  ctx.ui.notify(`Current Codex verbosity: ${verbosity}. ${CODEX_USAGE_COMMAND_USAGE}`, "info");
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
            await openCodexUsageScreen(ctx);
            return;
         }

         try {
            ctx.ui.notify(`${formatCodexUsage(await fetchCodexUsage(ctx))}\nVerbosity: ${verbosity}`, "info");
         } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
         }
      }
   });
}
