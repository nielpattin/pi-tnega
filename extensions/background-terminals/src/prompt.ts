/** All model-facing strings for the background-terminals tools. */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatExit, type TerminalSnapshot } from "./domain.ts";
import { MAX_RUNNING, type KillResult } from "./manager.ts";

/** bg_status stdout tail. */
export const STATUS_STDOUT_MAX = 16 * 1024;
/** bg_status stderr tail. */
export const STATUS_STDERR_MAX = 8 * 1024;
/** Completion follow-up stdout tail. Keep this concise; /ps has the detailed view. */
export const RESULT_STDOUT_MAX = 8 * 1024;
/** Completion follow-up stderr tail. Keep this concise; /ps has the detailed view. */
export const RESULT_STDERR_MAX = 4 * 1024;
const STATUS_STDOUT_MAX_LINES = 400;
const STATUS_STDERR_MAX_LINES = 200;
const RESULT_STDOUT_MAX_LINES = 40;
const RESULT_STDERR_MAX_LINES = 20;

export const BG_START_TOOL_DESCRIPTION =
   "Start a long-running shell command as a background terminal (executed via the platform shell — sh -c on POSIX, cmd.exe /d /s /c on Windows). " +
   "Fire-and-forget: this returns immediately with an id, and you get a message with the final output when the process exits. " +
   "The process receives NO stdin (immediate EOF) and there is no way to send input later — interactive commands will not work; use bg_kill to stop a stuck one. " +
   `Terminals are session-scoped: they are killed when the session ends or reloads. Output shown to you is tail-truncated (stdout ${formatSize(STATUS_STDOUT_MAX)}, stderr ${formatSize(STATUS_STDERR_MAX)}); the full logs are captured to files and in the /ps viewer. ` +
   `Max ${MAX_RUNNING} background terminals can run at once.`;

export const BG_START_PROMPT_SNIPPET =
   "Run a long-lived shell command in the background (dev servers, builds, watchers); output is captured and you're notified on exit";

export const BG_START_PROMPT_GUIDELINES = [
   "Use bg_start for commands expected to run long or indefinitely (servers, watch modes, long builds); use the regular bash tool for quick commands.",
   "bg_start processes receive no stdin — never start a command that requires interactive input.",
   "After bg_start, keep working; the exit result arrives automatically. Use bg_status only when you need current output before continuing.",
   'Prefer a stable `name` (1-48 chars) for long-lived services so you can address them later as `bg_status(id: "web")` / `bg_logs(id: "web")` / `bg_kill(ids: ["web"])`. Names must be unique among currently running terminals; reuse is allowed after settle.',
   "For servers and watchers, pass `ready` so you know when the process is actually up: `ready.log` (regex on captured output) and/or `ready.port` (TCP accept). Both must pass when both are set. On timeout the process stays running and the tool reports timed out — do not assume readiness.",
   "Use bg_logs (not repeated bg_status) to read retained logs with cursor pagination, grep, head/tail, or follow. Reuse the returned cursor. Prefer automatic exit messages over polling loops."
];

export const BG_START_PARAMETER_DESCRIPTIONS = {
   command:
      "Shell command line to run in the background (sh -c on POSIX, cmd.exe /d /s /c on Windows). It receives no stdin (EOF immediately); interactive commands will not work.",
   title: "Short human-readable name shown in listings and the UI",
   workingDir: "Working directory (default: current working directory)",
   name: "Optional stable handle (1-48 chars), unique among live running terminals",
   ready: "Optional readiness condition: wait for log regex and/or TCP port connection before returning"
};

export const BG_STATUS_TOOL_DESCRIPTION =
   "Peek at a background terminal's status and current output (tail-truncated) without blocking. Accepts terminal id or stable process name.";

export const BG_STATUS_PARAMETER_DESCRIPTIONS = {
   id: 'Terminal id (e.g. "bt-1") or stable name'
};

export const BG_LIST_TOOL_DESCRIPTION =
   "List all background terminals (running and settled) with pid, elapsed time, exit status, and output sizes.";

export const BG_KILL_TOOL_DESCRIPTION =
   "Stop one or more running background terminals (SIGTERM to the whole process tree, escalating to SIGKILL). Accepts terminal ids or stable names.";

export const BG_KILL_PARAMETER_DESCRIPTIONS = {
   ids: 'Terminal ids or names to stop, e.g. ["bt-1", "web-server"]'
};

export const BG_LOGS_TOOL_DESCRIPTION =
   "Retrieve captured output logs from a background terminal with cursor pagination, grep filtering, head/tail slicing, and follow capability.";

