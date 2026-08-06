import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { JobCancelToolParams, JobListToolParams } from "../tools/jobs.js";
import type { ProcessRestartToolParams, ProcessSnapshotToolParams, ProcessStartToolParams } from "../tools/process.js";
import type { JobTranscriptEntry, TaskSpec } from "../domain.js";
import type { TaskToolParams } from "../tools/task.js";

interface ToolResultLike {
   readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
   readonly details?: unknown;
}

interface RenderOptions {
   readonly expanded: boolean;
   readonly isPartial: boolean;
}

interface TaskRenderState {
   spinnerIndex?: number;
   spinnerTimer?: ReturnType<typeof setTimeout>;
   spinnerRunning?: boolean;
   jobStatuses?: ReadonlyArray<string | undefined>;
   startedAt?: number;
   endedAt?: number;
}

interface RenderContext {
   readonly isError?: boolean;
   readonly state?: TaskRenderState;
   readonly invalidate?: () => void;
   readonly executionStarted?: boolean;
}

type Details = Record<string, unknown>;

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

function jobStatusesFromDetails(details: unknown): ReadonlyArray<string | undefined> {
   if (!isRecord(details)) return [];
   if (Array.isArray(details.jobs)) {
      return details.jobs.map((job) => stringValue((job as Details).status));
   }
   const status = stringValue(details.status);
   return status !== undefined ? [status] : [];
}

function preview(value: unknown, limit = 72): string {
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
   if (status === "completed" || status === "exited" || status === "delivered") return theme.fg("success", "✓");
   if (status === "failed" || status === "cancelled") return theme.fg("error", "✗");
   if (status === "running" || status === "starting" || status === "pending") return theme.fg("warning", "●");
   return theme.fg("muted", "·");
}

function resultPrelude(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext,
   noun: string
): Component | undefined {
   if (options.isPartial) return new Text(theme.fg("warning", `${noun} working…`), 0, 0);
   const error = errorText(result);
   if (context.isError || error) {
      const message = error ?? (textContent(result).trim() || `${noun} failed`);
      return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
   }
   return undefined;
}

function fallbackResult(result: ToolResultLike, theme: Theme): Component {
   const text = preview(textContent(result), 240);
   return new Text(theme.fg("muted", text || "Done"), 0, 0);
}

const JOB_JSON_PREVIEW_LINES = 6;

function renderJsonResult(details: Details, options: RenderOptions, theme: Theme): Component {
   const json = JSON.stringify(details, null, 2);
   const lines = json.split("\n");
   const visibleLines = options.expanded ? lines : lines.slice(0, JOB_JSON_PREVIEW_LINES);
   // Pi owns the expand/collapse interaction and passes `expanded` back to
   // this renderer. Do not replace the hidden JSON with a lossy ellipsis.
   const rendered = visibleLines.map((line) => theme.fg("toolOutput", line));
   return new Text(rendered.join("\n"), 0, 0);
}

const TASK_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function taskIndicator(index: number, theme: Theme, context?: RenderContext): string {
   const status = context?.state?.jobStatuses?.[index];
   if (status === "completed") return statusMark(status, theme);
   if (status === "failed" || status === "cancelled") return statusMark(status, theme);
   return theme.fg("muted", "·");
}

function taskCountLabel(count: number): string {
   return `${count} task${count === 1 ? "" : "s"}`;
}

function taskCallPhase(status: string | undefined, theme: Theme): string {
   if (status === "completed") return `${theme.fg("muted", "completed")} ${statusMark(status, theme)}`;
   if (status === "failed") return `${theme.fg("muted", "failed")} ${statusMark(status, theme)}`;
   if (status === "cancelled") return `${theme.fg("muted", "cancelled")} ${statusMark(status, theme)}`;
   return theme.fg("muted", "started");
}

