import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type {
   ProcessListToolParams,
   ProcessRestartToolParams,
   ProcessSnapshotToolParams,
   ProcessStartToolParams,
   ProcessStopToolParams
} from "../tools/process.ts";

interface ToolResultLike {
   readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
   readonly details?: unknown;
}

interface RenderOptions {
   readonly expanded: boolean;
   readonly isPartial: boolean;
}

interface RenderContext {
   readonly isError?: boolean;
}

type Details = Record<string, unknown>;
interface ProcessLogLine {
   readonly line: string;
}

function isRecord(value: unknown): value is Details {
   return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): ReadonlyArray<Details> {
   return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
   return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
   return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function preview(value: unknown, limit = 120): string {
   if (typeof value !== "string") return "";
   const compact = value.replace(/\s+/g, " ").trim();
   return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function textContent(result: ToolResultLike): string {
   return result.content.find((part) => part.type === "text")?.text ?? "";
}

function errorText(result: ToolResultLike): string | undefined {
   if (isRecord(result.details)) return stringValue(result.details.error);
   return undefined;
}

function statusMark(status: string | undefined, theme: Theme): string {
   if (status === "exited") return theme.fg("success", "✓");
   if (status === "failed") return theme.fg("error", "✗");
   if (status === "running") return theme.fg("warning", "●");
   return theme.fg("muted", "·");
}

function resultPrelude(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component | undefined {
   if (options.isPartial) return new Text(theme.fg("warning", "process working…"), 0, 0);
   const error = errorText(result);
   if (context.isError || error) {
      const message = (error ?? textContent(result).trim()) || "process failed";
      return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
   }
   return undefined;
}

function fallbackResult(result: ToolResultLike, theme: Theme): Component {
   return new Text(theme.fg("muted", preview(textContent(result), 240) || "Done"), 0, 0);
}

function expandedOutput(value: unknown): string {
   if (typeof value === "string") return value;
   return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function outputLines(value: unknown): string[] {
   if (typeof value !== "string") return [];
   const normalized = value.replace(/\r\n?/g, "\n").trim();
   return normalized.length > 0 ? normalized.split("\n") : [];
}

function renderRecordList(items: ReadonlyArray<Details>, options: RenderOptions, theme: Theme): Component {
   const lines = [theme.fg("muted", `${items.length} process${items.length === 1 ? "" : "es"}`)];
   const shown = options.expanded ? items : items.slice(0, 6);
   for (const item of shown) {
      const status = stringValue(item.status);
      const id = stringValue(item.name) ?? stringValue(item.id) ?? "process";
      const label = status ?? "unknown";
      const output = item.errorText;
      lines.push(
         `${statusMark(status, theme)} ${theme.fg("accent", id)} ${theme.fg("muted", `· ${label}`)}${
            output ? theme.fg("dim", ` · ${preview(output)}`) : ""
         }`
      );
      if (options.expanded && output) {
         lines.push(
            ...expandedOutput(output)
               .split("\n")
               .map((line) => `  ${theme.fg("toolOutput", line)}`)
         );
      }
   }
   if (shown.length < items.length) lines.push(theme.fg("dim", `… ${items.length - shown.length} more`));
   return new Text(lines.join("\n"), 0, 0);
}

function renderProcessResult(
   process: Details,
   options: RenderOptions,
   theme: Theme,
   snapshotLines: ReadonlyArray<ProcessLogLine> = []
): Component {
   const status = stringValue(process.status);
   const exitCode = numberValue(process.exitCode);
   const terminal = status === "exited" || status === "failed";
   const pid = numberValue(process.pid);
   const spawnTime = numberValue(process.spawnTime);
   const settledAt = numberValue(process.settledAt);
   const duration =
      terminal && spawnTime !== undefined
         ? ` · ${(Math.max(0, (settledAt ?? Date.now()) - spawnTime) / 1000).toFixed(1)}s`
         : "";
   const label = status === "exited" ? `exited (${exitCode ?? "?"})` : (status ?? "unknown");
   const lines = [
      `${statusMark(status, theme)} ${label}${pid !== undefined && pid > 0 ? ` · pid ${pid}` : ""}${duration}`
   ];
   const output = outputLines(process.errorText);
   const shown = options.expanded ? output : output.slice(-5);
   if (!options.expanded && output.length > shown.length) {
      lines.push(
         theme.fg(
            "muted",
            `... (${output.length - shown.length} earlier lines, ${keyHint("app.tools.expand", "to expand")})`
         )
      );
   }
   lines.push(...shown.map((line) => theme.fg(output.length > 0 ? "error" : "toolOutput", line)));
   if (snapshotLines.length > 0) {
      lines.push(theme.fg("dim", "--- logs ---"));
      const visible = options.expanded ? snapshotLines : snapshotLines.slice(-5);
      if (!options.expanded && snapshotLines.length > visible.length) {
         lines.push(
            theme.fg("muted", `... (${snapshotLines.length - visible.length} earlier lines, ctrl+o to expand)`)
         );
      }
      lines.push(...visible.map((entry) => theme.fg("toolOutput", entry.line)));
   }
   return new Text(lines.join("\n"), 0, 0);
}

function renderProcessResultEnvelope(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   const prelude = resultPrelude(result, options, theme, context);
   if (prelude) return prelude;
   if (options.expanded) return new Text(textContent(result) || "(empty result)", 0, 0);
   if (!isRecord(result.details)) return fallbackResult(result, theme);
   const details = result.details;
   if (Array.isArray(details.processes)) return renderRecordList(records(details.processes), options, theme);
   if (isRecord(details.process)) {
      const rawLines = Array.isArray(details.lines)
         ? details.lines.filter((line): line is string => typeof line === "string")
         : [];
      const lines: ReadonlyArray<ProcessLogLine> = rawLines.map((line) => ({ line }));
      return renderProcessResult(details.process, options, theme, lines);
   }
   if (Array.isArray(details.lines)) {
      const lines = details.lines.filter((line): line is string => typeof line === "string");
      const visible = options.expanded ? lines : lines.slice(-5);
      return new Text(
         `${theme.fg("muted", `${lines.length} log lines`)}\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`,
         0,
         0
      );
   }
   return new Text(theme.fg("toolOutput", expandedOutput(details)), 0, 0);
}

export function renderProcessStartCall(args: Partial<ProcessStartToolParams>, theme: Theme): Component {
   return new Text(
      `${theme.fg("toolTitle", theme.bold(`▶ ${stringValue(args.name) ?? "process"}`))}\n${theme.fg("toolTitle", theme.bold(`$ ${stringValue(args.command) ?? "..."}`))}`,
      0,
      0
   );
}

export function renderProcessListCall(_args: Partial<ProcessListToolParams>, theme: Theme): Component {
   return new Text(theme.fg("toolTitle", theme.bold("process_list")), 0, 0);
}

export function renderProcessSnapshotCall(args: Partial<ProcessSnapshotToolParams>, theme: Theme): Component {
   return new Text(
      `${theme.fg("toolTitle", theme.bold("process_snapshot"))} ${theme.fg("accent", stringValue(args.id) ?? "process")}`,
      0,
      0
   );
}

export function renderProcessRestartCall(args: Partial<ProcessRestartToolParams>, theme: Theme): Component {
   return new Text(
      `${theme.fg("toolTitle", theme.bold("process_restart"))} ${theme.fg("accent", stringValue(args.id) ?? "process")}`,
      0,
      0
   );
}

export function renderProcessStopCall(args: Partial<ProcessStopToolParams>, theme: Theme): Component {
   return new Text(
      `${theme.fg("toolTitle", theme.bold("process_stop"))} ${theme.fg("accent", stringValue(args.id) ?? "process")}`,
      0,
      0
   );
}

export function renderProcessStartResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderProcessResultEnvelope(result, options, theme, context);
}

export function renderProcessListResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderProcessResultEnvelope(result, options, theme, context);
}

export function renderProcessSnapshotResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderProcessResultEnvelope(result, options, theme, context);
}

export function renderProcessRestartResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderProcessResultEnvelope(result, options, theme, context);
}

export function renderProcessStopResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderProcessResultEnvelope(result, options, theme, context);
}
