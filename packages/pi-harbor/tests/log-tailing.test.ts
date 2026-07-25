import { describe, it, expect } from "vitest";
import { ManagedRuntime, Layer } from "effect";
import {
   filterLogLines,
   paginateLogLines,
   formatMultiProcessLogLines,
   selectLogStream
} from "../src/ui/log-viewer.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";

describe("Pure Log Viewer Helpers", () => {
   const sampleLines = [
      "[INFO] Application starting",
      "[DEBUG] Initializing database connection",
      "[INFO] Database connected successfully",
      "[WARN] High memory usage detected",
      "[ERROR] Failed to fetch remote resource",
      "[INFO] Task execution completed"
   ];

   it("filters log lines with string or regex grep", () => {
      const infoLines = filterLogLines(sampleLines, "INFO");
      expect(infoLines).toHaveLength(3);
      expect(infoLines[0]).toContain("Application starting");

      const regexLines = filterLogLines(sampleLines, "(ERROR|WARN)");
      expect(regexLines).toHaveLength(2);
      expect(regexLines[0]).toContain("WARN");
      expect(regexLines[1]).toContain("ERROR");
   });

   it("paginates log lines in tail mode without cursor", () => {
      const result = paginateLogLines(sampleLines, { lines: 3, head: false });
      expect(result.lines).toEqual([
         "[WARN] High memory usage detected",
         "[ERROR] Failed to fetch remote resource",
         "[INFO] Task execution completed"
      ]);
      expect(result.cursor).toBe(6);
      expect(result.totalLines).toBe(6);
   });

   it("paginates log lines in head mode with cursor", () => {
      const page1 = paginateLogLines(sampleLines, { head: true, lines: 2, cursor: 0 });
      expect(page1.lines).toEqual([
         "[INFO] Application starting",
         "[DEBUG] Initializing database connection"
      ]);
      expect(page1.cursor).toBe(2);

      const page2 = paginateLogLines(sampleLines, { head: true, lines: 2, cursor: page1.cursor });
      expect(page2.lines).toEqual([
         "[INFO] Database connected successfully",
         "[WARN] High memory usage detected"
      ]);
      expect(page2.cursor).toBe(4);
   });

   it("paginates log lines in tail mode with cursor for incremental tailing", () => {
      const initial = paginateLogLines(sampleLines, { lines: 4, head: false });
      expect(initial.cursor).toBe(6);

      const newLines = [...sampleLines, "[INFO] New line 7", "[INFO] New line 8"];
      const next = paginateLogLines(newLines, { lines: 10, head: false, cursor: initial.cursor });
      expect(next.lines).toEqual(["[INFO] New line 7", "[INFO] New line 8"]);
      expect(next.cursor).toBe(8);
   });

   it("formats multi-process logs with process name prefix", () => {
      const formatted = formatMultiProcessLogLines([
         { name: "web", lines: ["listening on 8080", "ready"] },
         { name: "worker", lines: ["job started"] }
      ]);
      expect(formatted).toEqual([
         "[web] listening on 8080",
         "[web] ready",
         "[worker] job started"
      ]);
   });

   it("selects stdout, stderr, or both log streams", () => {
      const stdout = "out1\nout2";
      const stderr = "err1\nerr2";

      expect(selectLogStream(stdout, stderr, "stdout")).toEqual(["out1", "out2"]);
      expect(selectLogStream(stdout, stderr, "stderr")).toEqual(["err1", "err2"]);
      expect(selectLogStream(stdout, stderr, "both")).toEqual(["out1", "out2", "err1", "err2"]);
   });
});

describe("ProcessSupervisor.logs Service Integration", () => {
   const LiveLayer = Layer.provide(ProcessSupervisor.layer, ShellExecutor.layer);

   it("returns stdout/stderr/both logs with grep and line limit", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "proc-logs",
               command:
                  'node -e "console.log(\\"STDOUT_1\\"); console.error(\\"STDERR_1\\"); console.log(\\"STDOUT_2\\");"'
            })
         )
      );

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.awaitExit("proc-logs")));

      const stdoutLogs = await runtime.runPromise(
         ProcessSupervisor.use((svc) => svc.logs("proc-logs", { stream: "stdout" }))
      );
      expect(stdoutLogs.lines.join("\n")).toContain("STDOUT_1");
      expect(stdoutLogs.lines.join("\n")).not.toContain("STDERR_1");

      const stderrLogs = await runtime.runPromise(
         ProcessSupervisor.use((svc) => svc.logs("proc-logs", { stream: "stderr" }))
      );
      expect(stderrLogs.lines.join("\n")).toContain("STDERR_1");

      const grepLogs = await runtime.runPromise(
         ProcessSupervisor.use((svc) => svc.logs("proc-logs", { stream: "both", grep: "STDOUT_2" }))
      );
      expect(grepLogs.lines.join("\n")).toContain("STDOUT_2");
      expect(grepLogs.lines).toHaveLength(1);

      await runtime.dispose();
   });

   it("supports multi-process log tailing with array of process names", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "web-app",
               command: 'node -e "console.log(\\"web server ready\\")"'
            })
         )
      );

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "db-app",
               command: 'node -e "console.log(\\"db connected\\")"'
            })
         )
      );

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.awaitExit("web-app")));
      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.awaitExit("db-app")));

      const multiLogs = await runtime.runPromise(
         ProcessSupervisor.use((svc) => svc.logs(["web-app", "db-app"] as any))
      );

      expect(multiLogs.lines).toContain("[web-app] web server ready");
      expect(multiLogs.lines).toContain("[db-app] db connected");
      expect(multiLogs.cursor).toBeGreaterThan(0);

      await runtime.dispose();
   });
});
