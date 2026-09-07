import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Task, AgentActivityState } from "../domain.js";
import { formatAgentStatLine, type AgentStatLineInput } from "./tool-renderers.js";

export const ASYNC_AGENT_WIDGET_KEY = "agents-async-agents";

export interface AsyncAgentStatusSummary {
   readonly running: number;
   readonly settled: number;
   readonly completed: number;
   readonly failed: number;
   readonly activeNames: ReadonlyArray<string>;
   readonly activeDetails: ReadonlyArray<string>;
   readonly settledSignature: string;
}

/** Tasks the widget keeps: agents spawned by this process, except cancelled ones and settled ones whose result was delivered after their pane was closed. Restored history stays in agent_list. */
export function visibleWidgetTasks(tasks: ReadonlyArray<Task>): ReadonlyArray<Task> {
   return tasks.filter((task) => {
      if (task.runtimeOwned !== true) return false;
      if (task.status === "cancelled") return false;
      if (task.status === "running" || task.status === "pending") return true;
      if (task.paneClosed === true && task.resultDelivered === true) return false;
      return true;
   });
}

/** Latest human-readable activity for one agent, if any is reported. */
export function activityLabel(activity: AgentActivityState | undefined): string | undefined {
   if (!activity) return undefined;
   if (activity.phase === "starting") return "starting";
   if (activity.phase === "waiting") return "waiting";
   if (activity.phase === "done") return "done";
   return activity.toolName ?? activity.activeScope ?? activity.messageEventType ?? "working";
}

/** Count agents and the names of those still in flight for the current runtime. */
export function summarizeAsyncAgentStatus(tasks: ReadonlyArray<Task>): AsyncAgentStatusSummary {
   const visible = visibleWidgetTasks(tasks);
   const running = visible.filter((task) => task.status === "running" || task.status === "pending").length;
   const settledTasks = visible.filter((task) => task.status === "completed" || task.status === "failed");
   const completed = settledTasks.filter((task) => task.status === "completed").length;
   const failed = settledTasks.filter((task) => task.status === "failed").length;
   const activeTasks = visible.filter((task) => task.status === "running" || task.status === "pending");
   const activeNames = activeTasks.map((task) => task.name).filter((name): name is string => Boolean(name));
   const activeDetails = activeTasks.map((task) => {
      const name = task.name ?? task.id;
      const label = activityLabel(task.activity);
      return label ? `${name}: ${label}` : name;
   });
   const settledSignature = settledTasks
      .map(
         (task) =>
            `${task.id}:${task.status}:${task.paneId ?? ""}:${task.paneClosed ? "x" : ""}${task.resultDelivered ? "d" : ""}`
      )
      .join(",");
   return {
      running,
      settled: settledTasks.length,
      completed,
      failed,
      activeNames,
      activeDetails,
      settledSignature
   };
}

/**
 * Snapshot key for widget dedup. Includes live activity labels so the widget
 * re-renders when an agent moves from `starting` to `read`, `bash`, etc.
 * without any change in running/completed/failed counts.
 */
export function buildAsyncAgentSnapshot(summary: AsyncAgentStatusSummary): string {
   const names = summary.activeNames.slice(0, 3).join(",");
   const details = summary.activeDetails.slice(0, 3).join(",");
   return `${summary.running}:${summary.settled}:${summary.completed}:${summary.failed}:${names}|${details}|${summary.settledSignature}`;
}

/** Braille spinner frames for the live agent indicator. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Spinner frame interval in milliseconds. Matches the frame bucket below. */
const SPINNER_INTERVAL_MS = 180;

function spinnerFrame(offset = 0): string {
   const frames = SPINNER_FRAMES.length;
   return SPINNER_FRAMES[(Math.floor(Date.now() / SPINNER_INTERVAL_MS) + offset) % frames];
}

