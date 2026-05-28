import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { registerRtkGrep } from "./rtkgrep";
import { registerRtkFind } from "./rtkfind";

const KEY = "pi-rtk";
const TIMEOUT_MS = 500;
const LC_ALL_PREFIX = "export LC_ALL=C";

const SUBCOMMANDS = ["status", "on", "off", "verbose", "statusbar", "tools", "refresh", "test", "help"] as const;

export default function piRtkExtension(pi: ExtensionAPI) {
   let sessionEnabled = true;
   let verbose = true;
   let showStatus = true;
   let toolsEnabled = true;
   let rtkAvailable: boolean | null = null;

   registerRtkGrep(pi, () => toolsEnabled);
   registerRtkFind(pi, () => toolsEnabled);

   pi.registerCommand(KEY, {
      description: "Manage RTK bash rewriting: /pi-rtk [status|on|off|verbose|statusbar|tools|refresh|test <cmd>|help]",
      getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
         const query = prefix.trim().toLowerCase();
         const matches = SUBCOMMANDS.filter((cmd) => !query || cmd.startsWith(query)).map((cmd) => ({
            value: cmd,
            label: cmd
         }));
         return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx) => {
         const trimmed = (args ?? "").trim();
         const [command, ...rest] = trimmed.split(/\s+/).filter(Boolean);
         const subcommand = command?.toLowerCase() ?? "status";

         switch (subcommand) {
            case "":
            case "status": {
               await refreshAvailability(ctx, true);
               ctx.ui.notify(
                  buildStatusMessage(sessionEnabled, verbose, showStatus, rtkAvailable, toolsEnabled),
                  "info"
               );
               return;
            }
            case "on": {
               sessionEnabled = true;
               await refreshAvailability(ctx, true);
               updateStatus(ctx);
               ctx.ui.notify(
                  buildStatusMessage(sessionEnabled, verbose, showStatus, rtkAvailable, toolsEnabled),
                  "info"
               );
               return;
            }
            case "off": {
               sessionEnabled = false;
               updateStatus(ctx);
               ctx.ui.notify(
                  buildStatusMessage(sessionEnabled, verbose, showStatus, rtkAvailable, toolsEnabled),
                  "info"
               );
               return;
            }
            case "refresh": {
               await refreshAvailability(ctx, true);
               updateStatus(ctx);
               ctx.ui.notify(
                  buildStatusMessage(sessionEnabled, verbose, showStatus, rtkAvailable, toolsEnabled),
                  "info"
               );
               return;
            }
            case "test": {
               const rawCommand = rest.join(" ").trim();
               if (!rawCommand) {
                  ctx.ui.notify("Usage: /pi-rtk test <bash command>", "warning");
                  return;
               }
               await refreshAvailability(ctx, true);
               if (!rtkAvailable) {
                  ctx.ui.notify("RTK is not available. Install RTK and ensure `rtk rewrite` works in PATH.", "warning");
                  return;
               }
               const rewritten = await getRewrite(rawCommand, ctx);
               if (rewritten) {
                  ctx.ui.notify(`RTK rewrite\n\n${rawCommand}\n→\n${rewritten}`, "info");
               } else {
                  ctx.ui.notify(`No RTK rewrite available for:\n\n${rawCommand}`, "info");
               }
               return;
            }
            case "verbose": {
               const arg = rest[0]?.toLowerCase();
               if (arg === "on" || arg === "1" || arg === "true") {
                  verbose = true;
                  ctx.ui.notify("Verbose mode enabled.", "info");
               } else if (arg === "off" || arg === "0" || arg === "false") {
                  verbose = false;
                  ctx.ui.notify("Verbose mode disabled.", "info");
               } else {
                  ctx.ui.notify(
                     `Verbose is currently ${verbose ? "on" : "off"}. Usage: /pi-rtk verbose [on|off]`,
                     "info"
                  );
               }
               return;
            }
            case "statusbar": {
               const arg = rest[0]?.toLowerCase();
               if (arg === "on" || arg === "1" || arg === "true") {
                  showStatus = true;
                  updateStatus(ctx);
                  ctx.ui.notify("Status bar enabled.", "info");
               } else if (arg === "off" || arg === "0" || arg === "false") {
                  showStatus = false;
                  updateStatus(ctx);
                  ctx.ui.notify("Status bar disabled.", "info");
               } else {
                  ctx.ui.notify(
                     `Status bar is currently ${showStatus ? "on" : "off"}. Usage: /pi-rtk statusbar [on|off]`,
                     "info"
                  );
               }
               return;
            }
            case "tools": {
               const arg = rest[0]?.toLowerCase();
               if (arg === "on" || arg === "1" || arg === "true") {
                  toolsEnabled = true;
                  ctx.ui.notify("RTK tools (rtk_grep, rtk_find) enabled.", "info");
               } else if (arg === "off" || arg === "0" || arg === "false") {
                  toolsEnabled = false;
                  ctx.ui.notify("RTK tools disabled.", "info");
               } else {
                  ctx.ui.notify(
                     `RTK tools are currently ${toolsEnabled ? "on" : "off"}. Usage: /pi-rtk tools [on|off]`,
                     "info"
                  );
               }
               return;
            }
            case "help": {
               ctx.ui.notify(
                  [
                     "/pi-rtk",
                     "",
                     "Commands:",
                     "  /pi-rtk status           Show current state",
                     "  /pi-rtk on               Enable rewriting for this session",
                     "  /pi-rtk off              Disable rewriting for this session",
                     "  /pi-rtk verbose on|off   Toggle verbose rewrite logging",
                     "  /pi-rtk statusbar on|off Toggle footer status indicator",
                     "  /pi-rtk tools on|off     Toggle rtk_grep, rtk_find tools",
                     "  /pi-rtk refresh          Re-check RTK availability",
                     "  /pi-rtk test <cmd>       Preview one rewrite",
                     "",
                     "Notes:",
                     "  - Rewrites only pi bash tool calls.",
                     "  - pi read/edit/write tools do not go through RTK.",
                     "  - RTK tools are disabled by default. Enable with /pi-rtk tools on"
                  ].join("\n"),
                  "info"
               );
               return;
            }
            default: {
               ctx.ui.notify("Unknown subcommand. Try /pi-rtk help", "warning");
               return;
            }
         }
      }
   });

   pi.on("session_start", async (_event, ctx) => {
      sessionEnabled = true;
      await refreshAvailability(ctx, false);
      updateStatus(ctx);
      if (rtkAvailable === false && ctx.hasUI) {
         ctx.ui.notify("pi-rtk extension loaded, but `rtk rewrite` is not available from PATH.", "warning");
      }
   });

   pi.on("session_shutdown", async (_event, ctx) => {
      ctx.ui.setStatus(KEY, undefined);
   });

   pi.on("tool_call", async (event, ctx) => {
      if (!sessionEnabled) return;
      if (!isToolCallEventType("bash", event)) return;

      const original = event.input.command;
      if (typeof original !== "string" || !original.trim()) return;
      if (original.trimStart().startsWith("rtk ")) return;

      // Skip rewriting for pnpm / bun / npm lint — rtk rewrite converts it to "rtk lint" which tries eslint
      const trimmedCmd = original.trimStart();
      if (/\b(pnpm|bun|npm)\b/.test(trimmedCmd) && /\blint\b/.test(trimmedCmd)) return;

      await refreshAvailability(ctx, false);
      if (!rtkAvailable) return;

      const rewritten = await getRewrite(original, ctx);
      if (!rewritten || rewritten === original) return;

      event.input.command = withLcAll(rewritten);
      if (verbose && ctx.hasUI) {
         ctx.ui.notify(`RTK: ${original} → ${rewritten}`, "info");
      }
   });

   async function refreshAvailability(ctx: ExtensionContext, force: boolean): Promise<boolean> {
      if (!force && rtkAvailable !== null) return rtkAvailable;

      try {
         const result = await pi.exec("rtk", ["rewrite", "git status"], {
            timeout: TIMEOUT_MS,
            signal: ctx.signal
         });
         const stdout = result.stdout.trim();
         const ok = stdout.length > 0 && stdout.startsWith("rtk ");
         rtkAvailable = ok;
         return ok;
      } catch {
         rtkAvailable = false;
         return false;
      }
   }

   async function getRewrite(command: string, ctx: ExtensionContext): Promise<string | null> {
      try {
         const result = await pi.exec("rtk", ["rewrite", command], {
            timeout: TIMEOUT_MS,
            signal: ctx.signal
         });
         const stdout = result.stdout.trim();
         return stdout && stdout !== command ? stdout : null;
      } catch {
         return null;
      }
   }

   function updateStatus(ctx: Pick<ExtensionContext, "ui">) {
      if (!showStatus) {
         ctx.ui.setStatus(KEY, undefined);
         return;
      }
      ctx.ui.setStatus(KEY, buildStatusLine(sessionEnabled, rtkAvailable));
   }
}

function withLcAll(command: string): string {
   if (command.includes("LC_ALL=")) return command;
   return `${LC_ALL_PREFIX}\n${command}`;
}

function buildStatusMessage(
   sessionEnabled: boolean,
   verbose: boolean,
   showStatus: boolean,
   rtkAvailable: boolean | null,
   toolsEnabled: boolean
): string {
   const availability = rtkAvailable === null ? "checking" : rtkAvailable ? "available" : "missing";
   return [
      `RTK: ${sessionEnabled ? "enabled" : "disabled"}`,
      `RTK binary: ${availability}`,
      `Verbose: ${verbose ? "on" : "off"}`,
      `Status bar: ${showStatus ? "on" : "off"}`,
      `RTK tools: ${toolsEnabled ? "on" : "off"}`
   ].join("\n");
}

function buildStatusLine(sessionEnabled: boolean, rtkAvailable: boolean | null): string {
   if (!sessionEnabled) return "RTK: off";
   if (rtkAvailable === null) return "RTK: checking";
   return rtkAvailable ? "RTK: on" : "RTK: missing";
}
