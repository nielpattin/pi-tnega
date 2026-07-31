/**
 * Interactive Takeover Overlay for Harbor Jobs (ported to real pi-tui overlay pattern).
 */

import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Job, JobTranscriptEntry } from "../domain.js";
import type { HarborRuntime } from "../extension.js";
import { enterAlternateScreen } from "./alternate-screen.js";
import { runTool } from "../runtime.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { TaskManager } from "../services/TaskManager.js";
import { formatDuration } from "./formatters.js";

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

export function buildJobHeaderLines(job: Job, width: number, theme: Theme, now: number = Date.now()): string[] {
   const elapsed = job.settledAt
      ? formatDuration(job.settledAt - (job.startedAt ?? job.createdAt))
      : formatDuration(now - (job.startedAt ?? job.createdAt));
   const title = job.name ?? job.promptOrCommand.slice(0, 30);
   const primary =
      `${statusGlyph(job, theme)} ` +
      theme.fg("accent", theme.bold(`${job.id} · ${title}`)) +
      ` · ${statusWord(job, theme)} · ${theme.fg("muted", elapsed)}`;
   const metadata = [
      job.agent ? `agent ${job.agent}` : undefined,
      job.harness ? `via ${job.harness}` : undefined,
      job.model ? `model ${job.model}` : "model (inherit)",
      job.thinking ? `thinking ${job.thinking}` : "thinking (inherit)",
      job.cwd ? `cwd ${job.cwd}` : undefined
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

function compactToolCall(
   entry: Extract<JobTranscriptEntry, { type: "tool-call" }>,
   result?: Extract<JobTranscriptEntry, { type: "tool-result" }>
): string {
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
         case "hub": {
            const op = text("op");
            const ids = Array.isArray(record.ids)
               ? record.ids.filter((id): id is string => typeof id === "string")
               : [];
            return [op, text("target"), ...ids, text("id"), text("name"), text("command")];
         }
         case "bash":
            return [text("command")];
         case "describe_image":
            return [text("filePath")];
         default:
            return [text("path"), text("command"), text("query"), text("pattern"), text("filePath")];
      }
   })().filter((value): value is string => Boolean(value));

   const separator = entry.toolName === "hub" ? " " : " · ";
   const base = details.length > 0 ? `→ ${entry.toolName} ${details.join(separator)}` : `→ ${entry.toolName}`;
   const countable = ["find", "grep", "ffgrep", "ls"].includes(entry.toolName);
   if (countable && result && !result.isError) {
      const count = resultLineCount(result);
      return `${base} (found ${count} ${count === 1 ? "result" : "results"})`;
   }
   return base;
}

function compactHubResult(entry: Extract<JobTranscriptEntry, { type: "tool-result" }>): string | undefined {
   const text = entry.content.find((content) => content.type === "text")?.text;
   if (!text) return undefined;
   try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (value.ok === false) return `✗ hub ${compactPreview(value.error)}`;
      if (typeof value.exitCode === "number") {
         const output = compactPreview(value.stdout || value.stderr);
         return `${value.exitCode === 0 ? "✓" : "✗"} hub exit ${value.exitCode}${output ? ` · ${output}` : ""}`;
      }
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
      for (const key of ["processes", "messages", "peers", "lines"] as const) {
         if (Array.isArray(value[key])) return `hub ${key} · ${value[key].length} items`;
      }
      return "✓ hub completed";
   } catch {
      return compactPreview(text);
   }
}

