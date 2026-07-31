import { describe, it, expect } from "vitest";
import { ManagedRuntime, Layer, Effect } from "effect";
import {
   defaultTelemetryReader,
   type ProcessTelemetry,
   type TelemetryReader
} from "../src/utils/process-telemetry.js";
import {
   formatBytes,
   formatCpuPercent,
   formatTelemetryRow,
   formatTelemetrySnapshot
} from "../src/ui/telemetry.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";

describe("Process Telemetry Utilities & Formatters", () => {
   it("formats bytes accurately", () => {
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(2048)).toBe("2.0 KB");
      expect(formatBytes(45123840)).toBe("43.0 MB");
      expect(formatBytes(1073741824)).toBe("1.0 GB");
   });

   it("formats CPU percentage accurately", () => {
      expect(formatCpuPercent(0)).toBe("0.0%");
      expect(formatCpuPercent(12.54)).toBe("12.5%");
      expect(formatCpuPercent(99.9)).toBe("99.9%");
   });

   it("formats telemetry row for available and unavailable states", () => {
      const avail: ProcessTelemetry = {
         status: "available",
         pid: 1234,
         cpuPercent: 14.2,
         memoryRssBytes: 52428800,
         timestamp: Date.now()
      };
      expect(formatTelemetryRow("worker-1", avail)).toBe("[worker-1] CPU: 14.2% | RSS: 50.0 MB");

      const unavail: ProcessTelemetry = {
         status: "unavailable",
         pid: 5678,
         reason: "Process is exited",
         timestamp: Date.now()
      };
      expect(formatTelemetryRow("worker-2", unavail)).toBe(
         "[worker-2] Telemetry unavailable (Process is exited)"
      );
   });

   it("formats telemetry snapshot for multiple processes", () => {
      const snapshot = formatTelemetrySnapshot([
         {
            name: "web",
            telemetry: {
               status: "available",
               pid: 100,
               cpuPercent: 5.0,
               memoryRssBytes: 10485760,
               timestamp: Date.now()
            }
         },
         {
            name: "db",
            telemetry: {
               status: "unavailable",
               pid: 101,
               reason: "Not supported",
               timestamp: Date.now()
            }
         }
      ]);

      expect(snapshot).toContain("[web] CPU: 5.0% | RSS: 10.0 MB");
      expect(snapshot).toContain("[db] Telemetry unavailable (Not supported)");
   });

   it("defaultTelemetryReader returns available state for current process PID", async () => {
      const runtime = ManagedRuntime.make(Layer.empty);
      const result = await runtime.runPromise(defaultTelemetryReader(process.pid));

      expect(result.status).toBe("available");
      const statusNarrowed = result as Extract<typeof result, { status: "available" }>;
      expect(statusNarrowed.pid).toBe(process.pid);
      expect(statusNarrowed.memoryRssBytes).toBeGreaterThan(0);
      await runtime.dispose();
   });

   it("defaultTelemetryReader returns unavailable state for invalid PID", async () => {
      const runtime = ManagedRuntime.make(Layer.empty);
      const result = await runtime.runPromise(defaultTelemetryReader(-1));

      expect(result.status).toBe("unavailable");
      const statusNarrowed = result as Extract<typeof result, { status: "unavailable" }>;
      expect(statusNarrowed.reason).toContain("Invalid");
      await runtime.dispose();
   });
});

describe("ProcessSupervisor.telemetry Integration", () => {
   const LiveLayer = Layer.provide(ProcessSupervisor.layer, ShellExecutor.layer);

   it("returns telemetry using injectable reader", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      const mockReader: TelemetryReader = (pid: number) =>
         Effect.succeed({
            status: "available",
            pid,
            cpuPercent: 25.0,
            memoryRssBytes: 100 * 1024 * 1024,
            timestamp: Date.now()
         });

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "telemetry-proc",
               command: "node -e \"setTimeout(() => {}, 5000)\""
            })
         )
      );

      const telemetry = await runtime.runPromise(
         ProcessSupervisor.use((svc) => svc.telemetry("telemetry-proc", mockReader))
      );

      expect(telemetry.status).toBe("available");
      const statusNarrowed = telemetry as Extract<typeof telemetry, { status: "available" }>;
      expect(statusNarrowed.cpuPercent).toBe(25.0);
      expect(statusNarrowed.memoryRssBytes).toBe(100 * 1024 * 1024);

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.stop("telemetry-proc")));
      await runtime.dispose();
   });

   it("returns explicit unavailable state when process is exited", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "short-proc",
               command: "node -e \"process.exit(0)\""
            })
         )
      );

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.awaitExit("short-proc")));

      const telemetry = await runtime.runPromise(
         ProcessSupervisor.use((svc) => svc.telemetry("short-proc"))
      );

      expect(telemetry.status).toBe("unavailable");
      const statusNarrowed = telemetry as Extract<typeof telemetry, { status: "unavailable" }>;
      expect(statusNarrowed.reason).toContain("exited");

      await runtime.dispose();
   });

   it("fails Effect when process name is not found", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      const exit = await runtime.runPromiseExit(
         ProcessSupervisor.use((svc) => svc.telemetry("missing-proc"))
      );

      expect(exit._tag).toBe("Failure");
      await runtime.dispose();
   });
});
