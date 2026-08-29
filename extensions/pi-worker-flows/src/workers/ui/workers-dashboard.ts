/**
 * Full-screen TUI dashboard and pure state machine for direct workers.
 */

import * as path from "node:path";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Task } from "../domain.js";
import type { WorkersRuntime } from "../extension.js";
import { runTool } from "../runtime.js";
import { TaskRegistry } from "../services/task-registry.js";
import { WorkerManager } from "../services/worker-manager.js";
import { enterAlternateScreen } from "../../shared/alternate-screen.ts";
import { copyToClipboard } from "../../shared/clipboard.ts";
import { formatDuration } from "./formatters.js";
import { buildCopiedTranscriptPayload, openTaskTakeover } from "./takeover.js";
import { readPiSessionTranscript } from "./session-transcript.js";

export type DashboardTab = "tasks" | "takeover";

export interface WorkersDashboardState {
   activeTab: DashboardTab;
   selectedIndex: number;
   isOpen: boolean;
   takeoverTaskId?: string;
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
   tasks?: Array<{ id: string; [key: string]: any }>;
   inputText?: string;
}

export type DashboardIntent =
   | { type: "open_takeover"; id: string }
   | { type: "takeover_control"; id: string; text: string; mode: "steer" | "followUp" }
   | { type: "recover_task"; id: string }
   | { type: "cancel_task"; id: string }
   | { type: "copy_transcript"; id: string }
   | { type: "copy_path"; path: string }
   | { type: "close" }
   | { type: "none" };

export const DASHBOARD_TABS: DashboardTab[] = ["tasks", "takeover"];

export function wrapIndex(index: number, delta: number, length: number): number {
   if (length <= 0) return 0;
   return (((index + delta) % length) + length) % length;
}

export function createWorkersDashboardState(initial?: Partial<WorkersDashboardState>): WorkersDashboardState {
   return {
      activeTab: "tasks",
      selectedIndex: 0,
      isOpen: true,
      ...initial
   };
}

export function computeWorkersDashboardBodyHeight(terminalRows: number, helpLineCount = 1): number {
   const fixedLineCount = 4 + Math.max(1, helpLineCount);
   return Math.max(1, terminalRows - fixedLineCount);
}

export function computeWorkersDashboardPaneHeights(bodyHeight: number): { tasks: number } {
   return { tasks: Math.max(1, bodyHeight) };
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
   const taskCount = context?.itemCount ?? context?.tasks?.length ?? 0;

   if (key === "escape" || key === "q") {
      return {
         state: { ...state, isOpen: false },
         intent: { type: "close" }
      };
   }

   if (key === "tab") {
      return {
         state: {
            ...state,
            activeTab: state.activeTab === "tasks" ? "takeover" : "tasks",
            selectedIndex: 0
         }
      };
   }

   if (key === "down" || key === "j") {
      return {
         state: {
            ...state,
            selectedIndex: taskCount > 0 ? wrapIndex(state.selectedIndex, 1, taskCount) : state.selectedIndex + 1
         }
      };
   }

   if (key === "up" || key === "k") {
      return {
         state: {
            ...state,
            selectedIndex:
               taskCount > 0 ? wrapIndex(state.selectedIndex, -1, taskCount) : Math.max(0, state.selectedIndex - 1)
         }
      };
   }

   if (key === "enter") {
      if (input.alt && state.activeTab === "tasks" && context?.tasks?.[state.selectedIndex]) {
         const task = context.tasks[state.selectedIndex];
         return {
            state,
            intent: {
               type: "takeover_control",
               id: task.id,
               text: context.inputText ?? state.takeoverInput ?? "",
               mode: "followUp"
            }
         };
      }

      if (state.activeTab === "tasks") {
         const task = context?.tasks?.[state.selectedIndex];
         return task ? { state, intent: { type: "open_takeover", id: task.id } } : { state };
      }

      const taskId = state.takeoverTaskId;
      if (taskId) {
         return {
            state,
            intent: {
               type: "takeover_control",
               id: taskId,
               text: context?.inputText ?? state.takeoverInput ?? "",
               mode: "steer"
            }
         };
      }
   }

   if (key === "r" && context?.tasks?.[state.selectedIndex]) {
      return {
         state,
         intent: { type: "recover_task", id: context.tasks[state.selectedIndex].id }
      };
   }

   if (key === "x" && context?.tasks?.[state.selectedIndex]) {
      return {
         state,
         intent: { type: "cancel_task", id: context.tasks[state.selectedIndex].id }
      };
   }

   if (key === "s" && context?.tasks?.[state.selectedIndex]) {
      return {
         state,
         intent: { type: "copy_transcript", id: context.tasks[state.selectedIndex].id }
      };
   }

   if (key === "y" && context?.tasks?.[state.selectedIndex]) {
      const task = context.tasks[state.selectedIndex];
      const sessionPath = task.sessionFile
         ? path.resolve(task.sessionFile)
         : task.cwd
           ? path.resolve(task.cwd)
           : undefined;
      if (sessionPath) {
         return {
            state,
            intent: { type: "copy_path", path: sessionPath }
         };
      }
   }

   return { state };
}

