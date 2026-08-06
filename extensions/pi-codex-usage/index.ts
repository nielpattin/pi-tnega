import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchCodexUsage, formatCodexUsage } from "./usage";
import { openCodexUsageScreen } from "./usage-screen";

/** Register the standalone `/codex-usage` command and screen. */
export default function codexUsageExtension(pi: ExtensionAPI): void {
   pi.registerCommand("codex-usage", {
      description: "Show Codex usage",
      handler: async (_args, ctx) => {
         if (ctx.hasUI && ctx.mode === "tui") {
            await openCodexUsageScreen(ctx);
            return;
         }

         try {
            ctx.ui.notify(formatCodexUsage(await fetchCodexUsage(ctx)), "info");
         } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
         }
      }
   });
}
