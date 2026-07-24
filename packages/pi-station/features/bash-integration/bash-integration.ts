// Bash mode integration — owns shell session, transcript, engine lifecycle.
// Wraps bash-mode primitives behind an interface that index.ts can call.

import { existsSync } from "node:fs";
import {
   appendProjectHistory,
   matchHistoryEntries,
   readGlobalShellHistory,
   readProjectHistory
} from "../bash-mode/history.ts";
import { ManagedShellSession } from "../bash-mode/shell-session.ts";
import { BashTranscriptStore } from "../bash-mode/transcript.ts";
import { BashCompletionEngine } from "../bash-mode/completion.ts";
import type { BashModeSettings } from "../bash-mode/types.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BashIntegrationCallbacks {
   requestStatusRender: (delayMs?: number) => void;
   getCwd: () => string | undefined;
   getCurrentEditor: () => any;
}

// ═══════════════════════════════════════════════════════════════════════════
// BashModeIntegration
// ═══════════════════════════════════════════════════════════════════════════

export class BashModeIntegration {
   active = false;
   transcript: BashTranscriptStore;
   completionEngine: BashCompletionEngine;
   session: ManagedShellSession | null = null;
   private settings: BashModeSettings;
   private callbacks: BashIntegrationCallbacks;

   constructor(settings: BashModeSettings, callbacks: BashIntegrationCallbacks) {
      this.settings = settings;
      this.callbacks = callbacks;
      this.transcript = new BashTranscriptStore(settings);
      this.completionEngine = new BashCompletionEngine();
   }

   /** Reload settings mid-session (called on session_start). */
   reloadSettings(settings: BashModeSettings): void {
      this.settings = settings;
      this.transcript = new BashTranscriptStore(settings);
      this.completionEngine = new BashCompletionEngine();
   }

   getShellPath(): string {
      const envShell = process.env.SHELL;
      if (envShell && envShell.length > 0) {
         return envShell;
      }

      if (process.platform === "win32") {
         // Git for Windows installs bash in these locations.
         // Use explicit paths to avoid WSL bash.exe in System32.
         const gitBashCandidates = [String.raw`C:\Program Files\Git\bin\bash.exe`];
         for (const candidate of gitBashCandidates) {
            if (existsSync(candidate)) {
               return candidate;
            }
         }
         // Fallback: bash.exe from PATH (Git for Windows adds itself).
         return "bash.exe";
      }

      return "/bin/sh";
   }

   getShellCwd(): string {
      return this.session?.state.cwd ?? "";
   }

   /** Dispose the shell session. */
   disposeSession(): void {
      this.session?.dispose();
      this.session = null;
      this.active = false;
   }

   /** Reset shell session and transcript. */
   async resetSession(): Promise<void> {
      this.session?.dispose();
      this.session = null;
      this.transcript.clear();
   }

   /** Get shell history entries matching prefix. */
   getHistoryEntries(cwd: string | undefined, prefix: string): string[] {
      const project = matchHistoryEntries(
         readProjectHistory(cwd ?? process.cwd()).map((entry) => entry.command),
         prefix,
         50
      );
      const global = matchHistoryEntries(readGlobalShellHistory(this.getShellPath()), prefix, 50);
      return [...new Set([...project, ...global])];
   }

   /** Ensure a shell session exists and is ready. */
   async ensureSession(cwd: string | undefined): Promise<ManagedShellSession> {
      if (!this.session) {
         this.session = new ManagedShellSession(
            this.getShellPath(),
            cwd ?? process.cwd(),
            this.transcript,
            () => this.callbacks.requestStatusRender(),
            (command, sessionCwd) => appendProjectHistory(cwd ?? process.cwd(), command, sessionCwd)
         );
      }
      await this.session.ensureReady();
      return this.session;
   }

   /** Run a shell command. */
   async runCommand(
      command: string,
      ctx: { cwd?: string; ui: { notify: (msg: string, level: string) => void } }
   ): Promise<void> {
      return this.runCommandWithCwd(command, ctx.cwd, (msg, lvl) => ctx.ui.notify(msg, lvl));
   }

   private async runCommandWithCwd(
      command: string,
      cwd: string | undefined,
      notify: (msg: string, level: string) => void
   ): Promise<void> {
      try {
         const session = await this.ensureSession(cwd);
         await session.runCommand(command);
         this.callbacks.requestStatusRender();
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         notify(`Failed to run shell command: ${message}`, "error");
      }
   }

   /** Toggle bash mode on/off. */
   async setActive(
      value: boolean,
      ctx: { cwd?: string; ui: { notify: (msg: string, level: string) => void } }
   ): Promise<void> {
      const editor = this.callbacks.getCurrentEditor();
      const notify = (msg: string, level: string) => ctx.ui.notify(msg, level);
      const { cwd } = ctx;

      if (value === this.active) {
         return;
      }
      if (!value && this.session?.state.running) {
         notify("Wait for the current shell command to finish before leaving bash mode", "warning");
         return;
      }

      if (value) {
         try {
            const session = await this.ensureSession(cwd);
            this.active = true;
            editor?.dismissBashModeUi?.();
            editor?.refreshGhostSuggestion?.();
            this.callbacks.requestStatusRender();
            notify(`Bash mode enabled (${session.state.shellName})`, "info");
         } catch (error) {
            this.disposeSession();
            this.callbacks.requestStatusRender();
            const message = error instanceof Error ? error.message : String(error);
            notify(`Failed to start shell session: ${message}`, "error");
         }
         return;
      }

      this.active = false;
      editor?.dismissBashModeUi?.();
      this.callbacks.requestStatusRender();
      notify("Bash mode disabled", "info");
   }

   renderTranscript(width: number, theme: Theme): string[] {
      if (!this.active) {
         return [];
      }

      const snapshot = this.transcript.getSnapshot();
      if (snapshot.commands.length === 0) {
         return [];
      }

      const shellName = this.session?.state.shellName ?? "shell";
      const promptGlyph = shellName === "fish" ? ">" : "$";
      const lines: string[] = [];

      if (snapshot.truncatedCommands > 0) {
         lines.push(
            ` ${theme.fg("dim", `... ${snapshot.truncatedCommands} earlier command${snapshot.truncatedCommands === 1 ? "" : "s"} truncated`)}`
         );
      }

      for (const command of snapshot.commands) {
         const status =
            command.exitCode === null
               ? theme.fg("accent", "running")
               : command.exitCode === 0
                 ? theme.fg("success", "ok")
                 : theme.fg("error", `exit ${command.exitCode}`);
         const commandLine = truncateToWidth(
            command.command.replace(/\s+/g, " ").trim(),
            Math.max(8, width - 8),
            "..."
         );
         lines.push(
            ` ${theme.fg("accent", promptGlyph)} ${commandLine} ${theme.fg("dim", "(")}${status}${theme.fg("dim", ")")}`
         );

         for (const outputLine of command.output) {
            lines.push(`   ${truncateToWidth(outputLine, Math.max(1, width - 3), "...")}`);
         }
      }

      return lines;
   }
}
