/**
 * Real Full-screen TUI dashboard and pure state machine for /workers.
 */

import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Job, ProcessEntry } from "../domain.js";
import type { WorkersRuntime } from "../extension.js";
import { runTool } from "../runtime.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { WorkerManager } from "../services/WorkerManager.js";
import { enterAlternateScreen } from "./alternate-screen.js";
import { formatDuration } from "./formatters.js";
import { openJobTakeover } from "./takeover.js";
import { openProcessDetail } from "./process-detail.js";

export type DashboardTab = "jobs" | "bash" | "processes" | "logs" | "takeover";

export interface WorkersDashboardState {
   activeTab: DashboardTab;
   selectedIndex: number;
   isOpen: boolean;
   takeoverJobId?: string;
   logProcessName?: string;
   takeoverInput?: string;
}

export interface KeyInput {
   key: string;
   shift?: boolean;
   alt?: boolean;
   ctrl?: boolean;
}

export interface DashboardContext {
   itemCount?: number;
   jobs?: Array<{ id: string; [key: string]: any }>;
   processes?: Array<{ name: string | null; [key: string]: any }>;
   inputText?: string;
}

export type DashboardIntent =
   | { type: "takeover_control"; id: string; text: string; mode: "steer" | "followUp" }
   | { type: "cancel_job"; id: string }
   | { type: "stop_process"; name: string }
   | { type: "restart_process"; name: string }
   | { type: "close" }
   | { type: "none" };

export const DASHBOARD_TABS: DashboardTab[] = ["jobs", "bash", "processes", "logs", "takeover"];

export function createWorkersDashboardState(initial?: Partial<WorkersDashboardState>): WorkersDashboardState {
   return {
      activeTab: "jobs",
      selectedIndex: 0,
      isOpen: true,
      ...initial
   };
}

export function computeWorkersDashboardBodyHeight(terminalRows: number, helpLineCount = 1): number {
   const fixedLineCount = 4 + Math.max(1, helpLineCount);
   return Math.max(1, terminalRows - fixedLineCount);
}

export function computeWorkersDashboardPaneHeights(bodyHeight: number): { jobs: number; processes: number } {
   const total = Math.max(1, bodyHeight);
   return {
      jobs: Math.ceil(total / 2),
      processes: Math.floor(total / 2)
   };
}

export function wrapDashboardHelp(text: string, width: number, theme: Theme): string[] {
   return wrapTextWithAnsi(theme.fg("dim", text), Math.max(1, width));
}

export function requestControl(id: string, text: string, mode: "steer" | "followUp") {
   return { id, text, mode };
}

export function reduceWorkersDashboardKey(
   state: WorkersDashboardState,
   input: KeyInput,
   context?: DashboardContext
): { state: WorkersDashboardState; intent?: DashboardIntent } {
   const key = input.key.toLowerCase();

   if (key === "escape" || key === "q") {
      return {
         state: { ...state, isOpen: false },
         intent: { type: "close" }
      };
   }

   if (key === "tab") {
      const jobsFocused = state.activeTab === "jobs" || state.activeTab === "takeover";
      return {
         state: {
            ...state,
            activeTab: jobsFocused ? "processes" : "jobs",
            selectedIndex: 0
         }
      };
   }

   if (key === "down" || key === "j") {
      let maxCount = context?.itemCount;
      if (maxCount === undefined) {
         if ((state.activeTab === "jobs" || state.activeTab === "takeover") && context?.jobs) {
            maxCount = context.jobs.length;
         } else if (
            (state.activeTab === "processes" || state.activeTab === "bash" || state.activeTab === "logs") &&
            context?.processes
         ) {
            maxCount = context.processes.length;
         }
      }
      const nextIndex =
         maxCount !== undefined && maxCount > 0
            ? Math.min(state.selectedIndex + 1, maxCount - 1)
            : state.selectedIndex + 1;
      return {
         state: { ...state, selectedIndex: nextIndex }
      };
   }

   if (key === "up" || key === "k") {
      return {
         state: { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) }
      };
   }

   if (key === "enter") {
      if (input.alt) {
         if (state.activeTab === "jobs" && context?.jobs && context.jobs[state.selectedIndex]) {
            const job = context.jobs[state.selectedIndex];
            return {
               state,
               intent: {
                  type: "takeover_control",
                  id: job.id,
                  text: context.inputText ?? state.takeoverInput ?? "",
                  mode: "followUp"
               }
            };
         }
      } else {
         if (state.activeTab === "jobs") {
            const job = context?.jobs?.[state.selectedIndex];
            if (job) {
               return {
                  state: {
                     ...state,
                     activeTab: "takeover",
                     takeoverJobId: job.id
                  }
               };
            }
         } else if (state.activeTab === "processes" || state.activeTab === "bash") {
            const proc = context?.processes?.[state.selectedIndex];
            if (proc) {
               return {
                  state: {
                     ...state,
                     activeTab: "logs",
                     logProcessName: proc.name ?? proc.id
                  }
               };
            }
         } else if (state.activeTab === "takeover") {
            const jobId = state.takeoverJobId;
            const text = context?.inputText ?? state.takeoverInput ?? "";
            if (jobId) {
               return {
                  state,
                  intent: {
                     type: "takeover_control",
                     id: jobId,
                     text,
                     mode: "steer"
                  }
               };
            }
         }
      }
   }

   if (key === "c" || key === "x") {
      if (state.activeTab === "jobs" && context?.jobs && context.jobs[state.selectedIndex]) {
         return {
            state,
            intent: { type: "cancel_job", id: context.jobs[state.selectedIndex].id }
         };
      }
      if (
         (state.activeTab === "processes" || state.activeTab === "bash") &&
         context?.processes &&
         context.processes[state.selectedIndex]
      ) {
         const proc = context.processes[state.selectedIndex];
         return {
            state,
            intent: { type: "stop_process", name: proc.name ?? proc.id }
         };
      }
   }

   if (key === "r") {
      if (
         (state.activeTab === "processes" || state.activeTab === "bash") &&
         context?.processes &&
         context.processes[state.selectedIndex]
      ) {
         const proc = context.processes[state.selectedIndex];
         return {
            state,
            intent: { type: "restart_process", name: proc.name ?? proc.id }
         };
      }
   }

   return { state };
}

