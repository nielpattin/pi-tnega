import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

export function registerRtkGrep(pi: ExtensionAPI, isEnabled: () => boolean) {
   pi.registerTool({
      name: "rtk_grep",
      label: "rtk grep",
      description:
         "Search file contents using rtk for token-optimized output. Falls back to showing a disabled message if rtk tools are off.",
      promptSnippet: "Token-optimized content search via RTK",
      parameters: Type.Object({
         pattern: Type.String({ description: "Search pattern" }),
         path: Type.Optional(Type.String({ description: "Directory or file to search in. Defaults to cwd." })),
         ignoreCase: Type.Optional(Type.Boolean({ description: "Case insensitive search" })),
         literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string, not regex" })),
         context: Type.Optional(Type.Number({ description: "Number of context lines around matches" })),
      }),

      renderCall(args, theme) {
         const pattern = theme.fg("accent", `"${args.pattern}"`);
         const path = args.path ? ` ${theme.fg("muted", args.path)}` : "";
         return new Text(`${theme.fg("toolTitle", theme.bold("rtk grep"))} ${pattern}${path}`, 0, 0);
      },

      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
         if (!isEnabled()) {
            return {
               content: [{ type: "text" as const, text: "rtk_grep is disabled. Enable with /pi-rtk tools on" }],
               details: undefined,
            };
         }

         const args: string[] = ["grep"];

         if (params.ignoreCase) args.push("-i");
         if (params.literal) args.push("-F");
         if (params.context !== undefined) args.push("-C", String(params.context));

         args.push(params.pattern);
         args.push(params.path ?? ".");

         const result = await pi.exec("rtk", args, { timeout: 10_000, signal });
         return {
            content: [{ type: "text" as const, text: result.stdout.trim() || "(no matches)" }],
            details: undefined,
         };
      },
   });
}
