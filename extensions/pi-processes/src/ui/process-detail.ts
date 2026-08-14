/**
 * Interactive process detail view for supervised process entries.
 */

import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ProcessEntry } from "../domain.ts";
import type { makeProcessesRuntime } from "../runtime.ts";
import { runProcessTool } from "../runtime.ts";
import { ProcessSupervisor } from "../services/ProcessSupervisor.ts";
import { formatDuration } from "./formatters.ts";
import { formatProcessLogTime } from "./log-viewer.ts";
export { formatProcessLogTime } from "./log-viewer.ts";

type ProcessesRuntime = ReturnType<typeof makeProcessesRuntime>;
export type ProcessLogMode = "both" | "stdout" | "stderr";

export function nextProcessLogMode(mode: ProcessLogMode): ProcessLogMode {
   if (mode === "both") return "stdout";
   if (mode === "stdout") return "stderr";
   return "both";
}

type ProcessLogStream = "stdout" | "stderr";
interface ProcessLogLine {
   readonly line: string;
   readonly stream: ProcessLogStream;
   readonly timestamp?: number;
}

function statusGlyph(proc: ProcessEntry, theme: Theme): string {
   switch (proc.status) {
      case "running":
         return theme.fg("warning", "■");
      case "exited":
         return proc.exitCode === 0 ? theme.fg("success", "■") : theme.fg("error", "■");
      case "failed":
         return theme.fg("error", "■");
      default:
         return theme.fg("muted", "■");
   }
}

function statusWord(proc: ProcessEntry, theme: Theme): string {
   switch (proc.status) {
      case "running":
         return theme.fg("warning", "running");
      case "exited":
         return proc.exitCode === 0
            ? theme.fg("success", "exited (0)")
            : theme.fg("error", `exited (${proc.exitCode ?? "?"})`);
      case "failed":
         return theme.fg("error", "failed");
      default:
         return theme.fg("muted", proc.status);
   }
}

export class ProcessDetailView implements Component {
   private logMode: ProcessLogMode = "both";
   private scrollOffset = 0;
   private closed = false;
   private ticker: ReturnType<typeof setInterval>;
   private currentProc?: ProcessEntry;
   private logLines: ProcessLogLine[] = [];

   constructor(
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private runtime: ProcessesRuntime,
      private procName: string,
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
         const procs = await runProcessTool(
            this.runtime,
            ProcessSupervisor.use((s) => s.ps)
         );
         const proc = procs.find((p) => p.name === this.procName || p.id === this.procName);
         this.currentProc = proc;

         if (proc) {
            const logsResult = await runProcessTool(
               this.runtime,
               ProcessSupervisor.use((s) => s.logs(proc.name, { stream: this.logMode, lines: 500 }))
            );
            this.logLines = logsResult.logLines;
         }
         this.tui.requestRender();
      } catch {
         // ignore error
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
      if (matchesKey(data, Key.tab)) {
         this.logMode = nextProcessLogMode(this.logMode);
         this.scrollOffset = 0;
         void this.refreshData();
         return;
      }
      if (this.keybindings.matches(data, "tui.select.cancel") || data === "\u001b" || data === "q") {
         this.close();
         return;
      }
      if (data === "x" || data === "c") {
         if (this.currentProc?.status === "running") {
            void runProcessTool(
               this.runtime,
               ProcessSupervisor.use((s) => s.stop(this.procName))
            ).catch(() => {});
         }
         return;
      }
      if (data === "r") {
         void runProcessTool(
            this.runtime,
            ProcessSupervisor.use((s) => s.restart(this.procName))
         ).catch(() => {});
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k" || data === "\u001b[A") {
         this.scrollOffset += 4;
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorDown") || data === "j" || data === "\u001b[B") {
         this.scrollOffset = Math.max(0, this.scrollOffset - 4);
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.pageUp")) {
         this.scrollOffset += this.viewportHeight();
         this.tui.requestRender();
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.pageDown")) {
         this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
         this.tui.requestRender();
         return;
      }
      if (data === "g") {
         this.scrollOffset = Number.MAX_SAFE_INTEGER;
         this.tui.requestRender();
         return;
      }
      if (data === "G") {
         this.scrollOffset = 0;
         this.tui.requestRender();
         return;
      }
   }

   private viewportHeight(): number {
      const rows = this.tui.terminal.rows || 30;
      return Math.max(6, rows - 9);
   }

   render(width: number): string[] {
      const theme = this.theme;
      const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
      const lines: string[] = [];
      const proc = this.currentProc;

      if (!proc) {
         lines.push(border);
         lines.push(theme.fg("dim", `Process ${this.procName} is no longer tracked or loading...`));
         lines.push(border);
         return lines;
      }

      lines.push(border);
      const now = Date.now();
      const duration = proc.settledAt
         ? formatDuration(proc.settledAt - proc.spawnTime)
         : formatDuration(now - proc.spawnTime);

      const title = proc.name;
      const headerText =
         `${statusGlyph(proc, theme)} ` +
         theme.fg("accent", theme.bold(`${proc.id} · ${title}`)) +
         theme.fg("muted", ` · PID: ${proc.pid ?? "?"} · ${duration} · `) +
         statusWord(proc, theme) +
         theme.fg("dim", ` · ${proc.cwd}`);

      lines.push(truncateToWidth(headerText, width));
      lines.push(theme.fg("dim", `$ ${proc.command}`));
      lines.push(border);

      lines.push(truncateToWidth(`  ${theme.fg("accent", theme.bold(`${this.logMode} output`))}`, width));

      const viewport = this.viewportHeight();
      const output = this.logLines.flatMap((entry) => {
         const timestamp = entry.timestamp === undefined ? "" : `${formatProcessLogTime(entry.timestamp)} `;
         return wrapTextWithAnsi(
            `  ${theme.fg("muted", `${timestamp}[${entry.stream}]`)} ${entry.line}`,
            Math.max(1, width)
         );
      });
      const maxOffset = Math.max(0, output.length - viewport);
      if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

      const body: string[] = [];
      if (output.length === 0) {
         body.push(theme.fg("dim", "(no output recorded yet)"));
      } else {
         const end = output.length - this.scrollOffset;
         body.push(...output.slice(Math.max(0, end - viewport), end));
      }

      while (body.length < viewport) body.push("");
      lines.push(...body.slice(0, viewport));

      lines.push(border);
      lines.push(
         truncateToWidth(
            theme.fg("dim", `Tab ${this.logMode} → next · Esc back · x stop · r restart · j/k scroll · g/G top/bottom`),
            width
         )
      );
      lines.push(border);
      return lines;
   }

   invalidate(): void {}
}

export async function openProcessDetail(
   ctx: ExtensionContext,
   runtime: ProcessesRuntime,
   procName: string
): Promise<void> {
   await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) => new ProcessDetailView(tui, theme, keybindings, runtime, procName, done),
      {
         overlay: true,
         overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" }
      }
   );
}
