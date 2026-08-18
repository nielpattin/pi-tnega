import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fetchCodexUsage, type CodexUsageSnapshot } from "./usage";

interface UsageView {
   ensureLoaded(): void;
   handleInput(data: string): boolean;
   render(theme: Theme, width: number): string[];
}

/** Open the read-only Codex usage screen. Resolves to `"settings"` when the user presses S. */
export async function openCodexUsageScreen(ctx: ExtensionContext): Promise<"settings" | undefined> {
   return ctx.ui.custom<"settings" | undefined>((tui, theme, _keybindings, done) => {
      const view = createUsageView(ctx, () => tui.requestRender());
      view.ensureLoaded();

      return {
         render(width: number) {
            return view.render(theme, width);
         },
         invalidate() {},
         handleInput(data: string) {
            if (matchesKey(data, "escape")) {
               done(undefined);
               return true;
            }
            if (data.toLowerCase() === "s") {
               done("settings");
               return true;
            }
            return view.handleInput(data);
         }
      };
   });
}

function createUsageView(ctx: ExtensionContext, requestRender: () => void): UsageView {
   let usageState: CodexUsageSnapshot | { error: string } | undefined;
   let usageLoading = false;

   const load = () => {
      if (usageLoading) return;
      usageLoading = true;
      requestRender();
      fetchCodexUsage(ctx)
         .then((usage) => {
            usageState = usage;
         })
         .catch((error: unknown) => {
            usageState = { error: error instanceof Error ? error.message : String(error) };
         })
         .finally(() => {
            usageLoading = false;
            requestRender();
         });
   };

   return {
      ensureLoaded: load,
      handleInput(data: string) {
         if (data.toLowerCase() !== "r") return false;
         load();
         return true;
      },
      render(theme: Theme, width: number) {
         return formatUsageLines(theme, usageState, usageLoading, width);
      }
   };
}

export function formatUsageLines(
   theme: Theme,
   usageState: CodexUsageSnapshot | { error: string } | undefined,
   loading: boolean,
   width = 80
): string[] {
   const safeWidth = Math.max(10, width);
   if (!usageState) {
      return [truncateToWidth(theme.fg("dim", "  Loading Codex usage…"), safeWidth)];
   }

   if ("error" in usageState) {
      const errorContentWidth = Math.max(10, safeWidth - 4);
      const wrappedErrorLines = wrapTextWithAnsi(usageState.error, errorContentWidth);
      const formattedErrors = wrappedErrorLines.map((line) =>
         truncateToWidth(theme.fg("error", `  ${line}`), safeWidth)
      );
      return [
         ...formattedErrors,
         truncateToWidth(theme.fg("dim", "  Press R to retry · S for settings · Esc to close"), safeWidth)
      ];
   }

   const rows = usageState.limits.map((limit) => {
      const primary = usageColumns(limit.primary);
      const secondary = usageColumns(limit.secondary);
      return [
         limit.limitName ?? limit.limitId,
         primary.bar,
         primary.percent,
         primary.reset,
         secondary.bar,
         secondary.percent,
         secondary.reset
      ];
   });
   const headers = ["Limit", "5h left", "", "Reset", "Weekly left", "", "Reset"];
   const widths = columnWidths([headers, ...rows]);
   const totalTableWidth = widths.reduce((sum, colWidth) => sum + colWidth, 0) + 2 * (widths.length - 1);
   const dividerLength = Math.max(0, Math.min(totalTableWidth, safeWidth - 4));

   const rawLines = [
      `  ${theme.bold(`Codex usage${usageState.planType ? ` · ${usageState.planType}` : ""}`)}${loading ? theme.fg("dim", "  refreshing…") : ""}`,
      theme.fg("dim", "  Press R to refresh · S for settings · Esc to close"),
      "",
      formatUsageRow(
         headers.map((header) => theme.fg("dim", header)),
         widths
      ),
      theme.fg("borderMuted", `  ${"─".repeat(dividerLength)}`),
      ...rows.map((row) => formatUsageRow(row, widths))
   ];

   return rawLines.map((line) => truncateToWidth(line, safeWidth));
}

function columnWidths(rows: string[][]): number[] {
   const columnCount = Math.max(...rows.map((row) => row.length));
   return Array.from({ length: columnCount }, (_, index) =>
      Math.max(...rows.map((row) => stripAnsi(row[index] ?? "").length))
   );
}

function stripAnsi(value: string): string {
   return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function padCell(value: string, width: number): string {
   return value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
}

function formatUsageRow(row: string[], widths: number[]): string {
   return `  ${row.map((cell, index) => padCell(cell, widths[index] ?? 0)).join("  ")}`;
}

function usageColumns(window: { usedPercent?: number; windowMinutes?: number; resetsAt?: number } | undefined): {
   bar: string;
   percent: string;
   reset: string;
} {
   if (!window) return { bar: "", percent: "", reset: "" };
   const percent = window.usedPercent === undefined ? undefined : 100 - Math.max(0, Math.min(100, window.usedPercent));
   return {
      bar: usageBar(percent),
      percent: percent === undefined ? "?%" : `${Math.round(percent)}%`,
      reset: formatResetShort(window.resetsAt)
   };
}

function usageBar(percent: number | undefined): string {
   if (percent === undefined) return "░░░░░░░░░░";
   const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
   return "█".repeat(filled) + "░".repeat(10 - filled);
}

function formatResetShort(timestampSeconds: number | undefined): string {
   if (!timestampSeconds) return "reset ?";
   const minutes = Math.max(0, Math.round((timestampSeconds * 1000 - Date.now()) / 60_000));
   if (minutes < 90) return `~${minutes}m`;
   if (minutes < 60 * 48) return `~${Math.round(minutes / 60)}h`;
   return `~${Math.round(minutes / 1_440)}d`;
}