export type DashboardPickResult = { type: "takeover"; jobId: string } | { type: "process_detail"; procName: string };

function configuredKeys(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
   return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(status: string, theme: Theme): string {
   switch (status) {
      case "running":
      case "starting":
      case "pending":
         return theme.fg("warning", "■");
      case "completed":
      case "done":
      case "exited":
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
      case "starting":
         return theme.fg("warning", status);
      case "completed":
      case "done":
      case "exited":
         return theme.fg("success", status);
      case "failed":
      case "cancelled":
         return theme.fg("error", status);
      default:
         return theme.fg("muted", status);
   }
}

export class WorkersDashboardScreen implements Component, Focusable {
   private state: WorkersDashboardState;
   private input = new Input();
   private closed = false;
   private _focused = false;
   private ticker: ReturnType<typeof setInterval>;

   private jobs: Job[] = [];
   private processes: ProcessEntry[] = [];

   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      this.input.focused = value;
   }

   constructor(
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private runtime: WorkersRuntime,
      private done: (value: DashboardPickResult | null) => void,
      initialState?: Partial<WorkersDashboardState>
   ) {
      this.state = createWorkersDashboardState(initialState);
      this.ticker = setInterval(() => {
         void this.refreshData();
      }, 500);
      void this.refreshData();
   }

   private async refreshData() {
      if (this.closed) return;
      try {
         const jobs = await runTool(
            this.runtime,
            JobRegistry.use((r) => r.list())
         );
         const procs = await runTool(
            this.runtime,
            ProcessSupervisor.use((s) => s.ps)
         );
         this.jobs = [...jobs];
         this.processes = [...procs];
         this.tui.requestRender();
      } catch {
         // ignore fetch errors
      }
   }

   private cleanup() {
      if (this.closed) return false;
      this.closed = true;
      clearInterval(this.ticker);
      return true;
   }

   private close(result: DashboardPickResult | null = null) {
      if (this.cleanup()) this.done(result);
   }

   dispose(): void {
      this.cleanup();
   }

   handleInput(data: string): void {
      let isAltEnter = data === "\u001b\r" || data === "\u001b\n";
      let key = data.toLowerCase();
      if (data === "\r" || data === "\n") key = "enter";
      else if (data === "\u001b") key = "escape";
      else if (data === "\t") key = "tab";
      else if (data === "\u001b[A") key = "up";
      else if (data === "\u001b[B") key = "down";
      else if (data === "\u001b[C") key = "right";
      else if (data === "\u001b[D") key = "left";

      const keyInput: KeyInput = {
         key,
         alt: isAltEnter,
         shift: data === "\u001b[Z",
         ctrl: false
      };

      const context: DashboardContext = {
         jobs: this.jobs,
         processes: this.processes
      };

      const res = reduceWorkersDashboardKey(this.state, keyInput, context);
      this.state = res.state;

      if (res.intent) {
         const intent = res.intent;
         if (intent.type === "close") {
            this.close(null);
            return;
         } else if (intent.type === "cancel_job") {
            void runTool(
               this.runtime,
               WorkerManager.use((s) => s.cancelJob(intent.id))
            ).catch(() => {});
            void this.refreshData();
            return;
         } else if (intent.type === "stop_process") {
            void runTool(
               this.runtime,
               ProcessSupervisor.use((s) => s.stop(intent.name))
            ).catch(() => {});
            void this.refreshData();
            return;
         } else if (intent.type === "restart_process") {
            void runTool(
               this.runtime,
               ProcessSupervisor.use((s) => s.restart(intent.name))
            ).catch(() => {});
            void this.refreshData();
            return;
         } else if (intent.type === "takeover_control") {
            void runTool(
               this.runtime,
               WorkerManager.use((s) => s.controlJob(intent.id, intent.text, intent.mode))
            ).catch(() => {});
            this.close({ type: "takeover", jobId: intent.id });
            return;
         }
      }

      if (key === "enter") {
         if (this.state.activeTab === "jobs" || this.state.activeTab === "takeover") {
            const job = this.jobs[this.state.selectedIndex];
            if (job) {
               this.close({ type: "takeover", jobId: job.id });
               return;
            }
         } else if (
            this.state.activeTab === "processes" ||
            this.state.activeTab === "bash" ||
            this.state.activeTab === "logs"
         ) {
            const proc = this.processes[this.state.selectedIndex];
            if (proc) {
               this.close({ type: "process_detail", procName: proc.name ?? proc.id });
               return;
            }
         }
      }

      this.tui.requestRender();
   }

   private borderSegment(width: number, title: string): string {
      const theme = this.theme;
      const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 3))} ` : "";
      const labelWidth = visibleWidth(label);
      return (
         theme.fg("border", "─") +
         (label ? theme.fg("text", label) : "") +
         theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
      );
   }

   private pad(text: string, width: number): string {
      const truncated = truncateToWidth(text, width);
      return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
   }

   render(width: number): string[] {
      const theme = this.theme;
      const rows = this.tui.terminal.rows || 30;
      const innerWidth = width - 2;
      const helpText = `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk: select · Tab: focus pane · Enter: inspect · x: cancel/stop · r: restart · Esc: close`;
      const helpLines = wrapDashboardHelp(helpText, width, theme);
      const bodyHeight = computeWorkersDashboardBodyHeight(rows, helpLines.length);
      const paneHeights = computeWorkersDashboardPaneHeights(bodyHeight);

      const lines: string[] = [];

      const activeJobs = this.jobs.filter((j) => j.status === "running" || j.status === "pending").length;
      const activeProcs = this.processes.filter((p) => p.status === "running" || p.status === "starting").length;

      const headerLeft = theme.fg("accent", theme.bold("Workers /workers Dashboard"));
      const headerRight = theme.fg(
         "muted",
         `${this.jobs.length} job${this.jobs.length === 1 ? "" : "s"} · ${this.processes.length} process${this.processes.length === 1 ? "" : "es"}`
      );
      const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
      lines.push(truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));

      const jobsFocused = this.state.activeTab === "jobs" || this.state.activeTab === "takeover";
      const divider = theme.fg("border", "│");
      const jobsTitle = `Jobs (${activeJobs}/${this.jobs.length})`;
      const processesTitle = `Processes (${activeProcs}/${this.processes.length})`;

      lines.push(theme.fg("border", "╭") + this.borderSegment(innerWidth, jobsTitle) + theme.fg("border", "╮"));
      const jobRows = this.renderJobRows(innerWidth, paneHeights.jobs, jobsFocused);
      for (let i = 0; i < paneHeights.jobs; i++) {
         lines.push(divider + this.pad(jobRows[i] ?? "", innerWidth) + divider);
      }

      lines.push(theme.fg("border", "├") + this.borderSegment(innerWidth, processesTitle) + theme.fg("border", "┤"));
      const processRows = this.renderProcessRows(innerWidth, paneHeights.processes, !jobsFocused);
      for (let i = 0; i < paneHeights.processes; i++) {
         lines.push(divider + this.pad(processRows[i] ?? "", innerWidth) + divider);
      }

      lines.push(
         theme.fg("border", "╰") + theme.fg("border", "─".repeat(Math.max(0, innerWidth))) + theme.fg("border", "╯")
      );

      lines.push(...helpLines);

      return lines;
   }

   private renderJobRows(width: number, height: number, focused = true): string[] {
      const theme = this.theme;
      const out: string[] = [];

      if (height <= 0) return out;
      if (this.jobs.length === 0) {
         out.push(theme.fg("dim", "  (no active or historical jobs)"));
         return out;
      }

      const selectedIndex = Math.max(0, Math.min(this.state.selectedIndex, this.jobs.length - 1));
      if (focused) this.state.selectedIndex = selectedIndex;

      let start = 0;
      if (this.jobs.length > height) {
         start = Math.min(Math.max(0, selectedIndex - Math.floor(height / 2)), this.jobs.length - height);
      }
      const visible = this.jobs.slice(start, start + height);
      const now = Date.now();

      for (let i = 0; i < visible.length; i++) {
         const job = visible[i];
         const index = start + i;
         const isSelected = focused && index === selectedIndex;

         const marker = isSelected ? theme.fg("accent", "❯") : " ";
         const titleText = job.name ?? job.promptOrCommand.slice(0, 35);
         const title = isSelected ? theme.fg("accent", titleText) : theme.fg("text", titleText);
         const harnessStr = job.harness ? theme.fg("dim", ` · ${job.agent ?? "worker"} (${job.harness})`) : "";
         const left = ` ${marker} ${statusGlyph(job.status, theme)} ${title}${harnessStr} ${theme.fg("dim", job.id)}`;

         const elapsedMs = job.settledAt
            ? job.settledAt - (job.startedAt ?? job.createdAt)
            : now - (job.startedAt ?? job.createdAt);
         const durationStr = formatDuration(elapsedMs);

         const dot = theme.fg("dim", " · ");
         const rightParts = [
            theme.fg("muted", job.origin ?? "worker"),
            theme.fg("muted", durationStr),
            statusWord(job.status, theme)
         ];
         const right = `${rightParts.join(dot)} `;

         const rightWidth = visibleWidth(right);
         const leftMax = Math.max(0, width - rightWidth - 2);
         const leftTruncated = truncateToWidth(left, leftMax);
         const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
         out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
      }

      return out;
   }

   private renderProcessRows(width: number, height: number, focused = true): string[] {
      const theme = this.theme;
      const out: string[] = [];

      if (height <= 0) return out;
      if (this.processes.length === 0) {
         out.push(theme.fg("dim", "  (no background processes)"));
         return out;
      }

      const selectedIndex = Math.max(0, Math.min(this.state.selectedIndex, this.processes.length - 1));
      if (focused) this.state.selectedIndex = selectedIndex;

      let start = 0;
      if (this.processes.length > height) {
         start = Math.min(Math.max(0, selectedIndex - Math.floor(height / 2)), this.processes.length - height);
      }
      const visible = this.processes.slice(start, start + height);
      const now = Date.now();

      for (let i = 0; i < visible.length; i++) {
         const proc = visible[i];
         const index = start + i;
         const isSelected = focused && index === selectedIndex;

         const marker = isSelected ? theme.fg("accent", "❯") : " ";
         const titleText = proc.name ?? proc.id;
         const title = isSelected ? theme.fg("accent", titleText) : theme.fg("text", titleText);
         const left = ` ${marker} ${statusGlyph(proc.status, theme)} ${title} ${theme.fg("dim", proc.command.slice(0, 30))}`;

         const elapsedMs = proc.settledAt ? proc.settledAt - proc.spawnTime : now - proc.spawnTime;
         const durationStr = formatDuration(elapsedMs);

         const dot = theme.fg("dim", " · ");
         const rightParts = [
            theme.fg("muted", `PID:${proc.pid ?? "?"}`),
            theme.fg("muted", durationStr),
            statusWord(proc.status, theme)
         ];
         const right = `${rightParts.join(dot)} `;

         const rightWidth = visibleWidth(right);
         const leftMax = Math.max(0, width - rightWidth - 2);
         const leftTruncated = truncateToWidth(left, leftMax);
         const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
         out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
      }

      return out;
   }

   invalidate(): void {
      this.input.invalidate();
   }
}

export async function openWorkersDashboard(ctx: ExtensionCommandContext, runtime: WorkersRuntime): Promise<void> {
   if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") return;

   const selectionState: Partial<WorkersDashboardState> = { activeTab: "jobs", selectedIndex: 0 };

   async function iterate(): Promise<void> {
      let releaseAlternateScreen: (() => void) | undefined;
      let picked: DashboardPickResult | null;
      try {
         picked = await ctx.ui.custom<DashboardPickResult | null>(
            (tui, theme, keybindings, done) => {
               const screen = new WorkersDashboardScreen(tui, theme, keybindings, runtime, done, selectionState);
               releaseAlternateScreen = enterAlternateScreen(tui, screen);
               return screen;
            },
            { overlay: false }
         );
      } finally {
         releaseAlternateScreen?.();
      }

      if (!picked) return;

      if (picked.type === "takeover" && picked.jobId) {
         await openJobTakeover(ctx, runtime, picked.jobId);
      } else if (picked.type === "process_detail" && picked.procName) {
         await openProcessDetail(ctx, runtime, picked.procName);
      }

      return iterate();
   }

   await iterate();
}
