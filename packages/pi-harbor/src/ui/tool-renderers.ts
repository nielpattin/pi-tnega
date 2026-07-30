import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { HubToolParams } from "../tools/hub.js";
import type { TaskSpec } from "../domain.js";
import type { TaskToolParams } from "../tools/task.js";
import type { VibeToolParams } from "../tools/vibe.js";

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
}

interface RenderContext {
   readonly isError?: boolean;
   readonly state?: TaskRenderState;
   readonly invalidate?: () => void;
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
      const message = error ?? (preview(textContent(result), 160) || `${noun} failed`);
      return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
   }
   return undefined;
}

function fallbackResult(result: ToolResultLike, theme: Theme): Component {
   const text = preview(textContent(result), 240);
   return new Text(theme.fg("muted", text || "Done"), 0, 0);
}

const TASK_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function taskIndicator(index: number, theme: Theme, context?: RenderContext, isAsync?: boolean): string {
   const status = context?.state?.jobStatuses?.[index];
   if (status === "completed") return statusMark(status, theme);
   if (status === "failed" || status === "cancelled") return statusMark(status, theme);
   if (isAsync) return theme.fg("muted", "·");
   return theme.fg("warning", taskSpinnerFrame(context));
}

function taskSpinnerFrame(context?: RenderContext): string {
   const state = context?.state;
   if (!state || !context.invalidate) return TASK_SPINNER_FRAMES[0];
   state.spinnerRunning ??= true;
   state.spinnerIndex ??= 0;
   if (state.spinnerRunning && !state.spinnerTimer) {
      state.spinnerTimer = setTimeout(() => {
         state.spinnerTimer = undefined;
         if (!state.spinnerRunning) return;
         state.spinnerIndex = ((state.spinnerIndex ?? 0) + 1) % TASK_SPINNER_FRAMES.length;
         context.invalidate?.();
      }, 80);
   }
   return TASK_SPINNER_FRAMES[state.spinnerIndex];
}

function jobCountLabel(count: number): string {
   return `${count} job${count === 1 ? "" : "s"}`;
}

