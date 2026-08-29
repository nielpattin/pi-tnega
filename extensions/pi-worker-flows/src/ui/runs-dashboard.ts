import * as path from "node:path";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
   Key,
   matchesKey,
   truncateToWidth,
   visibleWidth,
   wrapTextWithAnsi,
   type Component,
   type Focusable,
   type TUI
} from "@earendil-works/pi-tui";
import {
   enterWorkflowAlternateScreen,
   type AbortActiveAgent,
   type AbortWorkflow,
   type GetActiveAgentSession,
   type GetAvailableModels,
   type OpenWorkflowSettings,
   WorkflowDashboard,
   matchesWorkflowDirection,
   wrapSelection
} from "./dashboard.ts";
import type { WorkflowDetails } from "../core/model.ts";
import type { Task } from "../workers/domain.js";
import type { WorkersRuntime } from "../workers/extension.js";
import { runTool } from "../workers/runtime.js";
import { TaskRegistry } from "../workers/services/task-registry.js";
import { WorkerManager } from "../workers/services/worker-manager.js";
import { buildCopiedTranscriptPayload, openTaskTakeover } from "../workers/ui/takeover.js";
import { readPiSessionTranscript } from "../workers/ui/session-transcript.js";
import { formatDuration } from "../workers/ui/formatters.js";
import { copyToClipboard } from "../shared/clipboard.ts";

export type RunsDashboardTab = "workflow" | "worker";

export function nextRunsDashboardTab(tab: RunsDashboardTab): RunsDashboardTab {
   return tab === "workflow" ? "worker" : "workflow";
}

export function resolveRunsDashboardTab(value: string | undefined): RunsDashboardTab {
   const normalized = value?.trim().toLowerCase();
   return normalized === "wr" || normalized === "worker" ? "worker" : "workflow";
}

/** Use the workflow dashboard's wraparound selection behavior for worker runs too. */
export function moveWorkerRunSelection(index: number, delta: number, length: number): number {
   return wrapSelection(index, delta, length);
}

export type DashboardPickResult = { type: "takeover"; taskId: string };

export interface RunsDashboardOptions {
   readonly workerRuntime: WorkersRuntime;
   readonly workflow: {
      readonly getActive: () => Map<string, WorkflowDetails>;
      readonly sessionId: string;
      readonly referencedRunIds: ReadonlySet<string>;
      readonly initialRunId?: string;
      readonly getActiveAgentSession?: GetActiveAgentSession;
      readonly abortActiveAgent?: AbortActiveAgent;
      readonly getAvailableModels?: GetAvailableModels;
      readonly abortWorkflow?: AbortWorkflow;
      readonly openWorkflowSettings?: OpenWorkflowSettings;
   };
   readonly initialTab?: RunsDashboardTab;
   readonly lastViewedWorker?: DashboardPickResult | null;
}

