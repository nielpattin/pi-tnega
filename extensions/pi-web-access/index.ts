import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchContentTool } from "./src/tools/fetch-content.ts";
import { outlineSiteTool } from "./src/tools/outline-site.ts";
import { webResearchTool } from "./src/tools/web-research.ts";
import { webSearchTool } from "./src/tools/web-search.ts";
import { registerSearchCommand } from "./src/ui/search-command.ts";

export * from "./src/domain.ts";
export * from "./src/config.ts";
export * from "./src/fetch/client.ts";
export * from "./src/fetch/ssrf.ts";
export * from "./src/fetch/extractor.ts";
export * from "./src/fetch/pdf.ts";
export * from "./src/fetch/github.ts";
export * from "./src/fetch/firecrawl.ts";
export * from "./src/fetch/exa.ts";
export * from "./src/fetch/service.ts";
export * from "./src/providers/index.ts";
export * from "./src/research/service.ts";
export * from "./src/tools/web-search.ts";
export * from "./src/tools/outline-site.ts";
export * from "./src/tools/fetch-content.ts";
export * from "./src/tools/web-research.ts";
export * from "./src/ui/formatters.ts";
export * from "./src/ui/tool-renderers.ts";

/** Register the Web Access extension tools and commands. */
export default function webAccessExtension(pi: ExtensionAPI): void {
   pi.registerTool(webSearchTool);
   pi.registerTool(outlineSiteTool);
   pi.registerTool(fetchContentTool);
   pi.registerTool(webResearchTool);
   registerSearchCommand(pi);
}
