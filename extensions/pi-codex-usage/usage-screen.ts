import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  CODEX_RESERVE_USAGE_NOTE,
  codexUsageLimitName,
  consumeCodexRateLimitResetCredit,
  createCodexRateLimitResetRedeemRequestId,
  fetchCodexUsage,
  formatResetConsumeResult,
  formatResetCreditExpiries,
  type CodexUsageSnapshot,
} from "./usage.js";

interface UsageView {
  ensureLoaded(): void;
  handleInput(data: string): boolean;
  render(theme: Theme, width: number): string[];
}

/** Open the Codex usage screen with banked-reset support. Resolves to `"settings"` when the user presses S. */
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
      },
    };
  });
}

function createUsageView(ctx: ExtensionContext, requestRender: () => void): UsageView {
  let usageState: CodexUsageSnapshot | { error: string } | undefined;
  let usageLoading = false;
  let resetLoading = false;
  let resetLockedUntilRefresh = false;
  let resetRedeemRequestId: string | undefined;
  let resetMessage: { kind: "info" | "error"; text: string } | undefined;
  const load = (unlockReset = false) => {
    if (usageLoading) return;
    usageLoading = true;
    requestRender();
    fetchCodexUsage(ctx)
      .then((usage) => {
        usageState = usage;
        if (unlockReset) {
          resetLockedUntilRefresh = false;
          resetRedeemRequestId = undefined;
          resetMessage = undefined;
        }
      })
      .catch((error: unknown) => {
        usageState = { error: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        usageLoading = false;
        requestRender();
      });
  };
  const canConsumeReset = (): boolean => {
    return Boolean(
      usageState && !("error" in usageState) && (usageState.resetCredits?.availableCount ?? 0) > 0,
    );
  };
  const consumeReset = () => {
    if (resetLoading || usageLoading) return;
    if (resetLockedUntilRefresh) {
      resetMessage = { kind: "info", text: "Press R to refresh before using another reset." };
      requestRender();
      return;
    }
    if (!canConsumeReset()) return;
    resetLoading = true;
    resetMessage = undefined;
    resetRedeemRequestId ??= createCodexRateLimitResetRedeemRequestId();
    const redeemRequestId = resetRedeemRequestId;
    requestRender();
    consumeCodexRateLimitResetCredit(ctx, redeemRequestId)
      .then((result) => {
        resetMessage = {
          kind:
            result.outcome === "reset" || result.outcome === "already_redeemed" ? "info" : "error",
          text: formatResetConsumeResult(result),
        };
        resetLockedUntilRefresh = true;
        resetRedeemRequestId = undefined;
        usageState = undefined;
        load();
      })
      .catch((error: unknown) => {
        resetMessage = {
          kind: "error",
          text: `${error instanceof Error ? error.message : String(error)} Press Ctrl+R to retry the same reset request, or R to refresh.`,
        };
      })
      .finally(() => {
        resetLoading = false;
        requestRender();
      });
  };

  return {
    ensureLoaded: load,
    handleInput(data: string) {
      if (data.toLowerCase() === "r") {
        if (!resetLoading) load(true);
        return true;
      }
      if (matchesKey(data, "ctrl+r")) {
        consumeReset();
        return true;
      }
      return false;
    },
    render(theme: Theme, width: number) {
      return formatUsageLines(theme, usageState, usageLoading, width, {
        resetLoading,
        resetLockedUntilRefresh,
        resetMessage,
      });
    },
  };
}

export function formatUsageLines(
  theme: Theme,
  usageState: CodexUsageSnapshot | { error: string } | undefined,
  loading: boolean,
  width = 80,
  reset: {
    resetLoading?: boolean;
    resetLockedUntilRefresh?: boolean;
    resetMessage?: { kind: "info" | "error"; text: string };
  } = {},
): string[] {
  const safeWidth = Math.max(10, width);
  if (!usageState) {
    return [truncateToWidth(theme.fg("dim", "  Loading Codex usage…"), safeWidth)];
  }

  if ("error" in usageState) {
    const errorContentWidth = Math.max(10, safeWidth - 4);
    const wrappedErrorLines = wrapTextWithAnsi(usageState.error, errorContentWidth);
    const formattedErrors = wrappedErrorLines.map((line) =>
      truncateToWidth(theme.fg("error", `  ${line}`), safeWidth),
    );
    return [
      ...formattedErrors,
      truncateToWidth(
        theme.fg("dim", "  Press R to retry · S for settings · Esc to close"),
        safeWidth,
      ),
    ];
  }

  const rows = usageState.limits.map((limit) => {
    const primary = usageColumns(limit.primary);
    const secondary = usageColumns(limit.secondary);
    return [
      codexUsageLimitName(limit),
      primary.bar,
      primary.percent,
      primary.reset,
      secondary.bar,
      secondary.percent,
      secondary.reset,
    ];
  });
  const headers = ["Limit", "5h left", "", "Reset", "Weekly left", "", "Reset"];
  const widths = columnWidths([headers, ...rows]);
  const totalTableWidth =
    widths.reduce((sum, colWidth) => sum + colWidth, 0) + 2 * (widths.length - 1);
  const dividerLength = Math.max(0, Math.min(totalTableWidth, safeWidth - 4));

  const count = usageState.resetCredits?.availableCount;
  const bankedHint =
    count !== undefined && count > 0
      ? reset.resetLockedUntilRefresh
        ? "  R to refresh before another reset"
        : "  Ctrl+R to use one"
      : "";
  const rawLines = [
    `  ${theme.bold(`Codex usage${usageState.planType ? ` · ${usageState.planType}` : ""}`)}${loading ? theme.fg("dim", "  refreshing…") : ""}`,
    `  Banked resets: ${theme.bold(count === undefined ? "unknown" : String(count))}${bankedHint}${reset.resetLoading ? theme.fg("dim", "  resetting…") : ""}`,
    ...(count !== undefined && count > 0
      ? [
          theme.fg(
            "dim",
            `  Expires: ${formatResetCreditExpiries(usageState.resetCredits?.credits ?? [])}`,
          ),
        ]
      : []),
    ...(reset.resetMessage
      ? [
          reset.resetMessage.kind === "error"
            ? theme.fg("error", `  ${reset.resetMessage.text}`)
            : theme.fg("accent", `  ${reset.resetMessage.text}`),
        ]
      : []),
    theme.fg("dim", "  Press R to refresh · Ctrl+R to use reset · S for settings · Esc to close"),
    "",
    formatUsageRow(
      headers.map((header) => theme.fg("dim", header)),
      widths,
    ),
    theme.fg("borderMuted", `  ${"─".repeat(dividerLength)}`),
    ...rows.map((row) => formatUsageRow(row, widths)),
    ...(usageState.limits.some((limit) => codexUsageLimitName(limit) === "Luna Reserve")
      ? ["", theme.fg("dim", `  ${CODEX_RESERVE_USAGE_NOTE}`)]
      : []),
  ];

  return rawLines.map((line) => truncateToWidth(line, safeWidth));
}

function columnWidths(rows: string[][]): number[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  return Array.from({ length: columnCount }, (_, index) =>
    Math.max(...rows.map((row) => stripAnsi(row[index] ?? "").length)),
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

function usageColumns(
  window: { usedPercent?: number; windowMinutes?: number; resetsAt?: number } | undefined,
): { bar: string; percent: string; reset: string } {
  if (!window) return { bar: "", percent: "", reset: "" };
  const percent =
    window.usedPercent === undefined
      ? undefined
      : 100 - Math.max(0, Math.min(100, window.usedPercent));
  return {
    bar: usageBar(percent),
    percent: percent === undefined ? "?%" : `${Math.round(percent)}%`,
    reset: formatResetShort(window.resetsAt),
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
