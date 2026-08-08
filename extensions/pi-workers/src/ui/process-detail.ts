/**
 * Interactive Process Detail View Overlay for Workers ProcessSupervisor entries.
 */

import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ProcessEntry } from "../domain.js";
import type { WorkersRuntime } from "../extension.js";
import { runTool } from "../runtime.js";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { formatDuration } from "./formatters.js";

function statusGlyph(proc: ProcessEntry, theme: Theme): string {
   switch (proc.status) {
      case "running":
      case "starting":
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
      case "starting":
         return theme.fg("warning", "starting");
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
   private stream: "stdout" | "stderr" = "stdout";
   private scrollOffset = 0;
   private closed = false;
   private ticker: ReturnType<typeof setInterval>;
   private currentProc?: ProcessEntry;
   private logLines: string[] = [];

   constructor(
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private runtime: WorkersRuntime,
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
         const procs = await runTool(
            this.runtime,
            ProcessSupervisor.use((s) => s.ps)
         );
         const proc = procs.find((p) => (p.name ?? p.id) === this.procName || p.id === this.procName);
         this.currentProc = proc;

         if (proc) {
            const logsResult = await runTool(
               this.runtime,
               ProcessSupervisor.use((s) => s.logs(proc.name ?? proc.id, { stream: this.stream, lines: 500 }))
            );
            this.logLines = logsResult.lines;
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
      if (this.keybindings.matches(data, "tui.select.cancel") || data === "\u001b" || data === "q") {
         this.close();
         return;
      }
      if (data === "t") {
         this.stream = this.stream === "stdout" ? "stderr" : "stdout";
         this.scrollOffset = 0;
         void this.refreshData();
         return;
      }
      if (data === "x" || data === "c") {
         if (this.currentProc && (this.currentProc.status === "running" || this.currentProc.status === "starting")) {
            void runTool(
               this.runtime,
               ProcessSupervisor.use((s) => s.stop(this.procName))
            ).catch(() => {});
         }
         return;
      }
      if (data === "r") {
         void runTool(
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

      const title = proc.name ?? proc.id;
      const headerText =
         `${statusGlyph(proc, theme)} ` +
         theme.fg("accent", theme.bold(`${proc.id} · ${title}`)) +
         theme.fg("muted", ` · PID: ${proc.pid ?? "?"} · ${duration} · `) +
         statusWord(proc, theme) +
         theme.fg("dim", ` · ${proc.cwd}`);

      lines.push(truncateToWidth(headerText, width));
      lines.push(theme.fg("dim", `$ ${proc.command}`));
      lines.push(border);

      const tab = (name: "stdout" | "stderr", size: number) =>
         name === this.stream
            ? theme.fg("accent", theme.bold(`${name} (${formatSize(size)})`))
            : theme.fg("dim", `${name} (${formatSize(size)})`);
      lines.push(
         truncateToWidth(
            `  ${tab("stdout", proc.stdoutBytes)}${theme.fg("dim", " | ")}${tab("stderr", proc.stderrBytes)}${theme.fg("dim", "  — t to switch")}`,
            width
         )
      );

      const viewport = this.viewportHeight();
      const output = this.logLines;
      const maxOffset = Math.max(0, output.length - viewport);
      if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

      const body: string[] = [];
      const end = output.length - this.scrollOffset;
      const visible = output.slice(Math.max(0, end - viewport), end);
      if (visible.length === 0) {
         body.push(theme.fg("dim", `(no ${this.stream} recorded yet)`));
      } else {
         for (const line of visible) {
            body.push(truncateToWidth(`  ${line}`, width));
         }
      }

      while (body.length < viewport) body.push("");
      lines.push(...body.slice(0, viewport));

      lines.push(border);
      lines.push(
         truncateToWidth(
            theme.fg("dim", `Esc back · t stdout/stderr · x stop · r restart · j/k scroll · g/G top/bottom`),
            width
         )
      );
      lines.push(border);
      return lines;
   }

   invalidate(): void {}
}

export async function openProcessDetail(
   ctx: ExtensionCommandContext,
   runtime: WorkersRuntime,
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
