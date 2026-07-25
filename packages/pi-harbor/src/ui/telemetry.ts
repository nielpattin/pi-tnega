import type { ProcessTelemetry } from "../utils/process-telemetry.js";

export function formatBytes(bytes: number): string {
   if (bytes < 0) return "0 B";
   if (bytes < 1024) return `${bytes} B`;
   const kb = bytes / 1024;
   if (kb < 1024) return `${kb.toFixed(1)} KB`;
   const mb = kb / 1024;
   if (mb < 1024) return `${mb.toFixed(1)} MB`;
   const gb = mb / 1024;
   return `${gb.toFixed(1)} GB`;
}

export function formatCpuPercent(cpuPercent: number): string {
   if (cpuPercent < 0) return "0.0%";
   return `${cpuPercent.toFixed(1)}%`;
}

export function formatTelemetryRow(name: string, telemetry: ProcessTelemetry): string {
   if (telemetry.status === "available") {
      const cpuStr = formatCpuPercent(telemetry.cpuPercent);
      const rssStr = formatBytes(telemetry.memoryRssBytes);
      return `[${name}] CPU: ${cpuStr} | RSS: ${rssStr}`;
   }
   return `[${name}] Telemetry unavailable (${telemetry.reason})`;
}

export function formatTelemetrySnapshot(entries: Array<{ name: string; telemetry: ProcessTelemetry }>): string {
   if (entries.length === 0) return "No process telemetry available.";
   return entries.map((e) => formatTelemetryRow(e.name, e.telemetry)).join("\n");
}
