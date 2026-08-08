/**
 * Interactive Takeover Overlay for Workers Jobs (ported to real pi-tui overlay pattern).
 */

import {
   CustomEditor,
   type ExtensionCommandContext,
   type KeybindingsManager,
   type Theme
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, Focusable, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mapAgyEffort, type Job, type JobTranscriptEntry } from "../domain.js";
import type { WorkersRuntime } from "../extension.js";
import { enterAlternateScreen } from "./alternate-screen.js";
import { runTool } from "../runtime.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { WorkerManager } from "../services/WorkerManager.js";
import { formatDuration } from "./formatters.js";
import { getPiSessionContextTokens, readPiSessionTranscript } from "./session-transcript.js";

function configuredKeys(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
   return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(job: Job, theme: Theme): string {
   switch (job.status) {
      case "running":
      case "pending":
         return theme.fg("warning", "■");
      case "completed":
         return theme.fg("success", "■");
      case "failed":
      case "cancelled":
         return theme.fg("error", "■");
      default:
         return theme.fg("muted", "■");
   }
}

function statusWord(job: Job, theme: Theme): string {
   switch (job.status) {
      case "running":
         return theme.fg("warning", "running");
      case "pending":
         return theme.fg("warning", "pending");
      case "completed":
         return theme.fg("success", "completed");
      case "failed":
         return theme.fg("error", "failed");
      case "cancelled":
         return theme.fg("muted", "cancelled");
      default:
         return theme.fg("muted", job.status);
   }
}

function formatTokens(count: number): string {
   if (count < 1000) return `${count}`;
   if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
   if (count < 1000000) return `${Math.round(count / 1000)}k`;
   return `${(count / 1000000).toFixed(1)}M`;
}

export function buildJobHeaderLines(job: Job, width: number, theme: Theme, now: number = Date.now()): string[] {
   const elapsed = job.settledAt
      ? formatDuration(job.settledAt - (job.startedAt ?? job.createdAt))
      : formatDuration(now - (job.startedAt ?? job.createdAt));
   const title = job.name ?? job.promptOrCommand.slice(0, 30);
   const primary =
      `${statusGlyph(job, theme)} ` +
      theme.fg("accent", theme.bold(`${job.id} · ${title}`)) +
      ` · ${statusWord(job, theme)} · ${theme.fg("muted", elapsed)}`;
   const reasoningMetadata =
      job.harness === "agy"
         ? job.model
            ? undefined
            : `effort ${mapAgyEffort(job.thinking)}`
         : job.thinking
           ? `thinking ${job.thinking}`
           : "thinking (inherit)";
   const contextTokens =
      job.contextTokens ?? (job.sessionFile ? getPiSessionContextTokens(job.sessionFile) : undefined);
   const metadata = [
      job.agent ? `agent ${job.agent}` : undefined,
      job.harness ? `via ${job.harness}` : undefined,
      job.model ? `model ${job.model}` : "model (inherit)",
      reasoningMetadata,
      job.cwd ? `cwd ${job.cwd}` : undefined,
      contextTokens !== undefined ? `context ${formatTokens(contextTokens)} tokens` : "context 0 tokens"
   ].filter((value): value is string => value !== undefined);
   return [truncateToWidth(primary, width), ...wrapTextWithAnsi(theme.fg("muted", metadata.join(" · ")), width)];
}

function resultLineCount(entry: Extract<JobTranscriptEntry, { type: "tool-result" }>): number {
   const lines = entry.content.flatMap((content) =>
      content.type === "text"
         ? content.text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
         : []
   );
   return lines.length === 1 && /^No files found\b/i.test(lines[0]) ? 0 : lines.length;
}

function compactPreview(value: unknown, limit = 100): string {
   const text = typeof value === "string" ? value : JSON.stringify(value);
   const compact = text?.replace(/\s+/g, " ").trim() ?? "";
   return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function compactToolCall(entry: Extract<JobTranscriptEntry, { type: "tool-call" }>): string {
   const args = entry.arguments;
   if (!args || typeof args !== "object") return `→ ${entry.toolName}`;

   const record = args as Record<string, unknown>;
   const text = (key: string) => (typeof record[key] === "string" ? record[key] : undefined);
   const details = (() => {
      switch (entry.toolName) {
         case "find":
            return [text("path"), text("pattern")];
         case "grep":
         case "ffgrep":
            return [text("pattern"), text("path")];
         case "read":
         case "write":
         case "edit":
         case "ls":
            return [text("path")];
         case "worker_spawn":
         case "process_start":
            return [text("name"), text("command"), text("agent")];
         case "process_snapshot":
         case "process_restart":
         case "process_stop":
         case "worker_cancel":
            return [text("id")];
         case "worker_list":
         case "process_list":
         case "bash":
            return [text("command")];
         case "describe_image":
            return [text("filePath")];
         default:
            return [text("path"), text("command"), text("query"), text("pattern"), text("filePath")];
      }
   })().filter((value): value is string => Boolean(value));

   const separator = entry.toolName === "worker_list" || entry.toolName === "process_list" ? " " : " · ";
   return details.length > 0 ? `→ ${entry.toolName} ${details.join(separator)}` : `→ ${entry.toolName}`;
}

const JOB_TOOL_NAMES = new Set([
   "worker_spawn",
   "worker_list",
   "worker_cancel",
   "process_list",
   "process_stop",
   "process_start",
   "process_snapshot",
   "process_restart"
]);

function compactJobToolResult(entry: Extract<JobTranscriptEntry, { type: "tool-result" }>): string | undefined {
   const text = entry.content.find((content) => content.type === "text")?.text;
   if (!text) return undefined;
   try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (value.ok === false) return `✗ job ${compactPreview(value.error)}`;
      const jobs = Array.isArray(value.jobs) ? value.jobs : value.job ? [value.job] : [];
      if (jobs.length > 0) {
         return jobs
            .filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === "object")
            .map((job) => {
               const status = typeof job.status === "string" ? job.status : "unknown";
               const mark = status === "completed" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : "●";
               const output = compactPreview(job.resultData ?? job.errorText);
               const id = typeof job.id === "string" ? job.id : "job";
               return `${mark} ${id} ${status}${output ? ` · ${output}` : ""}`;
            })
            .join("\n");
      }
      for (const key of ["jobs", "processes", "lines"] as const) {
         if (Array.isArray(value[key])) return `job ${key} · ${value[key].length} items`;
      }
      if (value.process && typeof value.process === "object") return "✓ process completed";
      return "✓ job completed";
   } catch {
      return compactPreview(text);
   }
}

