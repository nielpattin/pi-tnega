import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

function formatToolStatuses(tools: ToolInfo[], activeToolNames: string[]): string {
   const activeTools = new Set(activeToolNames);
   return [
      "Tools:",
      ...tools.map((tool) => `- ${tool.name}: ${activeTools.has(tool.name) ? "active" : "inactive"}`)
   ].join("\n");
}

/** Register the read-only `/tools` status command. */
export default function toolStatusExtension(pi: ExtensionAPI): void {
   pi.registerCommand("tools", {
      description: "Show tool status",
      handler: async (_args, ctx) => {
         ctx.ui.notify(formatToolStatuses(pi.getAllTools(), pi.getActiveTools()), "info");
      }
   });
}
