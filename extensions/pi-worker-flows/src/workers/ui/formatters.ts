import type { Job } from "../domain.js";

const RUN_HEADER = "ID       | NAME             | STATUS     | AGENT          | DURATION";

export function formatDuration(ms: number): string {
   if (ms < 0) ms = 0;
   if (ms < 1000) return `${Math.floor(ms)}ms`;
   const totalSeconds = Math.floor(ms / 1000);
   if (totalSeconds < 60) {
      const tenths = ((ms % 1000) / 1000).toFixed(1).slice(1);
      return tenths === ".0" ? `${totalSeconds}s` : `${totalSeconds}${tenths}s`;
   }
   const minutes = Math.floor(totalSeconds / 60);
   const seconds = totalSeconds % 60;
   if (minutes < 60) {
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
   }
   const hours = Math.floor(minutes / 60);
   const remMinutes = minutes % 60;
   return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function formatRunRow(run: Job, now: number = Date.now()): string {
   const nameStr = run.name ?? "-";
   const agentStr = run.agent ?? "worker";

   let durationMs = 0;
   if (run.settledAt) {
      durationMs = run.settledAt - (run.startedAt ?? run.createdAt);
   } else if (run.startedAt) {
      durationMs = now - run.startedAt;
   } else {
      durationMs = now - run.createdAt;
   }

   const durationStr = formatDuration(durationMs);
   return `${run.id.padEnd(8)} | ${nameStr.padEnd(16)} | ${run.status.padEnd(10)} | ${agentStr.padEnd(14)} | ${durationStr}`;
}

export function formatRunTable(runs: ReadonlyArray<Job>, now: number = Date.now()): string {
   if (runs.length === 0) return "No active runs.";
   const separator = "-".repeat(RUN_HEADER.length);
   const rows = runs.map((run) => formatRunRow(run, now));
   return [RUN_HEADER, separator, ...rows].join("\n");
}
