import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ProcessEntry } from "../domain.ts";
import { runProcessTool, type makeProcessesRuntime } from "../runtime.ts";
import { ProcessSupervisor } from "../services/ProcessSupervisor.ts";
import { formatDuration } from "./formatters.ts";
import { enterAlternateScreen } from "./alternate-screen.ts";
import { openProcessDetail } from "./process-detail.ts";

type ProcessesRuntime = ReturnType<typeof makeProcessesRuntime>;

function statusGlyph(process: ProcessEntry, theme: Theme): string {
   if (process.status === "running") return theme.fg("warning", "■");
   if (process.status === "exited" && process.exitCode === 0) return theme.fg("success", "■");
   return theme.fg("error", "■");
}

/** Independent process supervision dashboard. */
export class ProcessDashboard implements Component {
   private processes: ProcessEntry[] = [];
   private selected = 0;
   private closed = false;
   private readonly ticker: ReturnType<typeof setInterval>;

   constructor(
      private readonly tui: TUI,
      private readonly theme: Theme,
      private readonly keybindings: KeybindingsManager,
      private readonly runtime: ProcessesRuntime,
      private readonly close: () => void,
      private readonly openDetail: (name: string) => Promise<void>
   ) {
      this.ticker = setInterval(() => void this.refresh(), 500);
      void this.refresh();
   }

   dispose(): void {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.ticker);
   }

   invalidate(): void {}

   private async refresh() {
      if (this.closed) return;
      try {
         this.processes = [
            ...(await runProcessTool(
               this.runtime,
               ProcessSupervisor.use((service) => service.ps)
            ))
         ];
         this.selected = Math.min(this.selected, Math.max(0, this.processes.length - 1));
         this.tui.requestRender();
      } catch {
         // The process runtime may be shutting down while the overlay renders.
      }
   }

   private async stopSelected() {
      const selected = this.processes[this.selected];
      if (!selected) return;
      await runProcessTool(
         this.runtime,
         ProcessSupervisor.use((service) => service.stop(selected.name))
      ).catch(() => {});
      await this.refresh();
   }

   private async restartSelected() {
      const selected = this.processes[this.selected];
      if (!selected) return;
      await runProcessTool(
         this.runtime,
         ProcessSupervisor.use((service) => service.restart(selected.name))
      ).catch(() => {});
      await this.refresh();
   }

   handleInput(data: string): void {
      if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
         this.dispose();
         this.close();
         return;
      }
      if (data === "j" || this.keybindings.matches(data, "tui.select.down")) {
         this.selected = this.processes.length === 0 ? 0 : (this.selected + 1) % this.processes.length;
         this.tui.requestRender();
         return;
      }
      if (data === "k" || this.keybindings.matches(data, "tui.select.up")) {
         this.selected =
            this.processes.length === 0 ? 0 : (this.selected - 1 + this.processes.length) % this.processes.length;
         this.tui.requestRender();
         return;
      }
      if (data === "x") {
         void this.stopSelected();
         return;
      }
      if (data === "r") {
         void this.restartSelected();
         return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r") {
         const selected = this.processes[this.selected];
         if (selected) void this.openDetail(selected.name);
      }
   }

   render(width: number): string[] {
      const lines: string[] = [];
      const innerWidth = Math.max(1, width);
      lines.push(this.theme.bold(this.theme.fg("accent", "Processes")));
      lines.push(
         this.theme.fg("dim", `${this.processes.length} tracked process${this.processes.length === 1 ? "" : "es"}`)
      );
      lines.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));

      if (this.processes.length === 0) {
         lines.push(this.theme.fg("dim", "No supervised processes."));
      } else {
         for (const [index, process] of this.processes.entries()) {
            const marker = index === this.selected ? this.theme.fg("accent", "❯") : " ";
            const age = formatDuration((process.settledAt ?? Date.now()) - process.spawnTime);
            const row = `${marker} ${statusGlyph(process, this.theme)} ${process.name}  ${this.theme.fg(
               "dim",
               `${process.status} · pid ${process.pid} · ${age}`
            )}`;
            lines.push(truncateToWidth(row, innerWidth, "…"));
         }
      }

      lines.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
      lines.push(this.theme.fg("dim", "j/k select · Enter details · x stop · r restart · Esc close"));
      const targetRows = Math.max(lines.length, this.tui.terminal.rows || lines.length);
      while (lines.length < targetRows) lines.push("");
      return lines.slice(0, targetRows);
   }
}

/** Open the standalone process dashboard in the terminal's full-screen surface. */
export async function showProcessDashboard(ctx: ExtensionContext, runtime: ProcessesRuntime): Promise<void> {
   let releaseAlternateScreen: (() => void) | undefined;
   let dashboard: ProcessDashboard | undefined;
   try {
      await ctx.ui.custom<void>(
         (tui, theme, keybindings, done) => {
            dashboard = new ProcessDashboard(
               tui,
               theme,
               keybindings,
               runtime,
               () => {
                  dashboard?.dispose();
                  done(undefined);
               },
               async (name) => {
                  await openProcessDetail(ctx, runtime, name);
                  tui.requestRender();
               }
            );
            releaseAlternateScreen = enterAlternateScreen(tui, dashboard);
            return dashboard;
         },
         { overlay: false }
      );
   } finally {
      dashboard?.dispose();
      releaseAlternateScreen?.();
   }
}
