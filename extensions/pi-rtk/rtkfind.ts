import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

export function registerRtkFind(pi: ExtensionAPI, isEnabled: () => boolean) {
   pi.registerTool({
      name: "rtk_find",
      label: "rtk find",
      description:
         "Find files by name pattern using rtk for token-optimized output. Falls back to showing a disabled message if rtk tools are off.",
      promptSnippet: "Token-optimized file search via RTK",
      parameters: Type.Object({
         pattern: Type.String({ description: "File name or glob pattern to search for" }),
         path: Type.Optional(Type.String({ description: "Directory to search in. Defaults to cwd." }))
      }),

      renderCall(args, theme) {
         const pattern = theme.fg("accent", `"${args.pattern}"`);
         const path = args.path ? ` ${theme.fg("muted", args.path)}` : "";
         return new Text(`${theme.fg("toolTitle", theme.bold("rtk find"))} ${pattern}${path}`, 0, 0);
      },

      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
         if (!isEnabled()) {
            return {
               content: [{ type: "text" as const, text: "rtk_find is disabled. Enable with /pi-rtk tools on" }],
               details: undefined
            };
         }

         const args = ["find", params.pattern, params.path ?? "."];

         const result = await pi.exec("rtk", args, { timeout: 10_000, signal });
         return {
            content: [{ type: "text" as const, text: result.stdout.trim() || "(no matches)" }],
            details: undefined
         };
      }
   });
}
