/**
 * Interactive Takeover Overlay for Workers Jobs (ported to real pi-tui overlay pattern).
 */

import { type ExtensionCommandContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Task, type TaskTranscriptEntry } from "../domain.js";
import type { WorkersRuntime } from "../extension.js";
import { enterAlternateScreen } from "../../shared/alternate-screen.ts";
import { copyToClipboard } from "../../shared/clipboard.ts";
import { runTool } from "../runtime.js";
import { TaskRegistry } from "../services/task-registry.js";
import { formatDuration } from "./formatters.js";
import { getPiSessionContextTokens, readPiSessionTranscript } from "./session-transcript.js";
import {
   buildSystemPromptRows,
   buildTranscriptRows,
   buildTranscriptSummary,
   normalizeWorkerTranscript,
   type TranscriptViewEntry
} from "../../shared/transcript-ui.ts";

function configuredKeys(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
   return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(task: Task, theme: Theme): string {
   switch (task.status) {
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

function statusWord(task: Task, theme: Theme): string {
   switch (task.status) {
      case "running":
         return theme.fg("warning", "running");
      case "pending":
         return theme.fg("warning", "pending");
      case "recoverable":
         return theme.fg("warning", "recoverable");
      case "completed":
         return theme.fg("success", "completed");
      case "failed":
         return theme.fg("error", "failed");
      case "cancelled":
         return theme.fg("muted", "cancelled");
      default:
         return theme.fg("muted", task.status);
   }
}

function formatTokens(count: number): string {
   if (count < 1000) return `${count}`;
   if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
   if (count < 1000000) return `${Math.round(count / 1000)}k`;
   return `${(count / 1000000).toFixed(1)}M`;
}

export function buildTaskHeaderLines(task: Task, width: number, theme: Theme, now: number = Date.now()): string[] {
   const elapsed = task.settledAt
      ? formatDuration(task.settledAt - (task.startedAt ?? task.createdAt))
      : formatDuration(now - (task.startedAt ?? task.createdAt));
   const title = task.name ?? task.promptOrCommand.slice(0, 30);
   const primary =
      `${statusGlyph(task, theme)} ` +
      theme.fg("accent", theme.bold(`${task.id} · ${title}`)) +
      ` · ${statusWord(task, theme)} · ${theme.fg("muted", elapsed)}`;
   const reasoningMetadata = task.thinking ? `thinking ${task.thinking}` : "thinking (inherit)";
   const contextTokens =
      task.contextTokens ?? (task.sessionFile ? getPiSessionContextTokens(task.sessionFile) : undefined);
   const metadata = [
      task.worker ? `worker ${task.worker}` : undefined,
      task.model ? `model ${task.model}` : "model (inherit)",
      reasoningMetadata,
      task.cwd ? `cwd ${task.cwd}` : undefined,
      contextTokens !== undefined ? `context ${formatTokens(contextTokens)} tokens` : "context 0 tokens"
   ].filter((value): value is string => value !== undefined);
   return [truncateToWidth(primary, width), ...wrapTextWithAnsi(theme.fg("muted", metadata.join(" · ")), width)];
}

const WORKER_TOOL_NAMES = new Set(["worker_spawn", "worker_list", "worker_recover", "worker_cancel"]);

function compactPreview(value: unknown, limit = 100): string {
   const text = typeof value === "string" ? value : JSON.stringify(value);
   const compact = text?.replace(/\s+/g, " ").trim() ?? "";
   return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function compactTaskToolResult(entry: Extract<TranscriptViewEntry, { type: "tool-result" }>): string | undefined {
   if (!entry.text) return undefined;
   try {
      const value = JSON.parse(entry.text) as Record<string, unknown>;
      if (value.ok === false) return `✗ run ${compactPreview(value.error)}`;
      const tasks = (
         Array.isArray(value.tasks)
            ? value.tasks
            : Array.isArray(value.jobs)
              ? value.jobs
              : value.task
                ? [value.task]
                : []
      ) as ReadonlyArray<Record<string, unknown>>;
      if (tasks.length > 0) {
         return tasks
            .filter((task): task is Record<string, unknown> => Boolean(task) && typeof task === "object")
            .map((task) => {
               const status = typeof task.status === "string" ? task.status : "unknown";
               const mark = status === "completed" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : "●";
               const output = compactPreview(task.errorText);
               const id = typeof task.id === "string" ? task.id : "task";
               return `${mark} ${id} ${status}${output ? ` · ${output}` : ""}`;
            })
            .join("\n");
      }
      for (const key of ["jobs", "tasks", "lines"] as const) {
         if (Array.isArray(value[key])) return `run ${key} · ${value[key].length} items`;
      }
      return "✓ run completed";
   } catch {
      return compactPreview(entry.text);
   }
}

function workerResultSummary(entry: Extract<TranscriptViewEntry, { type: "tool-result" }>): string | undefined {
   if (!WORKER_TOOL_NAMES.has(entry.toolName)) return undefined;
   const summary = compactTaskToolResult(entry);
   if (!summary) return undefined;
   if (summary.startsWith("✓") || summary.startsWith("✗")) return summary;
   return `${entry.isError ? "✗" : "✓"} ${entry.toolName} · ${summary}`;
}

export interface TaskTranscriptRenderOptions {
   readonly showThinking?: boolean;
   readonly showSystemPrompt?: boolean;
}

export interface TakeoverScrollState {
   readonly scrollTop: number;
   readonly followTail: boolean;
   readonly unseenLines: number;
}

export function createTakeoverScrollState(): TakeoverScrollState {
   return { scrollTop: 0, followTail: true, unseenLines: 0 };
}

export function computeTakeoverViewportHeight(
   terminalRows: number,
   headerLineCount: number,
   footerLineCount = 1
): number {
   const borderLineCount = 2;
   const fixedLineCount = borderLineCount + footerLineCount + headerLineCount;
   return Math.max(1, terminalRows - fixedLineCount);
}

export function wrapTakeoverHelp(text: string, width: number, theme: Theme): string[] {
   return wrapTextWithAnsi(theme.fg("dim", text), Math.max(1, width));
}

export function isSystemPromptToggleInput(data: string): boolean {
   return data === "\u0013" || data === Key.ctrl("s") || matchesKey(data, Key.ctrl("s"));
}

export function getTakeoverHelpText(showThinking: boolean, unseenLines: number, _isSettled = false): string {
   const scrollHint = unseenLines > 0 ? ` · ${unseenLines} new lines · End latest` : " · End latest";
   return `s copy transcript · t ${showThinking ? "collapse" : "expand"} thinking · Ctrl+S system prompt · ↑/↓ scroll · PageUp/PageDown${scrollHint} · Esc back`;
}

export function applyTranscriptUpdate(
   state: TakeoverScrollState,
   previousLineCount: number,
   nextLineCount: number,
   viewportHeight: number
): TakeoverScrollState {
   const maxScrollTop = Math.max(0, nextLineCount - viewportHeight);
   if (state.followTail) {
      return { scrollTop: maxScrollTop, followTail: true, unseenLines: 0 };
   }
   const addedLines = Math.max(0, nextLineCount - previousLineCount);
   return {
      scrollTop: Math.min(state.scrollTop, maxScrollTop),
      followTail: false,
      unseenLines: state.unseenLines + (addedLines > 0 ? addedLines : nextLineCount !== previousLineCount ? 1 : 0)
   };
}

export function moveTakeoverScroll(
   state: TakeoverScrollState,
   action: "up" | "down" | "pageUp" | "pageDown" | "latest",
   lineCount: number,
   viewportHeight: number
): TakeoverScrollState {
   const maxScrollTop = Math.max(0, lineCount - viewportHeight);
   const step = action === "pageUp" || action === "pageDown" ? viewportHeight : 4;
   if (action === "latest") {
      return { scrollTop: maxScrollTop, followTail: true, unseenLines: 0 };
   }
   const scrollTop =
      action === "up" || action === "pageUp"
         ? Math.max(0, state.scrollTop - step)
         : Math.min(maxScrollTop, state.scrollTop + step);
   const atTail = scrollTop >= maxScrollTop;
   return {
      scrollTop,
      followTail: atTail,
      unseenLines: atTail ? 0 : state.unseenLines
   };
}

export function buildCompactTranscriptSummary(
   task: Task,
   transcript: ReadonlyArray<TaskTranscriptEntry> = task.transcript ?? []
): string {
   return buildTranscriptSummary(normalizeWorkerTranscript(transcript), workerResultSummary);
}

export function buildCopiedTranscriptPayload(
   task: Task,
   transcript: ReadonlyArray<TaskTranscriptEntry> = task.transcript ?? []
): string {
   const workerHandle = task.id;
   const namePart = task.name ? ` name ${task.name}` : "";
   const header = `The ${workerHandle}${namePart} stucked and here is the current work done:`;
   const body = buildCompactTranscriptSummary(task, transcript);

   return `${header}\n\n---TRANSCRIPT-START---\n\n${body}\n\n---TRANSCRIPT-END---`;
}

export function buildTaskTranscriptLines(
   task: Task,
   width: number,
   theme: Theme,
   options: TaskTranscriptRenderOptions = {},
   transcript: ReadonlyArray<TaskTranscriptEntry> = task.transcript ?? []
): string[] {
   const lines: string[] = [];
   const contentWidth = Math.max(1, width);
   if (task.systemPrompt) {
      lines.push(
         ...buildSystemPromptRows(task.systemPrompt, contentWidth, theme, options.showSystemPrompt === true, {
            label: "[SYSTEM_PROMPT]",
            toggleKey: "Ctrl+S"
         })
      );
   }
   if (transcript.length > 0) {
      lines.push(
         ...buildTranscriptRows(normalizeWorkerTranscript(transcript), contentWidth, theme, {
            showThinking: options.showThinking,
            resultSummary: workerResultSummary
         })
      );
   }

   const pushWrapped = (text: string, color: Parameters<Theme["fg"]>[0]) => {
      for (const sourceLine of text.split("\n")) {
         const wrapped = wrapTextWithAnsi(theme.fg(color, sourceLine), contentWidth);
         lines.push(...(wrapped.length > 0 ? wrapped : [""]));
      }
   };
   const transcriptHasTaskError =
      typeof task.errorText === "string" &&
      transcript.some((entry) => entry.type === "error" && entry.text === task.errorText);
   if (task.errorText && !transcriptHasTaskError) {
      lines.push(theme.fg("dim", "--- Error ---"));
      pushWrapped(task.errorText, "error");
   }

   if (transcript.length === 0 && !task.errorText) {
      lines.push(theme.fg("dim", "(no transcript recorded yet)"));
   }

   return lines;
}

export class TakeoverView implements Component {
   private scrollState = createTakeoverScrollState();
   private lastTranscriptLineCount = 0;
   private lastRenderedTask?: Task;
   private closed = false;
   private showThinking = false;
   private showSystemPrompt = false;
   private ticker: ReturnType<typeof setInterval>;
   private currentTask?: Task;
   private currentSystemPrompt?: string;
   private currentTranscript: ReadonlyArray<TaskTranscriptEntry> = [];

   constructor(
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private runtime: WorkersRuntime,
      private taskId: string,
      private done: (value: null) => void
   ) {
      this.ticker = setInterval(() => {
         void this.refreshData();
      }, 500);
      void this.refreshData();
   }

   private async refreshData() {
      if (this.closed) return;
      try {
         const task = await runTool(
            this.runtime,
            TaskRegistry.use((r) => r.get(this.taskId))
         );
         this.currentTask = task;
         this.currentSystemPrompt = task?.systemPrompt;
         this.currentTranscript =
            task?.transcript ?? (task?.sessionFile ? readPiSessionTranscript(task.sessionFile) : []);
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

   private close() {
      if (this.cleanup()) this.done(null);
   }

   dispose(): void {
      this.cleanup();
   }

   handleInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
         this.close();
         return;
      }

      if (data === "t") {
         this.showThinking = !this.showThinking;
         this.tui.requestRender();
         return;
      }

      if (data === "s") {
         void this.copyTranscriptToClipboard();
         return;
      }

      if (isSystemPromptToggleInput(data)) {
         this.showSystemPrompt = !this.showSystemPrompt;
         if (this.showSystemPrompt) {
            this.scrollState = { scrollTop: 0, followTail: false, unseenLines: 0 };
         }
         this.tui.requestRender();
         return;
      }

      if (
         this.keybindings.matches(data, "tui.editor.cursorUp") ||
         matchesKey(data, Key.up) ||
         data === "up" ||
         data === "k"
      ) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "up",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
      } else if (
         this.keybindings.matches(data, "tui.editor.cursorDown") ||
         matchesKey(data, Key.down) ||
         data === "down" ||
         data === "j"
      ) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "down",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
      } else if (this.keybindings.matches(data, "tui.editor.pageUp") || matchesKey(data, Key.pageUp)) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "pageUp",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
      } else if (this.keybindings.matches(data, "tui.editor.pageDown") || matchesKey(data, Key.pageDown)) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "pageDown",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
      } else if (
         this.keybindings.matches(data, "tui.editor.cursorLineEnd") ||
         matchesKey(data, Key.end) ||
         data === "end" ||
         data === "G"
      ) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "latest",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
      }
      this.tui.requestRender();
   }

   private async copyTranscriptToClipboard(): Promise<void> {
      if (!this.currentTask) return;
      const payload = buildCopiedTranscriptPayload(this.currentTask, this.currentTranscript);
      await copyToClipboard(payload);
      this.tui.requestRender();
   }

   private viewportHeight(): number {
      const rows = this.tui.terminal.rows || 30;
      const width = this.tui.terminal.columns || 80;
      const headerLineCount = this.currentTask ? buildTaskHeaderLines(this.currentTask, width, this.theme).length : 2;
      const helpLineCount = wrapTakeoverHelp(
         getTakeoverHelpText(this.showThinking, this.scrollState.unseenLines),
         width,
         this.theme
      ).length;
      return computeTakeoverViewportHeight(rows, headerLineCount, helpLineCount);
   }

   render(width: number): string[] {
      const theme = this.theme;
      const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
      const lines: string[] = [];
      const task = this.currentTask;

      if (!task) {
         lines.push(border);
         lines.push(theme.fg("dim", `Task ${this.taskId} is no longer tracked or loading...`));
         lines.push(border);
         return lines;
      }

      const header = buildTaskHeaderLines(task, width, theme);
      const helpLines = wrapTakeoverHelp(
         getTakeoverHelpText(this.showThinking, this.scrollState.unseenLines),
         width,
         theme
      );
      lines.push(border);
      lines.push(...header);
      lines.push(border);

      const transcriptTask =
         this.currentSystemPrompt !== undefined && this.currentSystemPrompt !== task.systemPrompt
            ? { ...task, systemPrompt: this.currentSystemPrompt }
            : task;
      const transcript = buildTaskTranscriptLines(
         transcriptTask,
         width,
         theme,
         { showThinking: this.showThinking, showSystemPrompt: this.showSystemPrompt },
         this.currentTranscript
      );
      const viewport = computeTakeoverViewportHeight(this.tui.terminal.rows || 30, header.length, helpLines.length);
      if (this.currentTask !== this.lastRenderedTask) {
         this.scrollState = applyTranscriptUpdate(
            this.scrollState,
            this.lastTranscriptLineCount,
            transcript.length,
            viewport
         );
         this.lastRenderedTask = this.currentTask;
      }
      this.lastTranscriptLineCount = transcript.length;
      const maxScrollTop = Math.max(0, transcript.length - viewport);
      if (this.scrollState.followTail) {
         this.scrollState = { ...this.scrollState, scrollTop: maxScrollTop };
      } else if (this.scrollState.scrollTop > maxScrollTop) {
         this.scrollState = { ...this.scrollState, scrollTop: maxScrollTop };
      }

      const body: string[] = [];
      const visible = transcript.slice(this.scrollState.scrollTop, this.scrollState.scrollTop + viewport);
      if (visible.length === 0) body.push(theme.fg("dim", "(no output yet)"));
      else body.push(...visible);

      while (body.length < viewport) body.push("");
      lines.push(...body.slice(0, viewport));
      lines.push(...helpLines);
      return lines;
   }

   invalidate(): void {}
}

export async function openTaskTakeover(
   ctx: ExtensionCommandContext,
   runtime: WorkersRuntime,
   taskId: string
): Promise<void> {
   let releaseAlternateScreen: (() => void) | undefined;
   try {
      await ctx.ui.custom<null>(
         (tui, theme, keybindings, done) => {
            const screen = new TakeoverView(tui, theme, keybindings, runtime, taskId, done);
            releaseAlternateScreen = enterAlternateScreen(tui, screen);
            return screen;
         },
         { overlay: false }
      );
   } finally {
      releaseAlternateScreen?.();
   }
}
