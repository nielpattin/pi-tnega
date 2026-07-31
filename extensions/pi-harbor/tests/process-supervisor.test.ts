import { describe, it, expect } from "vitest";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";
import { ConcurrencyLimitError } from "../src/domain.js";
import { ManagedRuntime, Layer } from "effect";

describe("ProcessSupervisor & ShellExecutor Service", () => {
  const LiveLayer = ProcessSupervisor.layer.pipe(
    Layer.provide(ShellExecutor.layer)
  );
  const runtime = ManagedRuntime.make(LiveLayer);

  it("starts a background process and updates status to running", async () => {
    const entry = await runtime.runPromise(
      ProcessSupervisor.use((svc) =>
        svc.start({
          name: "proc-1",
          command: "node -e \"setTimeout(() => {}, 5000)\""
        })
      )
    );

    expect(entry.name).toBe("proc-1");
    expect(entry.status).toBe("running");
    expect(entry.pid).toBeGreaterThan(0);

    // Stop process
    const stopped = await runtime.runPromise(
      ProcessSupervisor.use((svc) => svc.stop("proc-1"))
    );
    expect(stopped.status).toBe("exited");
  });

  it("lists active processes via ps", async () => {
    const list = await runtime.runPromise(
      ProcessSupervisor.use((svc) => svc.ps)
    );
    expect(Array.isArray(list)).toBe(true);
  });

  it("rejects when MAX_RUNNING_PROCESSES (8) cap is exceeded", async () => {
    const testRuntime = ManagedRuntime.make(LiveLayer);
    const names: string[] = [];

    // Start 8 processes (sequential so the cap check sees a deterministic count)
    await Array.from({ length: 8 }, (_, index) => index + 1).reduce(
      async (prev, i) => {
        await prev;
        const name = `proc-cap-${i}`;
        names.push(name);
        await testRuntime.runPromise(
          ProcessSupervisor.use((svc) =>
            svc.start({
              name,
              command: "node -e \"setTimeout(() => {}, 10000)\""
            })
          )
        );
      },
      Promise.resolve()
    );

    // 9th start should fail with ConcurrencyLimitError
    const exit = await testRuntime.runPromiseExit(
      ProcessSupervisor.use((svc) =>
        svc.start({
          name: "proc-cap-9",
          command: "node -e \"console.log(1)\""
        })
      )
    );

    expect(exit._tag).toBe("Failure");
    const _tagNarrowed = exit as Extract<typeof exit, { _tag: "Failure" }>;
   expect(JSON.stringify(_tagNarrowed.cause)).toContain("ConcurrencyLimitError");

    // Cleanup spawned processes
    await Promise.all(
      names.map((n) =>
        testRuntime.runPromise(
          ProcessSupervisor.use((svc) => svc.stop(n))
        )
      )
    );
  });
});