function configuredKeys(
   keybindings: KeybindingsManager,
   binding: Parameters<KeybindingsManager["getKeys"]>[0]
): string {
   return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(status: string, theme: Theme): string {
   switch (status) {
      case "running":
      case "pending":
         return theme.fg("warning", "■");
      case "recoverable":
         return theme.fg("warning", "↻");
      case "completed":
         return theme.fg("success", "■");
      case "failed":
      case "cancelled":
         return theme.fg("error", "■");
      default:
         return theme.fg("muted", "■");
   }
}

function statusWord(status: string, theme: Theme): string {
   switch (status) {
      case "running":
      case "pending":
         return theme.fg("warning", status);
      case "recoverable":
         return theme.fg("warning", "recoverable");
      case "completed":
         return theme.fg("success", status);
      case "failed":
      case "cancelled":
         return theme.fg("error", status);
      default:
         return theme.fg("muted", status);
   }
}

class WorkerRunsView implements Component, Focusable {
   private runs: Task[] = [];
   private selectedIndex = 0;
   private closed = false;
   private disposed = false;
   private focusedState = false;
   private initialSelectionApplied = false;
   private notice?: string;
   private noticeTime = 0;
   private readonly ticker: ReturnType<typeof setInterval>;

   get focused(): boolean {
      return this.focusedState;
   }

   set focused(value: boolean) {
      this.focusedState = value;
   }

   constructor(
      private readonly tui: TUI,
      private readonly theme: Theme,
      private readonly keybindings: KeybindingsManager,
      private readonly runtime: WorkersRuntime,
      private readonly done: (value: DashboardPickResult | null) => void,
      private readonly lastViewedWorker?: DashboardPickResult | null
   ) {
      this.ticker = setInterval(() => void this.refresh(), 500);
      void this.refresh();
   }

   private async refresh(): Promise<void> {
      if (this.closed) return;
      try {
         const selectedId = this.runs[this.selectedIndex]?.id;
         const runs = await runTool(
            this.runtime,
            TaskRegistry.use((registry) => registry.list())
         );
         this.runs = [...runs];
         if (!this.initialSelectionApplied) {
            this.initialSelectionApplied = true;
            const lastViewedId = this.lastViewedWorker?.taskId;
            const lastViewedIndex = lastViewedId ? this.runs.findIndex((run) => run.id === lastViewedId) : -1;
            if (lastViewedIndex >= 0) {
               this.selectedIndex = lastViewedIndex;
            } else {
               const runningIndex = this.runs.findIndex((run) => run.status === "running" || run.status === "pending");
               if (runningIndex >= 0) this.selectedIndex = runningIndex;
            }
         } else if (selectedId) {
            const refreshedIndex = this.runs.findIndex((run) => run.id === selectedId);
            if (refreshedIndex >= 0) this.selectedIndex = refreshedIndex;
         }
         this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.runs.length - 1));
         if (this.notice && Date.now() - this.noticeTime > 3500) this.notice = undefined;
         this.tui.requestRender();
      } catch {
         // Ignore refresh races during shutdown.
      }
   }

   private close(result: DashboardPickResult | null = null): void {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.ticker);
      this.done(result);
   }

   private selectedRun(): Task | undefined {
      return this.runs[this.selectedIndex];
   }

   private async copyRunTranscript(run: Task): Promise<void> {
      const transcript = run.transcript ?? (run.sessionFile ? readPiSessionTranscript(run.sessionFile) : []);
      await copyToClipboard(buildCopiedTranscriptPayload(run, transcript));
      this.notice = `Copied run transcript for ${run.name ?? run.id}`;
      this.noticeTime = Date.now();
      this.tui.requestRender();
   }

   private async copyRunPath(run: Task): Promise<void> {
      const sessionPath = run.sessionFile ? path.resolve(run.sessionFile) : run.cwd ? path.resolve(run.cwd) : undefined;
      if (!sessionPath) return;
      await copyToClipboard(sessionPath);
      this.notice = `Copied path: ${sessionPath}`;
      this.noticeTime = Date.now();
      this.tui.requestRender();
   }

   handleInput(data: string): void {
      const up = matchesWorkflowDirection(data, "up", this.keybindings) || data === "k";
      const down = matchesWorkflowDirection(data, "down", this.keybindings) || data === "j";
      const confirm = matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm");
      const cancel = matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel");
      const run = this.selectedRun();

      if (up) {
         this.selectedIndex = moveWorkerRunSelection(this.selectedIndex, -1, this.runs.length);
      } else if (down) {
         this.selectedIndex = moveWorkerRunSelection(this.selectedIndex, 1, this.runs.length);
      } else if (data === "g") {
         this.selectedIndex = 0;
      } else if (data === "G") {
         this.selectedIndex = Math.max(0, this.runs.length - 1);
      } else if (confirm && run) {
         this.close({ type: "takeover", taskId: run.id });
         return;
      } else if (cancel || data === "q") {
         this.close();
         return;
      } else if (data === "p" && run) {
         void runTool(
            this.runtime,
            WorkerManager.use((manager) => manager.recoverTask(run.id))
         )
            .then(() => {
               this.notice = `Recovering ${run.name ?? run.id} in place`;
               this.noticeTime = Date.now();
               void this.refresh();
            })
            .catch(() => {});
      } else if ((data === "c" || data === "r") && run) {
         void runTool(
            this.runtime,
            WorkerManager.use((manager) => manager.recoverTask(run.id))
         )
            .then(() => {
               this.notice = `Recovering ${run.name ?? run.id} in place`;
               this.noticeTime = Date.now();
               void this.refresh();
            })
            .catch(() => {});
      } else if (data === "x" && run) {
         void runTool(
            this.runtime,
            WorkerManager.use((manager) => manager.cancelTask(run.id))
         )
            .then(() => {
               this.notice = `Cancelled ${run.name ?? run.id}`;
               this.noticeTime = Date.now();
               void this.refresh();
            })
            .catch(() => {});
      } else if (data === "s" && run) {
         void this.copyRunTranscript(run).catch(() => {});
      } else if (data === "y" && run) {
         void this.copyRunPath(run).catch(() => {});
      }

      this.tui.requestRender();
   }

   render(width: number): string[] {
      const rows = this.tui.terminal.rows || 30;
      const innerWidth = Math.max(1, width - 2);
      const helpText = `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk: select · Enter: inspect run · r: recover · s: copy transcript · y: copy path · x: cancel run · Esc: close`;
      const helpLines = wrapTextWithAnsi(this.theme.fg("dim", helpText), Math.max(1, width));
      const bodyHeight = Math.max(1, rows - 4 - Math.max(1, helpLines.length));
      const activeRuns = this.runs.filter((run) => run.status === "running" || run.status === "pending").length;
      const headerLeft = this.theme.fg("accent", this.theme.bold("Worker Runs"));
      const headerRight =
         this.notice && Date.now() - this.noticeTime < 3500
            ? this.theme.fg("success", this.theme.bold(this.notice))
            : this.theme.fg("muted", `${this.runs.length} run${this.runs.length === 1 ? "" : "s"}`);
      const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
      const lines = [truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width)];
      const divider = this.theme.fg("border", "│");
      const title = `Runs (${activeRuns}/${this.runs.length})`;
      lines.push(this.theme.fg("border", "╭") + this.borderSegment(innerWidth, title) + this.theme.fg("border", "╮"));
      const runRows = this.renderRunRows(innerWidth, bodyHeight);
      for (let index = 0; index < bodyHeight; index++) {
         lines.push(divider + this.pad(runRows[index] ?? "", innerWidth) + divider);
      }
      lines.push(
         this.theme.fg("border", "╰") +
            this.theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
            this.theme.fg("border", "╯")
      );
      lines.push(...helpLines);
      return lines;
   }

   private renderRunRows(width: number, height: number): string[] {
      if (height <= 0) return [];
      if (this.runs.length === 0) return [this.theme.fg("dim", "  (no worker runs)")];

      const selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.runs.length - 1));
      const start =
         this.runs.length > height
            ? Math.min(Math.max(0, selectedIndex - Math.floor(height / 2)), this.runs.length - height)
            : 0;
      const now = Date.now();
      return this.runs.slice(start, start + height).map((run, offset) => {
         const index = start + offset;
         const selected = index === selectedIndex;
         const marker = selected ? this.theme.fg("accent", "❯") : " ";
         const titleText = run.name ?? run.promptOrCommand.slice(0, 35);
         const title = selected ? this.theme.fg("accent", titleText) : this.theme.fg("text", titleText);
         const worker = run.worker ? this.theme.fg("dim", ` · ${run.worker}`) : "";
         const left = ` ${marker} ${statusGlyph(run.status, this.theme)} ${title}${worker} ${this.theme.fg("dim", run.id)}`;
         const elapsedMs = run.settledAt
            ? run.settledAt - (run.startedAt ?? run.createdAt)
            : now - (run.startedAt ?? run.createdAt);
         const right = `${this.theme.fg("muted", formatDuration(elapsedMs))} · ${statusWord(run.status, this.theme)} `;
         const leftMax = Math.max(0, width - visibleWidth(right) - 2);
         const leftTruncated = truncateToWidth(left, leftMax);
         const gap = Math.max(2, width - visibleWidth(leftTruncated) - visibleWidth(right));
         return truncateToWidth(leftTruncated + " ".repeat(gap) + right, width);
      });
   }

   private borderSegment(width: number, title: string): string {
      const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 3))} ` : "";
      const labelWidth = visibleWidth(label);
      return (
         this.theme.fg("border", "─") +
         (label ? this.theme.fg("text", label) : "") +
         this.theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
      );
   }

   private pad(text: string, width: number): string {
      const truncated = truncateToWidth(text, width);
      return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
   }

   invalidate(): void {}

   dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.closed = true;
      clearInterval(this.ticker);
   }
}

interface RunsDashboardChild extends Component {
   handleInput(data: string): void;
   dispose?(): void;
   isListView?(): boolean;
}

class RunsDashboard implements RunsDashboardChild, Focusable {
   private activeTab: RunsDashboardTab;
   private readonly workflow: WorkflowDashboard;
   private readonly workers: WorkerRunsView;
   private _focused = false;
   private finished = false;
   private disposed = false;

   get focused(): boolean {
      return this._focused;
   }

   set focused(value: boolean) {
      this._focused = value;
      this.workers.focused = this.activeTab === "worker" && value;
   }

   constructor(
      private readonly tui: TUI,
      private readonly theme: Theme,
      private readonly keybindings: KeybindingsManager,
      private readonly options: RunsDashboardOptions,
      private readonly done: (result: DashboardPickResult | null) => void
   ) {
      this.activeTab = options.initialTab ?? "workflow";
      this.workflow = new WorkflowDashboard(
         tui,
         theme,
         keybindings,
         options.workflow.getActive,
         options.workflow.sessionId,
         options.workflow.referencedRunIds,
         () => this.finish(null),
         options.workflow.initialRunId,
         options.workflow.getActiveAgentSession,
         options.workflow.abortActiveAgent,
         options.workflow.getAvailableModels,
         options.workflow.abortWorkflow,
         options.workflow.openWorkflowSettings
      );
      this.workers = new WorkerRunsView(
         tui,
         theme,
         keybindings,
         options.workerRuntime,
         (result) => this.finish(result),
         options.lastViewedWorker
      );
   }

   private child(): RunsDashboardChild {
      return this.activeTab === "workflow" ? this.workflow : this.workers;
   }

   private finish(result: DashboardPickResult | null): void {
      if (this.finished) return;
      this.finished = true;
      this.done(result);
   }

   handleInput(data: string): void {
      if (matchesKey(data, Key.tab)) {
         if (this.activeTab === "workflow" && !this.workflow.isListView()) {
            this.child().handleInput(data);
            return;
         }
         this.activeTab = nextRunsDashboardTab(this.activeTab);
         this.workers.focused = this.activeTab === "worker" && this._focused;
         this.tui.requestRender(true);
         return;
      }
      this.child().handleInput(data);
   }

   render(width: number): string[] {
      const lines = this.child().render(width);
      if (this.activeTab === "workflow" && !this.workflow.isListView()) {
         return lines;
      }
      const tabLabel =
         this.activeTab === "workflow"
            ? this.theme.fg("accent", "WF workflow runs")
            : this.theme.fg("accent", "WR worker runs");
      if (lines.length > 0) lines[0] = truncateToWidth(`${tabLabel} · Tab switch · ${lines[0]}`, width, "");
      return lines;
   }

   invalidate(): void {
      this.child().invalidate();
   }

   dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.workflow.dispose?.();
      this.workers.dispose();
   }
}

async function openRunsDashboard(
   ctx: ExtensionContext,
   options: RunsDashboardOptions
): Promise<DashboardPickResult | null> {
   let dashboard: RunsDashboard | undefined;
   let releaseAlternateScreen: (() => void) | undefined;
   try {
      return await ctx.ui.custom<DashboardPickResult | null>(
         (tui, theme, keybindings, done) => {
            dashboard = new RunsDashboard(tui, theme, keybindings, options, done);
            releaseAlternateScreen = enterWorkflowAlternateScreen(tui, keybindings, dashboard);
            return dashboard;
         },
         { overlay: false }
      );
   } finally {
      dashboard?.dispose();
      releaseAlternateScreen?.();
   }
}

export async function showRunsDashboard(ctx: ExtensionContext, options: RunsDashboardOptions): Promise<void> {
   if (!ctx.hasUI) return;
   let initialTab = options.initialTab ?? "workflow";
   let lastViewedWorker = options.lastViewedWorker;
   while (true) {
      const picked = await openRunsDashboard(ctx, { ...options, initialTab, lastViewedWorker });
      if (!picked) return;
      await openTaskTakeover(ctx as any, options.workerRuntime, picked.taskId);
      initialTab = "worker";
      lastViewedWorker = picked;
   }
}