/** Render a Harbor task tool call as a compact task plan. */
export function renderTaskCall(args: Partial<TaskToolParams>, theme: Theme, context?: RenderContext): Component {
   const batch = "tasks" in args && Array.isArray(args.tasks) ? args.tasks : undefined;
   const rawTasks = batch ?? ("task" in args && typeof args.task === "string" ? [args] : []);
   const tasks = rawTasks as ReadonlyArray<Partial<TaskSpec>>;
   const countLabel = jobCountLabel(tasks.length);
   if (tasks.length === 1) {
      const task = tasks[0];
      const name = stringValue(task.name) ?? "task";
      const agent = stringValue(task.agent) ?? "task";
      const isAsync = task.background === true || task.async === true;
      const indicator = isAsync ? "" : ` ${taskIndicator(0, theme, context, isAsync)}`;
      return new Text(
         `${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("accent", name)} ${theme.fg("muted", `· ${agent}  ${countLabel}`)}${indicator}\n${theme.fg("dim", stringValue(task.task) ?? "")}`,
         0,
         0
      );
   }
   const lines = [theme.fg("toolTitle", theme.bold(`task ${countLabel}`))];
   for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const name = stringValue(task.name) ?? "task";
      const agent = stringValue(task.agent) ?? "task";
      lines.push(
         `${taskIndicator(index, theme, context, task.background === true || task.async === true)} ${theme.fg("accent", name)} ${theme.fg("muted", `· ${agent}`)} ${theme.fg("dim", preview(task.task))}`
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
   if (jobs.length === 0) return fallbackResult(result, theme);
   const allSettled = jobs.every((job) => {
      const status = stringValue(job.status);
      return status === "completed" || status === "failed" || status === "cancelled";
   });

   const lines: string[] = [];
   if (allSettled) {
      const outputs = jobs
         .map((job) => ({ job, output: job.result ?? job.resultData ?? job.errorText }))
         .filter((entry) => entry.output !== null && entry.output !== undefined);
      if (outputs.length > 0) {
         lines.push(theme.fg("dim", "---"));
         for (const { job, output } of outputs) {
            if (outputs.length > 1) {
               lines.push(theme.fg("accent", stringValue(job.name) ?? stringValue(job.id) ?? "task"));
            }
            const rendered = options.expanded ? expandedOutput(output) : outputPreview(output);
            for (const line of rendered.split("\n")) lines.push(theme.fg("toolOutput", line));
         }
      }
   }
   return new Text(lines.join("\n"), 0, 0);
}

function hubTarget(args: Partial<HubToolParams>): string {
   if (args.op === "exec" || args.op === "start") return preview(args.command, 80);
   if (args.op === "wait") return [args.target, ...(args.ids ?? [])].filter(Boolean).join(" ");
   return args.name ?? args.id ?? args.to ?? args.from ?? "";
}

/** Render a Harbor hub call with its operation and concrete target. */
export function renderHubCall(args: Partial<HubToolParams>, theme: Theme): Component {
   const op = args.op ?? "…";
   const target = hubTarget(args);
   const suffix = args.op === "logs" && args.lines ? ` · ${args.lines} lines` : "";
   return new Text(
      `${theme.fg("toolTitle", theme.bold("hub"))} ${theme.fg("accent", op)}${target ? ` ${theme.fg("text", target)}` : ""}${theme.fg("dim", suffix)}`,
      0,
      0
   );
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

function expandedOutput(value: unknown): string {
   if (typeof value === "string") return value;
   return value === undefined ? "" : JSON.stringify(value, null, 2);
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
      const id = stringValue(item.id) ?? stringValue(item.name) ?? stringValue(item.senderId) ?? "item";
      const detail = status ?? stringValue(item.payload) ?? stringValue(item.agent) ?? "";
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

/** Render a Harbor hub result without exposing raw JSON envelopes. */
export function renderHubResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   const prelude = resultPrelude(result, options, theme, context, "hub");
   if (prelude) return prelude;
   if (!isRecord(result.details)) return fallbackResult(result, theme);
   for (const [key, noun] of [
      ["jobs", "job"],
      ["processes", "process"],
      ["messages", "message"],
      ["peers", "peer"]
   ] as const) {
      const items = records(result.details[key]);
      if (Array.isArray(result.details[key])) return renderRecordList(noun, items, options, theme);
   }
   if (Array.isArray(result.details.lines)) {
      const lines = result.details.lines.filter((line): line is string => typeof line === "string");
      const shown = options.expanded ? lines : lines.slice(-4);
      return new Text(
         `${theme.fg("muted", `${lines.length} log lines`)}\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`,
         0,
         0
      );
   }
   const exitCode = numberValue(result.details.exitCode);
   if (exitCode !== undefined) {
      const output = preview(result.details.stdout, options.expanded ? 800 : 160);
      return new Text(
         `${statusMark(exitCode === 0 ? "completed" : "failed", theme)} ${theme.fg("muted", `exit ${exitCode}`)}${output ? `\n${theme.fg("toolOutput", output)}` : ""}`,
         0,
         0
      );
   }
   const entity = isRecord(result.details.job)
      ? result.details.job
      : isRecord(result.details.process)
        ? result.details.process
        : undefined;
   if (entity) return renderRecordList("item", [entity], options, theme);
   return fallbackResult(result, theme);
}

/** Render a unified Vibe tool call with its operation and worker/session target. */
export function renderVibeCall(args: Partial<VibeToolParams>, theme: Theme): Component {
   const op = args.op ?? "…";
   let target = "";
   let detail = "";
   if (args.op === "spawn") {
      target = args.cli ?? "profile";
      detail = `${args.name ? `${args.name}  ` : ""}${preview(args.prompt)}`;
   } else if (args.op === "send") {
      target = args.session ?? "session";
      detail = preview(args.message);
   } else if (args.op === "kill") target = args.session ?? "session";
   else if (args.op === "wait") target = `${args.sessions?.length ?? 0} sessions`;
   const line = `${theme.fg("toolTitle", theme.bold("vibe"))} ${theme.fg("accent", op)}${target ? ` ${theme.fg("text", target)}` : ""}`;
   return new Text(detail ? `${line}\n  ${theme.fg("dim", detail)}` : line, 0, 0);
}

/** Render a unified Vibe result as session state instead of a JSON envelope. */
export function renderVibeResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   const prelude = resultPrelude(result, options, theme, context, "vibe");
   if (prelude) return prelude;
   if (!isRecord(result.details)) return fallbackResult(result, theme);
   const jobs = records(result.details.jobs);
   if (Array.isArray(result.details.jobs)) return renderRecordList("Vibe job", jobs, options, theme);
   const id = stringValue(result.details.id) ?? stringValue(result.details.session);
   const status = stringValue(result.details.status) ?? (result.details.delivered === true ? "delivered" : undefined);
   if (id) {
      const title = stringValue(result.details.title);
      const harness = stringValue(result.details.harness);
      const metadata = [title, harness, status].filter(Boolean).join(" · ");
      return new Text(
         `${statusMark(status, theme)} ${theme.fg("accent", id)}${metadata ? ` ${theme.fg("muted", metadata)}` : ""}`,
         0,
         0
      );
   }
   return fallbackResult(result, theme);
}
