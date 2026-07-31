import { describe, it, expect } from "vitest";
import { ManagedRuntime, Layer } from "effect";
import { ShellExecutor } from "../src/services/ShellExecutor.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";

describe("Process Stdin Forwarding", () => {
   const LiveLayer = Layer.provide(ProcessSupervisor.layer, ShellExecutor.layer);

   it("ShellExecutor.spawnProcess opens stdin when stdin option is true", async () => {
      const runtime = ManagedRuntime.make(ShellExecutor.layer);
      const child = await runtime.runPromise(
         ShellExecutor.use((svc) =>
            svc.spawnProcess('node -e "process.stdin.on(\\"data\\", d => console.log(d.toString()))"', {
               stdin: true
            })
         )
      );

      expect(child.stdin).not.toBeNull();
      expect(child.stdin?.writable).toBe(true);

      child.kill();
      await runtime.dispose();
   });

   it("ShellExecutor.spawnProcess defaults stdin to false (pipe ignore)", async () => {
      const runtime = ManagedRuntime.make(ShellExecutor.layer);
      const child = await runtime.runPromise(
         ShellExecutor.use((svc) => svc.spawnProcess("node -e \"console.log('hi')\""))
      );

      expect(child.stdin).toBeNull();

      child.kill();
      await runtime.dispose();
   });

   it("ProcessSupervisor writeStdin and closeStdin forward data to process", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      const proc = await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "echo-stdin",
               command:
                  'node -e "process.stdin.resume(); process.stdin.on(\\"data\\", d => { process.stdout.write(d); }); process.stdin.on(\\"end\\", () => process.exit(0));"',
               stdin: true
            })
         )
      );

      expect(proc.status).toBe("running");

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.writeStdin("echo-stdin", "hello\n")));
      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.closeStdin("echo-stdin")));
      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.awaitExit("echo-stdin")));

      const logs = await runtime.runPromise(ProcessSupervisor.use((svc) => svc.logs("echo-stdin", { stream: "both" })));
      expect(logs.lines.join("\n")).toContain("hello");

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.stop("echo-stdin")));
      await runtime.dispose();
   });

   it("ProcessSupervisor writeStdin fails when process does not exist", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);
      const result = await runtime.runPromiseExit(
         ProcessSupervisor.use((svc) => svc.writeStdin("non-existent", "data"))
      );

      expect(result._tag).toBe("Failure");
      await runtime.dispose();
   });

   it("ProcessSupervisor writeStdin fails when process stdin was not enabled", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "no-stdin-proc",
               command: "node -e \"console.log('no stdin')\""
            })
         )
      );

      const result = await runtime.runPromiseExit(
         ProcessSupervisor.use((svc) => svc.writeStdin("no-stdin-proc", "data"))
      );
      expect(result._tag).toBe("Failure");

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.stop("no-stdin-proc")));
      await runtime.dispose();
   });

   it("ProcessSupervisor writeStdin fails when process has exited", async () => {
      const runtime = ManagedRuntime.make(LiveLayer);

      await runtime.runPromise(
         ProcessSupervisor.use((svc) =>
            svc.start({
               name: "quick-exit",
               command: "node -e \"process.exit(0)\"",
               stdin: true
            })
         )
      );

      await runtime.runPromise(ProcessSupervisor.use((svc) => svc.awaitExit("quick-exit")));

      const result = await runtime.runPromiseExit(
         ProcessSupervisor.use((svc) => svc.writeStdin("quick-exit", "data"))
      );
      expect(result._tag).toBe("Failure");

      await runtime.dispose();
   });
});