/** Compact elapsed time: 42s, 1m03s, or 2h04m. */
function formatElapsed(startedAt: number | undefined, now: number): string | undefined {
   if (startedAt === undefined || !Number.isFinite(startedAt)) return undefined;
   const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
   if (seconds < 60) return `${seconds}s`;
   const minutes = Math.floor(seconds / 60);
   if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
   return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Build an animated above-editor widget for active agents. Collapsed by default:
 * at most 3 running and 4 settled rows with a `+N more` overflow line.
 * Expanded shows every row. Toggle with the `/wr` command. */
export function createAsyncAgentWidget(
   tasks: ReadonlyArray<Task>,
   options?: { expanded?: boolean }
): (tui: unknown, theme: Theme) => Component & { dispose(): void } {
   const visibleTasks = visibleWidgetTasks(tasks);
   const { running, completed, failed } = summarizeAsyncAgentStatus(tasks);

   return (tui: unknown, theme: Theme) => {
      const requestRender = (tui as { requestRender?: (force?: boolean) => void } | null | undefined)?.requestRender;
      let disposed = false;
      const timer = setInterval(() => {
         if (!disposed) requestRender?.();
      }, SPINNER_INTERVAL_MS);
      // Never hold the process open for widget animation.
      (timer as unknown as { unref?: () => void }).unref?.();

      return {
         render(width: number): string[] {
            const expanded = options?.expanded === true;
            const inFlight = visibleTasks.filter((task) => task.status === "running" || task.status === "pending");
            const settled = visibleTasks.filter((task) => task.status === "completed" || task.status === "failed");
            const collapsedOverflow = inFlight.length > 3 || settled.length > 4;
            const segments: string[] = [];
            if (running > 0) segments.push(theme.fg("warning", `● ${running} working`));
            if (completed > 0) segments.push(theme.fg("success", `✓ ${completed} done`));
            if (failed > 0) segments.push(theme.fg("error", `✗ ${failed} failed`));
            if (segments.length === 0) segments.push(theme.fg("dim", "idle"));

            const mark = running > 0 ? theme.fg("warning", "•") : theme.fg("dim", "•");
            const headerText =
               `${mark} ${theme.fg("text", theme.bold("agents"))} ` +
               segments.join(theme.fg("dim", " · ")) +
               (expanded && collapsedOverflow ? theme.fg("dim", " (/wr to collapse)") : "");
            const lines = [truncateToWidth(headerText, Math.max(0, width))];

            const now = Date.now();
            const flightCap = expanded ? inFlight.length : 3;
            const overflow = inFlight.length > flightCap ? inFlight.length - flightCap : 0;
            inFlight.slice(0, flightCap).forEach((task, index) => {
               const name = task.name ?? task.id;
               const extras: string[] = [];
               if (task.profile) extras.push(task.profile);
               const elapsed = formatElapsed(task.startedAt ?? task.createdAt, now);
               if (elapsed) extras.push(elapsed);
               const label = activityLabel(task.activity);
               if (label) extras.push(label);
               if (task.paneId) extras.push(`pane ${task.paneId}`);
               const agentLine =
                  `${theme.fg("warning", spinnerFrame(index * 2 + 1))} ${theme.fg("accent", name)}` +
                  (extras.length > 0 ? theme.fg("dim", ` · ${extras.join(" · ")}`) : "");
               const budget = Math.max(0, width - 2);
               const visible =
                  visibleWidth(agentLine) > budget ? truncateToWidth(agentLine, budget, "…", false) : agentLine;
               if (visible.length > 0) lines.push(`  ${visible}`);
            });
            if (overflow > 0) lines.push(theme.fg("dim", `  +${overflow} more (/wr to expand)`));

            const settledCap = expanded ? settled.length : 4;
            const settledOverflow = settled.length > settledCap ? settled.length - settledCap : 0;
            settled.slice(0, settledCap).forEach((task) => {
               const name = task.name ?? task.id;
               const output = task.resultData ?? task.errorText;
               const text = typeof output === "string" ? output : undefined;
               const lineCount = text ? text.split("\n").length : 0;
               const statLine = formatAgentStatLine(
                  {
                     status: task.status,
                     name,
                     profile: task.profile,
                     usage: task.usage as AgentStatLineInput["usage"] | undefined,
                     lineCount
                  },
                  theme
               );
               const pane = task.paneId
                  ? theme.fg("dim", ` · pane ${task.paneId}`)
                  : task.paneClosed === true
                    ? theme.fg("dim", " · pane closed")
                    : "";
               const fullLine = `${statLine}${pane}`;
               const budget = Math.max(0, width - 2);
               const trimmed =
                  visibleWidth(fullLine) > budget ? truncateToWidth(fullLine, budget, "…", false) : fullLine;
               if (trimmed.length > 0) lines.push(`  ${trimmed}`);
            });
            if (settledOverflow > 0) lines.push(theme.fg("dim", `  +${settledOverflow} more (/wr to expand)`));

            return lines;
         },
         invalidate() {},
         dispose() {
            disposed = true;
            clearInterval(timer);
         }
      };
   };
}