export interface JobTranscriptRenderOptions {
   readonly showThinking?: boolean;
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
   const borderLineCount = 4;
   const fixedLineCount = borderLineCount + footerLineCount + headerLineCount + inputLineCount;
   return Math.max(1, terminalRows - fixedLineCount);
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
   options: JobTranscriptRenderOptions = {}
): string[] {
   const lines: string[] = [];
   const contentWidth = Math.max(1, width);
   const pushWrapped = (text: string, color: Parameters<Theme["fg"]>[0]) => {
      for (const sourceLine of text.split("\n")) {
         const wrapped = wrapTextWithAnsi(theme.fg(color, sourceLine), contentWidth);
         lines.push(...(wrapped.length > 0 ? wrapped : [""]));
      }
   };

   const promptText = job.promptOrCommand || "(empty prompt)";
   lines.push(theme.fg("accent", theme.bold(`Task Prompt:`)));
   pushWrapped(promptText, "text");
   lines.push(theme.fg("border", "─".repeat(contentWidth)));

   if (job.transcript && job.transcript.length > 0) {
      const renderedResults = new Set<JobTranscriptEntry>();
      const renderToolResult = (entry: Extract<JobTranscriptEntry, { type: "tool-result" }>) => {
         if (entry.toolName === "read") return;
         if (["find", "grep", "ffgrep", "ls"].includes(entry.toolName) && !entry.isError) return;
         if (entry.toolName === "hub") {
            const summary = compactHubResult(entry);
            if (summary) pushWrapped(summary, entry.isError ? "error" : "dim");
            return;
         }
         if (entry.isError) pushWrapped(`error · ${entry.toolName}`, "error");
         for (const content of entry.content) {
            if (content.type === "text") pushWrapped(content.text, entry.isError ? "error" : "text");
            else pushWrapped(`[image ${content.mimeType}]`, "dim");
         }
      };

      for (const entry of job.transcript) {
         if (entry.type === "user") {
            pushWrapped(`You: ${entry.text}`, "accent");
         } else if (entry.type === "assistant") {
            pushWrapped(entry.text, "text");
         } else if (entry.type === "tool-call") {
            const result = entry.toolCallId
               ? job.transcript.find(
                    (candidate): candidate is Extract<JobTranscriptEntry, { type: "tool-result" }> =>
                       candidate.type === "tool-result" && candidate.toolCallId === entry.toolCallId
                 )
               : undefined;
            pushWrapped(compactToolCall(entry, result), "accent");
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
   } else if (job.rawText) {
      pushWrapped(job.rawText, "text");
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

   if (
      (!job.transcript || job.transcript.length === 0) &&
      !job.rawText &&
      job.resultData === undefined &&
      !job.errorText
   ) {
      lines.push(theme.fg("dim", "(no output recorded yet)"));
   }

   return lines;
}

export class TakeoverView implements Component, Focusable {
   private input = new Input();
   private scrollState = createTakeoverScrollState();
   private lastTranscriptLineCount = 0;
   private lastRenderedJob?: Job;
   private closed = false;
   private showThinking = true;
   private ticker: ReturnType<typeof setInterval>;
   private currentJob?: Job;

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
      private runtime: HarborRuntime,
      private jobId: string,
      private done: (value: null) => void
   ) {
      this.ticker = setInterval(() => {
         void this.refreshData();
      }, 500);
      void this.refreshData();

      this.input.onSubmit = (value: string) => {
         const text = value.trim();
         if (!text) return;
         this.input.setValue("");
         void runTool(
            this.runtime,
            TaskManager.use((s) => s.controlJob(this.jobId, text, "steer"))
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

      if (this.keybindings.matches(data, "tui.select.cancel") || data === "\u001b") {
         this.close();
         return;
      }

      if (data === "t" && this.input.getValue().length === 0) {
         this.showThinking = !this.showThinking;
         this.tui.requestRender();
         return;
      }

      if (isAltEnter) {
         const val = this.input.getValue().trim();
         if (val) {
            this.input.setValue("");
            void runTool(
               this.runtime,
               TaskManager.use((s) => s.controlJob(this.jobId, val, "followUp"))
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

      if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "\u001b[A") {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "up",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorDown") || data === "\u001b[B") {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "down",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.pageUp")) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "pageUp",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.pageDown")) {
         this.scrollState = moveTakeoverScroll(
            this.scrollState,
            "pageDown",
            this.lastTranscriptLineCount,
            this.viewportHeight()
         );
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorLineEnd") || data === "\u001b[F") {
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
      return computeTakeoverViewportHeight(rows, headerLineCount, inputLineCount);
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
      lines.push(border);
      lines.push(...header);
      lines.push(border);

      const transcript = buildJobTranscriptLines(job, width, theme, { showThinking: this.showThinking });
      const viewport = computeTakeoverViewportHeight(this.tui.terminal.rows || 30, header.length, inputLines.length);
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

      lines.push(border);
      lines.push(...inputLines);
      const scrollHint =
         this.scrollState.unseenLines > 0
            ? ` · ${this.scrollState.unseenLines} new lines · End latest`
            : " · End latest";
      lines.push(
         truncateToWidth(
            theme.fg(
               "dim",
               `Enter steer · Alt+Enter followUp · t ${this.showThinking ? "collapse" : "expand"} thinking · ↑/↓ scroll · PageUp/PageDown${scrollHint} · Esc back`
            ),
            width
         )
      );
      lines.push(border);
      return lines;
   }

   invalidate(): void {
      this.input.invalidate();
   }
}

export async function openJobTakeover(
   ctx: ExtensionCommandContext,
   runtime: HarborRuntime,
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