function compactToolResult(entry: Extract<JobTranscriptEntry, { type: "tool-result" }>): string {
   const mark = entry.isError ? "✗" : "✓";
   if (JOB_TOOL_NAMES.has(entry.toolName)) {
      const summary = compactJobToolResult(entry);
      if (summary)
         return summary.startsWith("✓") || summary.startsWith("✗") ? summary : `${mark} ${entry.toolName} · ${summary}`;
      return `${mark} ${entry.toolName}`;
   }

   const text = entry.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");
   const output = compactPreview(text);
   if (!entry.isError && ["find", "grep", "ffgrep", "ls"].includes(entry.toolName)) {
      const count = resultLineCount(entry);
      return `${mark} ${entry.toolName} · ${count} ${count === 1 ? "result" : "results"}`;
   }
   if (!entry.isError && entry.toolName === "read") {
      const count = resultLineCount(entry);
      return `${mark} read · ${count} ${count === 1 ? "line" : "lines"}${output ? ` · ${output}` : ""}`;
   }
   if (output) return `${mark} ${entry.toolName} · ${output}`;

   const imageCount = entry.content.filter((content) => content.type === "image").length;
   return `${mark} ${entry.toolName}${imageCount > 0 ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"}` : ""}`;
}

export interface JobTranscriptRenderOptions {
   readonly showThinking?: boolean;
   readonly showSystemPrompt?: boolean;
}

const SYSTEM_PROMPT_TRUNCATION_SUFFIX = /\n?… \[truncated \d+ characters\]$/;

function systemPromptForDisplay(systemPrompt: string): string {
   return systemPrompt.replace(SYSTEM_PROMPT_TRUNCATION_SUFFIX, "");
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
   inputLineCount: number,
   footerLineCount = 1
): number {
   const borderLineCount = 2;
   const fixedLineCount = borderLineCount + footerLineCount + headerLineCount + inputLineCount;
   return Math.max(1, terminalRows - fixedLineCount);
}

export function wrapTakeoverHelp(text: string, width: number, theme: Theme): string[] {
   return wrapTextWithAnsi(theme.fg("dim", text), Math.max(1, width));
}

function getTakeoverHelpText(showThinking: boolean, unseenLines: number): string {
   const scrollHint = unseenLines > 0 ? ` · ${unseenLines} new lines · End latest` : " · End latest";
   return `Enter steer · Alt+Enter followUp · t ${showThinking ? "collapse" : "expand"} thinking · ↑/↓ scroll · PageUp/PageDown${scrollHint} · Esc back`;
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

export function buildJobTranscriptLines(
   job: Job,
   width: number,
   theme: Theme,
   options: JobTranscriptRenderOptions = {},
   transcript: ReadonlyArray<JobTranscriptEntry> = job.transcript ?? []
): string[] {
   const lines: string[] = [];
   const contentWidth = Math.max(1, width);
   const pushWrapped = (text: string, color: Parameters<Theme["fg"]>[0]) => {
      for (const sourceLine of text.split("\n")) {
         const wrapped = wrapTextWithAnsi(theme.fg(color, sourceLine), contentWidth);
         lines.push(...(wrapped.length > 0 ? wrapped : [""]));
      }
   };

   if (job.systemPrompt) {
      const systemPromptLabel = options.showSystemPrompt
         ? "[SYSTEM_PROMPT] (Ctrl+S to collapse)"
         : "[SYSTEM_PROMPT] (Ctrl+S to expand)";
      lines.push(theme.fg("accent", theme.bold(systemPromptLabel)));
      if (options.showSystemPrompt) pushWrapped(systemPromptForDisplay(job.systemPrompt), "dim");
      lines.push(theme.fg("border", "─".repeat(contentWidth)));
   }

   if (transcript.length > 0) {
      const renderedResults = new Set<JobTranscriptEntry>();
      const renderToolResult = (entry: Extract<JobTranscriptEntry, { type: "tool-result" }>) => {
         pushWrapped(compactToolResult(entry), entry.isError ? "error" : "dim");
      };

      for (const entry of transcript) {
         if (entry.type === "user") {
            pushWrapped(`You: ${entry.text}`, "accent");
         } else if (entry.type === "assistant") {
            pushWrapped(entry.text, "text");
         } else if (entry.type === "tool-call") {
            const result = entry.toolCallId
               ? transcript.find(
                    (candidate): candidate is Extract<JobTranscriptEntry, { type: "tool-result" }> =>
                       candidate.type === "tool-result" && candidate.toolCallId === entry.toolCallId
                 )
               : undefined;
            pushWrapped(compactToolCall(entry), "accent");
            if (result) {
               renderToolResult(result);
               renderedResults.add(result);
            }
         } else if (entry.type === "thinking") {
            pushWrapped(options.showThinking === false ? "Thinking..." : `Thinking: ${entry.text}`, "dim");
         } else if (entry.type === "tool-result" && !renderedResults.has(entry)) {
            renderToolResult(entry);
         }
      }
   }

   if (job.resultData !== undefined) {
      lines.push(theme.fg("dim", "--- Output Result ---"));
      const resStr = typeof job.resultData === "string" ? job.resultData : JSON.stringify(job.resultData, null, 2);
      pushWrapped(resStr, "success");
   }

   if (job.errorText) {
      lines.push(theme.fg("dim", "--- Error ---"));
      pushWrapped(job.errorText, "error");
   }

   if (transcript.length === 0 && job.resultData === undefined && !job.errorText) {
      lines.push(theme.fg("dim", "(no output recorded yet)"));
   }

   return lines;
}

export function createTakeoverEditor(tui: TUI, theme: Theme, keybindings: KeybindingsManager): CustomEditor {
   const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("borderAccent", text),
      selectList: {
         selectedPrefix: (text) => theme.fg("accent", text),
         selectedText: (text) => theme.fg("accent", text),
         description: (text) => theme.fg("muted", text),
         scrollInfo: (text) => theme.fg("dim", text),
         noMatch: (text) => theme.fg("warning", text)
      }
   };
   return new CustomEditor(tui, editorTheme, keybindings);
}

export class TakeoverView implements Component, Focusable {
   private input: CustomEditor;
   private scrollState = createTakeoverScrollState();
   private lastTranscriptLineCount = 0;
   private lastRenderedJob?: Job;
   private closed = false;
   private showThinking = true;
   private showSystemPrompt = false;
   private ticker: ReturnType<typeof setInterval>;
   private currentJob?: Job;
   private currentSystemPrompt?: string;
   private currentTranscript: ReadonlyArray<JobTranscriptEntry> = [];

   private _focused = false;
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
      private jobId: string,
      private done: (value: null) => void
   ) {
      this.input = createTakeoverEditor(tui, theme, keybindings);
      this.input.onEscape = () => this.close();
      this.input.onCtrlD = () => this.close();
      this.ticker = setInterval(() => {
         void this.refreshData();
      }, 500);
      void this.refreshData();

      this.input.onSubmit = (value: string) => {
         const text = value.trim();
         if (!text) return;
         this.input.setText("");
         void runTool(
            this.runtime,
            WorkerManager.use((s) => s.controlJob(this.jobId, text, "steer"))
         ).catch(() => {});
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "latest",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
      };
   }

   private async refreshData() {
      if (this.closed) return;
      try {
         const job = await runTool(
            this.runtime,
            JobRegistry.use((r) => r.get(this.jobId))
         );
         this.currentJob = job;
         this.currentSystemPrompt = job?.systemPrompt;
         this.currentTranscript = job?.transcript ?? (job?.sessionFile ? readPiSessionTranscript(job.sessionFile) : []);
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
      const isAltEnter = data === "\u001b\r" || data === "\u001b\n";

      if (data === "\u0003") {
         this.input.setText("");
         this.tui.requestRender();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel") || data === "\u001b") {
         this.close();
         return;
      }

      if (data === "t" && this.input.getText().length === 0) {
         this.showThinking = !this.showThinking;
         this.tui.requestRender();
         return;
      }

      if (data === "\u0013" && this.input.getText().length === 0) {
         this.showSystemPrompt = !this.showSystemPrompt;
         if (this.showSystemPrompt) {
            this.scrollState = { scrollTop: 0, followTail: false, unseenLines: 0 };
         }
         this.tui.requestRender();
         return;
      }

      if (isAltEnter) {
         const val = this.input.getText().trim();
         if (val) {
            this.input.setText("");
            void runTool(
               this.runtime,
               WorkerManager.use((s) => s.controlJob(this.jobId, val, "followUp"))
            ).catch(() => {});
            this.scrollState = moveTakeoverScroll(
               this.scrollState,
               "latest",
               this.lastTranscriptLineCount,
               this.viewportHeight()
            );
         }
         this.tui.requestRender();
         return;
      }

      if (
         this.input.getText().length === 0 &&
         (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "\u001b[A")
      ) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "up",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (
         this.input.getText().length === 0 &&
         (this.keybindings.matches(data, "tui.editor.cursorDown") || data === "\u001b[B")
      ) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "down",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (this.input.getText().length === 0 && this.keybindings.matches(data, "tui.editor.pageUp")) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "pageUp",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (this.input.getText().length === 0 && this.keybindings.matches(data, "tui.editor.pageDown")) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "pageDown",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (
         this.input.getText().length === 0 &&
         (this.keybindings.matches(data, "tui.editor.cursorLineEnd") || data === "\u001b[F")
      ) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "latest",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }

      this.input.handleInput(data);
      this.tui.requestRender();
   }

   private viewportHeight(): number {
      const rows = this.tui.terminal.rows || 30;
      const width = this.tui.terminal.columns || 80;
      const headerLineCount = this.currentJob ? buildJobHeaderLines(this.currentJob, width, this.theme).length : 2;
      const inputLineCount = this.input.render(width).length;
      const helpLineCount = wrapTakeoverHelp(
         getTakeoverHelpText(this.showThinking, this.scrollState.unseenLines),
         width,
         this.theme
      ).length;
      return computeTakeoverViewportHeight(rows, headerLineCount, inputLineCount, helpLineCount);
   }

   render(width: number): string[] {
      const theme = this.theme;
      const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
      const lines: string[] = [];
      const job = this.currentJob;

      if (!job) {
         lines.push(border);
         lines.push(theme.fg("dim", `Job ${this.jobId} is no longer tracked or loading...`));
         lines.push(border);
         return lines;
      }

      const header = buildJobHeaderLines(job, width, theme);
      const inputLines = this.input.render(width);
      const helpLines = wrapTakeoverHelp(
         getTakeoverHelpText(this.showThinking, this.scrollState.unseenLines),
         width,
         theme
      );
      lines.push(border);
      lines.push(...header);
      lines.push(border);

      const transcriptJob =
         this.currentSystemPrompt !== undefined && this.currentSystemPrompt !== job.systemPrompt
            ? { ...job, systemPrompt: this.currentSystemPrompt }
            : job;
      const transcript = buildJobTranscriptLines(
         transcriptJob,
         width,
         theme,
         { showThinking: this.showThinking, showSystemPrompt: this.showSystemPrompt },
         this.currentTranscript
      );
      const viewport = computeTakeoverViewportHeight(
         this.tui.terminal.rows || 30,
         header.length,
         inputLines.length,
         helpLines.length
      );
      if (this.currentJob !== this.lastRenderedJob) {
         this.scrollState = applyTranscriptUpdate(
            this.scrollState,
            this.lastTranscriptLineCount,
            transcript.length,
            viewport
         );
         this.lastRenderedJob = this.currentJob;
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
      lines.push(...inputLines);
      lines.push(...helpLines);
      return lines;
   }

   invalidate(): void {
      this.input.invalidate();
   }
}

export async function openJobTakeover(
   ctx: ExtensionCommandContext,
   runtime: WorkersRuntime,
   jobId: string
): Promise<void> {
   let releaseAlternateScreen: (() => void) | undefined;
   try {
      await ctx.ui.custom<null>(
         (tui, theme, keybindings, done) => {
            const screen = new TakeoverView(tui, theme, keybindings, runtime, jobId, done);
            releaseAlternateScreen = enterAlternateScreen(tui, screen);
            return screen;
         },
         { overlay: false }
      );
   } finally {
      releaseAlternateScreen?.();
   }
}
