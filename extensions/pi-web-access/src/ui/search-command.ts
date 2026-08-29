import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeSearch } from "../providers/index.ts";
import { formatSearchTextResponse } from "../tools/web-search.ts";

export function registerSearchCommand(pi: ExtensionAPI): void {
   pi.registerCommand("websearch", {
      description: "Search the web directly from Pi.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
         const query = args.trim();
         if (!query) {
            ctx.ui.notify("Usage: /websearch <query>", "warning");
            return;
         }

         ctx.ui.notify(`Searching web for "${query}"...`, "info");

         try {
            const response = await executeSearch({ query });
            const output = formatSearchTextResponse(response);

            if (response.error) {
               ctx.ui.notify(`Search failed: ${response.error}`, "error");
               return;
            }

            ctx.ui.notify(`Found ${response.results.length} results via ${response.provider}.`, "info");
            ctx.ui.pasteToEditor(`[Web Search for "${query}" via ${response.provider}]\n\n${output}`);
         } catch (error) {
            ctx.ui.notify(`Search error: ${error instanceof Error ? error.message : String(error)}`, "error");
         }
      }
   });
}
