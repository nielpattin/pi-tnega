import { Effect } from "effect";

export type ProcessTelemetry =
   | {
        status: "available";
        pid: number;
        cpuPercent: number;
        memoryRssBytes: number;
        memoryVmsBytes?: number;
        timestamp: number;
     }
   | {
        status: "unavailable";
        pid: number;
        reason: string;
        timestamp: number;
     };

export type TelemetryReader = (pid: number) => Effect.Effect<ProcessTelemetry>;

export const defaultTelemetryReader: TelemetryReader = (pid: number) =>
   Effect.sync(() => {
      if (pid <= 0) {
         return {
            status: "unavailable",
            pid,
            reason: "Invalid process PID",
            timestamp: Date.now()
         };
      }

      if (pid === process.pid) {
         const mem = process.memoryUsage();
         return {
            status: "available",
            pid,
            cpuPercent: 0.0,
            memoryRssBytes: mem.rss,
            memoryVmsBytes: mem.heapTotal,
            timestamp: Date.now()
         };
      }

      return {
         status: "unavailable",
         pid,
         reason: "Platform telemetry not supported for external PID without native sampler",
         timestamp: Date.now()
      };
   });