export const BG_LOGS_PARAMETER_DESCRIPTIONS = {
   id: 'Terminal id (e.g. "bt-1") or stable process name',
   lines: "Max lines to return (default 100)",
   head: "Read from start instead of tail (default false)",
   grep: "Regex filter pattern",
   cursor: "Byte offset from an earlier bg_logs call",
   follow: "Wait for new output past cursor",
   timeoutSec: "Timeout for follow in seconds (default 30)"
};

export function buildStartResult(snap: TerminalSnapshot) {
   let text =
      `Started background terminal ${snap.id}${snap.name ? ` (${snap.name})` : ""} "${snap.title}" (pid ${snap.pid ?? "?"}, ${snap.cwd}).\n\n` +
      `Command: ${snap.command}\n`;
   if (snap.readyResult) {
      if (snap.readyResult.ready) {
         text += `Readiness condition MET.\n`;
      } else if (snap.readyResult.timedOut) {
         text += `Readiness condition TIMED OUT (process is still running).\n`;
      }
   }
   text +=
      `It runs in the background with no stdin. You'll get a message when it exits, ` +
      `or use bg_status(id: "${snap.name ?? snap.id}") to peek, bg_logs to view/follow logs, bg_kill to stop it, bg_list to see all.`;
   return text;
}

/** One metadata line: `bt-1 (my-name) [running] "dev server" (pid 12345, 3m12s, exit -, /path)`. */
export function describeTerminal(snap: TerminalSnapshot) {
   const details = [
      `pid ${snap.pid ?? "?"}`,
      formatElapsed(snap),
      snap.status === "running" ? "exit -" : formatExit(snap),
      snap.cwd,
      `stdout ${formatSize(snap.stdout.totalBytes)}, stderr ${formatSize(snap.stderr.totalBytes)}`
   ];
   const nameLabel = snap.name ? ` (${snap.name})` : "";
   return `${snap.id}${nameLabel} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

/** Tail-truncated labeled output section with a pointer at the full log. */
function outputSection(label: string, view: TerminalSnapshot["stdout"], maxBytes: number, maxLines: number) {
   if (view.totalBytes === 0) return `${label}: (empty)`;
   const truncation = truncateTail(view.text, {
      maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
      maxLines: Math.min(maxLines, DEFAULT_MAX_LINES)
   });
   let text = `${label}:\n${truncation.content}`;
   const shownBytes = truncation.outputBytes;
   if (truncation.truncated || view.truncatedBytes > 0) {
      const where = view.spillPath ? `Full log: ${view.spillPath}` : "Full output in the /ps viewer";
      text += `\n[${label} truncated: showing last ${formatSize(shownBytes)} of ${formatSize(view.totalBytes)}. ${where}]`;
   }
   return text;
}

export function buildStatusResult(snap: TerminalSnapshot) {
   let text = describeTerminal(snap);
   if (snap.errorText) text += `\nError: ${snap.errorText}`;
   text += `\n\n${outputSection("stdout", snap.stdout, STATUS_STDOUT_MAX, STATUS_STDOUT_MAX_LINES)}`;
   text += `\n\n${outputSection("stderr", snap.stderr, STATUS_STDERR_MAX, STATUS_STDERR_MAX_LINES)}`;
   return text;
}

/** The async completion follow-up injected into the model's context. */
export function buildTerminalResultMessage(snap: TerminalSnapshot) {
   const how = snap.status === "killed" ? "was killed" : `exited (${formatExit(snap)})`;
   let text = `Background terminal ${snap.id} "${snap.title}" ${how} after ${formatElapsed(snap)}.`;
   if (snap.errorText) text += `\nError: ${snap.errorText}`;
   text += `\n\n${outputSection("stdout", snap.stdout, RESULT_STDOUT_MAX, RESULT_STDOUT_MAX_LINES)}`;
   if (snap.stderr.totalBytes > 0) {
      text += `\n\n${outputSection("stderr", snap.stderr, RESULT_STDERR_MAX, RESULT_STDERR_MAX_LINES)}`;
   }
   return text;
}

export function buildKillReport(results: ReadonlyArray<KillResult>) {
   return results
      .map((entry) => {
         if (entry.killed) {
            return `Killed ${entry.id} "${entry.title}" (${entry.exit}).`;
         }
         if (entry.wasRunning) {
            // The natural exit won the race with the kill signal.
            return `${entry.id} "${entry.title}" exited on its own before the kill landed (${entry.exit}).`;
         }
         return `${entry.id} "${entry.title}" was already ${entry.status} (${entry.exit}).`;
      })
      .join("\n");
}