/** Render a Harbor task tool call as a compact task plan. */
export function renderTaskCall(args: Partial<TaskToolParams>, theme: Theme, context?: RenderContext): Component {
   const batch = "tasks" in args && Array.isArray(args.tasks) ? args.tasks : undefined;
   const rawTasks = batch ?? ("task" in args && typeof args.task === "string" ? [args] : []);
   const tasks = rawTasks as ReadonlyArray<Partial<TaskSpec>>;
   const countLabel = taskCountLabel(tasks.length);
   if (tasks.length === 1) {
      const task = tasks[0];
      const name = stringValue(task.name) ?? "task";
      const phase = taskCallPhase(context?.state?.jobStatuses?.[0], theme);
      return new Text(
         `${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("accent", name)} ${phase}\n${theme.fg("dim", stringValue(task.task) ?? "")}`,
         0,
         0
      );
   }
   const lines = [`${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("muted", `batch started · ${countLabel}`)}`];
   for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const name = stringValue(task.name) ?? "task";
      const agent = stringValue(task.agent) ?? "task";
      lines.push(
         `${taskIndicator(index, theme, context)} ${theme.fg("accent", name)} ${theme.fg("muted", `· ${agent}`)} ${theme.fg("dim", preview(task.task))}`
      );
   }
   return new Text(lines.join("\n"), 0, 0);
}

