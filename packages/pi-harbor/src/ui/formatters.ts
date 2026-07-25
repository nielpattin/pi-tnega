import type { Job, ProcessEntry } from "../domain.js";

const JOB_HEADER = "ID       | NAME             | STATUS     | AGENT (HARNESS)| DURATION";
const PROC_HEADER = "ID       | NAME             | STATUS     | PID    | DURATION";

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

export function formatJobRow(job: Job, now: number = Date.now()): string {
   const nameStr = job.name ?? "-";
   const harnessStr = job.harness ? `${job.agent ?? "task"} (${job.harness})` : (job.agent ?? "task");

   let durationMs = 0;
   if (job.settledAt) {
      durationMs = job.settledAt - (job.startedAt ?? job.createdAt);
   } else if (job.startedAt) {
      durationMs = now - job.startedAt;
   } else {
      durationMs = now - job.createdAt;
   }

   const durationStr = formatDuration(durationMs);
   return `${job.id.padEnd(8)} | ${nameStr.padEnd(16)} | ${job.status.padEnd(10)} | ${harnessStr.padEnd(14)} | ${durationStr}`;
}

export function formatProcessRow(proc: ProcessEntry, now: number = Date.now()): string {
   const nameStr = proc.name ?? "-";
   const pidStr = proc.pid ? String(proc.pid) : "-";
   const durationMs = proc.settledAt ? proc.settledAt - proc.spawnTime : now - proc.spawnTime;
   const durationStr = formatDuration(durationMs);

   return `${proc.id.padEnd(8)} | ${nameStr.padEnd(16)} | ${proc.status.padEnd(10)} | PID:${pidStr.padEnd(6)} | ${durationStr}`;
}

export function formatJobTable(jobs: ReadonlyArray<Job>, now: number = Date.now()): string {
   if (jobs.length === 0) return "No active jobs.";
   const separator = "-".repeat(JOB_HEADER.length);
   const rows = jobs.map((j) => formatJobRow(j, now));
   return [JOB_HEADER, separator, ...rows].join("\n");
}

export function formatProcessTable(processes: ReadonlyArray<ProcessEntry>, now: number = Date.now()): string {
   if (processes.length === 0) return "No active processes.";
   const separator = "-".repeat(PROC_HEADER.length);
   const rows = processes.map((p) => formatProcessRow(p, now));
   return [PROC_HEADER, separator, ...rows].join("\n");
}