export type DashboardPickResult = { type: "takeover"; taskId: string };

function configuredKeys(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
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

export class WorkersDashboardScreen implements Component, Focusable {
   private state: WorkersDashboardState;
   private input = new Input();
   private closed = false;
   private _focused = false;
   private ticker: ReturnType<typeof setInterval>;
   private tasks: Task[] = [];
   private initialSelectionApplied = false;
   private notice?: string;
   private noticeTime = 0;

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
      initialState?: Partial<WorkersDashboardState>,
      private lastViewedItem?: DashboardPickResult | null
   ) {
      this.state = createWorkersDashboardState(initialState);
      this.ticker = setInterval(() => {
         void this.refreshData();
      }, 500);
      void this.refreshData();
   }

   private applyInitialSelection() {
      if (this.lastViewedItem) {
         const index = this.tasks.findIndex((task) => task.id === this.lastViewedItem?.taskId);
         if (index !== -1) {
            this.state.activeTab = "tasks";
            this.state.selectedIndex = index;
            return;
         }
      }

      const running = this.tasks
         .map((task, index) => ({ task, index }))
         .filter(({ task }) => task.status === "running" || task.status === "pending")
         // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target does not provide Array.prototype.toSorted.
         .sort(
            ({ task: left }, { task: right }) =>
               (right.startedAt ?? right.createdAt) - (left.startedAt ?? left.createdAt)
         )[0];
      if (running) {
         this.state.activeTab = "tasks";
         this.state.selectedIndex = running.index;
      }
   }

   private async refreshData() {
      if (this.closed) return;
      try {
         const tasks = await runTool(
            this.runtime,
            TaskRegistry.use((registry) => registry.list())
         );
         this.tasks = [...tasks];
         if (!this.initialSelectionApplied) {
            this.initialSelectionApplied = true;
            this.applyInitialSelection();
         }
         this.tui.requestRender();
      } catch {
         // Ignore refresh races during shutdown.
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
      const isAltEnter = data === "\u001b\r" || data === "\u001b\n";
      let key = data.toLowerCase();
      if (data === "\r" || data === "\n") key = "enter";
      else if (data === "\u001b") key = "escape";
      else if (data === "\t") key = "tab";
      else if (data === "\u001b[A") key = "up";
      else if (data === "\u001b[B") key = "down";
      else if (data === "\u001b[C") key = "right";
      else if (data === "\u001b[D") key = "left";

      const result = reduceWorkersDashboardKey(
         this.state,
         {
            key,
            alt: isAltEnter,
            shift: data === "\u001b[Z",
            ctrl: false
         },
         {
            tasks: this.tasks
         }
      );
      this.state = result.state;

      if (result.intent) {
         const intent = result.intent;
         if (intent.type === "close") {
            this.close();
            return;
         }
         if (intent.type === "recover_task") {
            void runTool(
               this.runtime,
               WorkerManager.use((manager) => manager.recoverTask(intent.id))
            )
               .then(() => {
                  this.notice = "Worker recovering in place";
                  this.noticeTime = Date.now();
                  void this.refreshData();
               })
               .catch(() => {});
            return;
         }
         if (intent.type === "cancel_task") {
            void runTool(
               this.runtime,
               WorkerManager.use((manager) => manager.cancelTask(intent.id))
            ).catch(() => {});
            void this.refreshData();
            return;
         }
         if (intent.type === "copy_path") {
            void copyToClipboard(intent.path);
            this.notice = `Copied path: ${intent.path}`;
            this.noticeTime = Date.now();
            this.tui.requestRender();
            return;
         }
         if (intent.type === "copy_transcript") {
            void this.copyTranscriptForTask(intent.id);
            return;
         }
         if (intent.type === "open_takeover") {
            this.close({ type: "takeover", taskId: intent.id });
            return;
         }
         if (intent.type === "takeover_control") {
            // Takeover input resumes the selected task's session with the typed text.
            void runTool(
               this.runtime,
               WorkerManager.use((manager) => manager.recoverTask(intent.id, { note: intent.text }))
            ).catch(() => {});
            this.close({ type: "takeover", taskId: intent.id });
            return;
         }
      }

      if (key === "enter" && this.state.activeTab === "tasks") {
         const task = this.tasks[this.state.selectedIndex];
         if (task) this.close({ type: "takeover", taskId: task.id });
      }

      this.tui.requestRender();
   }

   private async copyTranscriptForTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;
      const transcript = task.transcript ?? (task.sessionFile ? readPiSessionTranscript(task.sessionFile) : []);
      await copyToClipboard(buildCopiedTranscriptPayload(task, transcript));
      this.notice = `Copied run transcript for ${task.name ?? taskId}`;
      this.noticeTime = Date.now();
      void this.refreshData();
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

   render(width: number): string[] {
      const rows = this.tui.terminal.rows || 30;
      const innerWidth = width - 2;
      const helpText = `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk: select · Enter: inspect task · r: recover · s: copy transcript · y: copy path · x: cancel task · Esc: close`;
      const helpLines = wrapDashboardHelp(helpText, width, this.theme);
      const bodyHeight = computeWorkersDashboardBodyHeight(rows, helpLines.length);
      const paneHeights = computeWorkersDashboardPaneHeights(bodyHeight);
      const activeTasks = this.tasks.filter((task) => task.status === "running" || task.status === "pending").length;
      const showNotice = this.notice && Date.now() - this.noticeTime < 3500;
      const headerLeft = this.theme.fg("accent", this.theme.bold("Worker Runs"));
      const headerRight = showNotice
         ? this.theme.fg("success", this.theme.bold(this.notice!))
         : this.theme.fg("muted", `${this.tasks.length} run${this.tasks.length === 1 ? "" : "s"}`);
      const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
      const lines = [truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width)];
      const divider = this.theme.fg("border", "│");
      const title = `Tasks (${activeTasks}/${this.tasks.length})`;
      lines.push(this.theme.fg("border", "╭") + this.borderSegment(innerWidth, title) + this.theme.fg("border", "╮"));
      const taskRows = this.renderTaskRows(innerWidth, paneHeights.tasks, this.state.activeTab === "tasks");
      for (let index = 0; index < paneHeights.tasks; index++) {
         lines.push(divider + this.pad(taskRows[index] ?? "", innerWidth) + divider);
      }
      lines.push(
         this.theme.fg("border", "╰") +
            this.theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
            this.theme.fg("border", "╯")
      );
      lines.push(...helpLines);
      return lines;
   }

   private renderTaskRows(width: number, height: number, focused = true): string[] {
      if (height <= 0) return [];
      if (this.tasks.length === 0) return [this.theme.fg("dim", "  (no worker runs)")];

      const selectedIndex = Math.max(0, Math.min(this.state.selectedIndex, this.tasks.length - 1));
      if (focused) this.state.selectedIndex = selectedIndex;
      const start =
         this.tasks.length > height
            ? Math.min(Math.max(0, selectedIndex - Math.floor(height / 2)), this.tasks.length - height)
            : 0;
      const visible = this.tasks.slice(start, start + height);
      const now = Date.now();

      return visible.map((task, offset) => {
         const index = start + offset;
         const selected = focused && index === selectedIndex;
         const marker = selected ? this.theme.fg("accent", "❯") : " ";
         const titleText = task.name ?? task.promptOrCommand.slice(0, 35);
         const title = selected ? this.theme.fg("accent", titleText) : this.theme.fg("text", titleText);
         const worker = task.worker ? this.theme.fg("dim", ` · ${task.worker}`) : "";
         const left = ` ${marker} ${statusGlyph(task.status, this.theme)} ${title}${worker} ${this.theme.fg("dim", task.id)}`;
         const elapsedMs = task.settledAt
            ? task.settledAt - (task.startedAt ?? task.createdAt)
            : now - (task.startedAt ?? task.createdAt);
         const right = `${this.theme.fg("muted", formatDuration(elapsedMs))} · ${statusWord(task.status, this.theme)} `;
         const leftMax = Math.max(0, width - visibleWidth(right) - 2);
         const leftTruncated = truncateToWidth(left, leftMax);
         const gap = Math.max(2, width - visibleWidth(leftTruncated) - visibleWidth(right));
         return truncateToWidth(leftTruncated + " ".repeat(gap) + right, width);
      });
   }

   invalidate(): void {
      this.input.invalidate();
   }
}

export async function openWorkersDashboard(ctx: ExtensionCommandContext, runtime: WorkersRuntime): Promise<void> {
   if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") return;

   let lastViewedItem: DashboardPickResult | null = null;
   const selectionState: Partial<WorkersDashboardState> = { activeTab: "tasks", selectedIndex: 0 };

   async function iterate(): Promise<void> {
      let releaseAlternateScreen: (() => void) | undefined;
      let picked: DashboardPickResult | null;
      try {
         picked = await ctx.ui.custom<DashboardPickResult | null>(
            (tui, theme, keybindings, done) => {
               const screen = new WorkersDashboardScreen(
                  tui,
                  theme,
                  keybindings,
                  runtime,
                  done,
                  selectionState,
                  lastViewedItem
               );
               releaseAlternateScreen = enterAlternateScreen(tui, screen);
               return screen;
            },
            { overlay: false }
         );
      } finally {
         releaseAlternateScreen?.();
      }

      if (!picked) return;
      lastViewedItem = picked;
      await openTaskTakeover(ctx, runtime, picked.taskId);
      return iterate();
   }

   await iterate();
}