/** Render a Harbor task result as job handles and lifecycle states. */
export function renderTaskResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   // Update per-row status state from every result (partial or final) so the
   // call renderer can switch a completed row's indicator immediately. A final
   // result with no explicit per-row status still means the task has settled,
   // so infer a terminal status to stop the spinner and update the header.
   const statuses = jobStatusesFromDetails(result.details);
   if (context.state) {
      let nextStatuses: ReadonlyArray<string | undefined> = statuses;
      if (!options.isPartial && nextStatuses.length === 0) {
         const error = errorText(result);
         nextStatuses = [context.isError || error ? "failed" : "completed"];
      }
      if (nextStatuses.length > 0) {
         const nextStatusesArray = Array.from(nextStatuses);
         const previousStatuses = context.state.jobStatuses;
         const statusesChanged =
            !previousStatuses ||
            previousStatuses.length !== nextStatusesArray.length ||
            nextStatusesArray.some((status, index) => status !== previousStatuses[index]);
         const allSettled = nextStatusesArray.every(
            (status) => status === "completed" || status === "failed" || status === "cancelled"
         );
         context.state.jobStatuses = nextStatusesArray;
         context.state.spinnerRunning = !allSettled;
         if (allSettled && context.state.spinnerTimer) clearTimeout(context.state.spinnerTimer);
         if (allSettled) context.state.spinnerTimer = undefined;
         if (statusesChanged && context.invalidate) queueMicrotask(context.invalidate);
      }
   }

   if (options.isPartial) return new Text("", 0, 0);
   const prelude = resultPrelude(result, options, theme, context, "task");
   if (prelude) return prelude;
   if (!isRecord(result.details)) return fallbackResult(result, theme);
   const jobs = records(result.details.jobs);
   const taskRows = jobs.length > 0 ? jobs : stringValue(result.details.id) ? [result.details] : [];
   if (taskRows.length === 0) return fallbackResult(result, theme);
   const allSettled = taskRows.every((job) => {
      const status = stringValue(job.status);
      return status === "completed" || status === "failed" || status === "cancelled";
   });
   const isSpawnAcknowledgement = taskRows.length > 0 && taskRows.every((job) => stringValue(job.status) === "spawned");

   if (!allSettled) {
      if (isSpawnAcknowledgement) {
         const lines = [theme.fg("dim", "---")];
         if (options.expanded) {
            lines.push(
               ...expandedOutput(result.details)
                  .split("\n")
                  .map((line) => theme.fg("toolOutput", line))
            );
         } else {
            lines.push(
               theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`
            );
         }
         return new Text(lines.join("\n"), 0, 0);
      }

      const payload = options.expanded
         ? expandedOutput(result.details)
         : taskRows
              .map((job) => {
                 const id = stringValue(job.id) ?? "task";
                 const name = stringValue(job.name) ?? id;
                 const status = stringValue(job.status) ?? "pending";
                 return `${id} · ${name} · ${status}`;
              })
              .join("\n");
      const lines = [theme.fg("dim", "---"), ...payload.split("\n").map((line) => theme.fg("toolOutput", line))];
      if (!options.expanded) {
         lines.push(theme.fg("dim", "---"));
         lines.push(
            theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`
         );
      }
      return new Text(lines.join("\n"), 0, 0);
   }

   const lines: string[] = [];
   if (allSettled) {
      const outputs = taskRows
         .map((job) => ({ job, output: job.result ?? job.resultData ?? job.errorText }))
         .filter((entry) => entry.output !== null && entry.output !== undefined);
      if (outputs.length > 0) {
         lines.push(theme.fg("dim", "---"));
         for (const { job, output } of outputs) {
            if (outputs.length > 1) {
               lines.push(theme.fg("accent", stringValue(job.name) ?? stringValue(job.id) ?? "task"));
            }
            lines.push(...taskTraceLines(job.transcript, theme, options.expanded));
            const rendered = options.expanded ? expandedOutput(output) : taskPayloadText(output);
            for (const line of rendered.split("\n")) lines.push(theme.fg("toolOutput", line));
         }
         if (!options.expanded) {
            lines.push(theme.fg("dim", "---"));
            lines.push(
               theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`
            );
         }
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

/** Render a Harbor job list call. */
export function renderJobListCall(
   _args: Partial<JobListToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   return new Text(theme.fg("toolTitle", theme.bold("job_list")), 0, 0);
}

/** Render a Harbor job cancellation call. */
export function renderJobCancelCall(
   args: Partial<JobCancelToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   const id = stringValue(args.id) ?? "job";
   return new Text(`${theme.fg("toolTitle", theme.bold("job_cancel"))} ${theme.fg("accent", id)}`, 0, 0);
}

function recordOutput(item: Details): unknown {
   return item.errorText ?? item.resultData;
}

function outputPreview(value: unknown): string {
   if (typeof value === "string") return preview(value, 120);
   if (isRecord(value) && typeof value.summary === "string") return preview(value.summary, 120);
   if (value !== undefined) return preview(JSON.stringify(value), 120);
   return "";
}

function taskPayloadText(value: unknown): string {
   if (typeof value === "string") return value;
   if (isRecord(value) && typeof value.summary === "string") return value.summary;
   if (value === undefined) return "";
   return JSON.stringify(value) ?? "";
}

function expandedOutput(value: unknown): string {
   if (typeof value === "string") return value;
   return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export function taskTraceLines(value: unknown, theme: Theme, expanded: boolean): string[] {
   if (!Array.isArray(value)) return [];
   const entries = value.filter(isRecord) as ReadonlyArray<Partial<JobTranscriptEntry> & Details>;
   const calls = entries.filter((entry) => entry.type === "tool-call");
   if (calls.length === 0) return [];

   const lines = [theme.fg("dim", "--- Tools ---")];
   for (const call of calls) {
      const args = isRecord(call.arguments) ? call.arguments : undefined;
      const argsText =
         args && expanded ? ` ${expandedOutput(args)}` : args ? ` ${preview(JSON.stringify(args), 120)}` : "";
      lines.push(theme.fg("accent", `→ ${stringValue(call.toolName) ?? "tool"}${argsText}`));
      const result = entries.find((entry) => entry.type === "tool-result" && entry.toolCallId === call.toolCallId);
      if (!result) continue;
      const content = Array.isArray(result.content)
         ? result.content
              .filter(isRecord)
              .map((part) => stringValue(part.text))
              .filter((text): text is string => text !== undefined)
              .join("\n")
         : "";
      const resultText = expanded ? content : preview(content, 120);
      const mark = result.isError === true ? "✗" : "✓";
      lines.push(
         theme.fg(
            result.isError === true ? "error" : "dim",
            `  ${mark} ${stringValue(result.toolName) ?? "tool"}${resultText ? ` · ${resultText}` : ""}`
         )
      );
   }
   return lines;
}

function transcriptEntryLines(entry: Details, expanded: boolean, theme: Theme): string[] {
   const type = stringValue(entry.type);
   if (type === "user" || type === "assistant") {
      const text = stringValue(entry.text) ?? "";
      return [theme.fg("accent", `${type}:`) + (text ? ` ${theme.fg("toolOutput", text)}` : "")];
   }
   if (type === "tool-call") {
      const toolName = stringValue(entry.toolName) ?? "tool";
      const args = expanded ? expandedOutput(entry.arguments) : JSON.stringify(entry.arguments ?? {});
      return [theme.fg("accent", `tool use ${toolName}:`) + ` ${theme.fg("toolOutput", args)}`];
   }
   if (type === "tool-result") {
      const toolName = stringValue(entry.toolName) ?? "tool";
      const content = Array.isArray(entry.content)
         ? entry.content
              .filter(isRecord)
              .map((part) => stringValue(part.text))
              .filter((text): text is string => text !== undefined)
              .join("\n")
         : "";
      return [
         theme.fg(entry.isError === true ? "error" : "accent", `tool result ${toolName}:`) +
            (content ? ` ${theme.fg(entry.isError === true ? "error" : "toolOutput", content)}` : "")
      ];
   }
   return [];
}

function renderJobTranscript(job: Details, options: RenderOptions, theme: Theme): Component {
   const status = stringValue(job.status) ?? "unknown";
   const id = stringValue(job.id) ?? "task";
   const name = stringValue(job.name) ?? id;
   const transcript = records(job.transcript);
   const transcriptLines = transcript.flatMap((entry) => transcriptEntryLines(entry, options.expanded, theme));
   const visibleLines = options.expanded ? transcriptLines : transcriptLines.slice(0, 6);
   const lines = [
      `${statusMark(status, theme)} ${theme.fg("accent", name)} ${theme.fg("muted", `· ${id} · ${status}`)}`,
      theme.fg("dim", "---"),
      ...visibleLines
   ];
   if (!options.expanded && visibleLines.length < transcriptLines.length) {
      lines.push(theme.fg("dim", "---"));
      lines.push(theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`);
   }
   return new Text(lines.join("\n"), 0, 0);
}

function renderRecordList(
   noun: string,
   items: ReadonlyArray<Details>,
   options: RenderOptions,
   theme: Theme
): Component {
   const lines = [theme.fg("muted", `${items.length} ${noun}${items.length === 1 ? "" : "s"}`)];
   const shown = options.expanded ? items : items.slice(0, 4);
   for (const item of shown) {
      const status = stringValue(item.status);
      const id = stringValue(item.id) ?? stringValue(item.name) ?? "item";
      const detail = status ?? stringValue(item.agent) ?? "";
      const output = recordOutput(item);
      const summary = outputPreview(output);
      lines.push(
         `${statusMark(status, theme)} ${theme.fg("accent", id)}${detail ? ` ${theme.fg("muted", preview(detail))}` : ""}${!options.expanded && summary ? theme.fg("dim", ` · ${summary}`) : ""}`
      );
      if (options.expanded && output !== undefined) {
         for (const line of expandedOutput(output).split("\n")) lines.push(`  ${theme.fg("toolOutput", line)}`);
      }
   }
   if (shown.length < items.length) lines.push(theme.fg("dim", `… ${items.length - shown.length} more`));
   return new Text(lines.join("\n"), 0, 0);
}

const PROCESS_PREVIEW_LINES = 5;

function formatDuration(ms: number): string {
   return `${(ms / 1000).toFixed(1)}s`;
}

function outputLines(value: unknown): string[] {
   if (typeof value !== "string") return [];
   const normalized = value.replace(/\r\n?/g, "\n").trim();
   return normalized.length > 0 ? normalized.split("\n") : [];
}

function renderProcessJobResult(
   process: Details,
   options: RenderOptions,
   theme: Theme,
   snapshotLines: ReadonlyArray<string> = []
): Component {
   const status = stringValue(process.status);
   const exitCode = numberValue(process.exitCode);
   const readyState = isRecord(process.readyState) ? process.readyState : undefined;
   const ready = status === "running" && process.readyCondition !== undefined && readyState?.ready === true;
   const terminal = status === "exited" || status === "failed";

   let marker = theme.fg("muted", "·");
   let label = status ?? "unknown";
   if (ready) {
      marker = theme.fg("success", "✓");
      label = "ready";
   } else if (status === "running" || status === "starting") {
      marker = theme.fg("warning", "●");
   } else if (status === "exited") {
      marker = theme.fg(exitCode === undefined || exitCode === 0 ? "success" : "error", "✓");
      label = `exited (${exitCode ?? "?"})`;
   } else if (status === "failed") {
      marker = theme.fg("error", "✗");
      label = `failed${exitCode !== undefined ? ` (${exitCode})` : ""}`;
   }

   const pid = numberValue(process.pid);
   const pidText = pid !== undefined && pid > 0 ? ` · pid ${pid}` : "";
   const spawnTime = numberValue(process.spawnTime);
   const settledAt = numberValue(process.settledAt);
   const durationText =
      terminal && spawnTime !== undefined
         ? ` · ${formatDuration(Math.max(0, (settledAt ?? Date.now()) - spawnTime))}`
         : "";
   const renderedLines = [`${marker} ${label}${pidText}${durationText}`];

   const errorOutput = outputLines(process.errorText);
   const resultOutput = outputLines(process.resultText);
   const output = errorOutput.length > 0 ? errorOutput : resultOutput;
   const hiddenLineCount = errorOutput.length > 0 ? 0 : Math.max(0, output.length - PROCESS_PREVIEW_LINES);
   const visibleOutput = options.expanded ? output : output.slice(-PROCESS_PREVIEW_LINES);
   if (hiddenLineCount > 0) {
      renderedLines.push(
         theme.fg("muted", `... (${hiddenLineCount} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
      );
   }
   renderedLines.push(...visibleOutput.map((line) => theme.fg(errorOutput.length > 0 ? "error" : "toolOutput", line)));

   if (snapshotLines.length > 0) {
      renderedLines.push(theme.fg("dim", "--- logs ---"));
      const visibleSnapshotLines = options.expanded ? snapshotLines : snapshotLines.slice(-PROCESS_PREVIEW_LINES);
      renderedLines.push(...visibleSnapshotLines.map((line) => theme.fg("toolOutput", line)));
   }

   return new Text(renderedLines.join("\n"), 0, 0);
}

/** Render a Harbor job result without exposing raw JSON envelopes. */
export function renderJobListResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext,
   noun = "job"
): Component {
   const details = isRecord(result.details) ? result.details : undefined;
   const prelude = resultPrelude(result, options, theme, context, noun);
   if (prelude) return prelude;
   if (!details) return fallbackResult(result, theme);
   for (const [key, itemNoun] of [
      ["jobs", "job"],
      ["processes", "process"]
   ] as const) {
      const items = records(details[key]);
      if (Array.isArray(details[key])) return renderRecordList(itemNoun, items, options, theme);
   }
   if (isRecord(details.process)) {
      const lines = Array.isArray(details.lines)
         ? details.lines.filter((line): line is string => typeof line === "string")
         : [];
      return renderProcessJobResult(details.process, options, theme, lines);
   }
   if (Array.isArray(details.lines)) {
      const lines = details.lines.filter((line): line is string => typeof line === "string");
      const shown = options.expanded ? lines : lines.slice(-4);
      return new Text(
         `${theme.fg("muted", `${lines.length} log lines`)}\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`,
         0,
         0
      );
   }
   const entity = isRecord(details.job) ? details.job : undefined;
   if (entity) {
      if (Array.isArray(entity.transcript) && entity.transcript.length > 0) {
         return renderJobTranscript(entity, options, theme);
      }
      return renderRecordList("item", [entity], options, theme);
   }
   return renderJsonResult(details, options, theme);
}

/** Render the process start call as a compact process lifecycle action. */
export function renderProcessStartCall(
   args: Partial<ProcessStartToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   return new Text(
      `${theme.fg("toolTitle", theme.bold(`▶ ${stringValue(args.name) ?? "process"}`))}\n${theme.fg("toolTitle", theme.bold(`$ ${stringValue(args.command) ?? "..."}`))}`,
      0,
      0
   );
}

export function renderProcessSnapshotCall(
   args: Partial<ProcessSnapshotToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   const id = stringValue(args.id) ?? "process";
   return new Text(`${theme.fg("toolTitle", theme.bold("process_snapshot"))} ${theme.fg("accent", id)}`, 0, 0);
}

export function renderProcessRestartCall(
   args: Partial<ProcessRestartToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   const id = stringValue(args.id) ?? "process";
   return new Text(`${theme.fg("toolTitle", theme.bold("process_restart"))} ${theme.fg("accent", id)}`, 0, 0);
}

export function renderJobCancelResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderJobListResult(result, options, theme, context, "job");
}

export function renderProcessStartResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderJobListResult(result, options, theme, context, "process");
}

export function renderProcessSnapshotResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderJobListResult(result, options, theme, context, "process");
}

export function renderProcessRestartResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderJobListResult(result, options, theme, context, "process");
}
