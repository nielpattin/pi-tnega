import { describe, it, expect } from "vitest";
import { makeHarborRuntime, runTool } from "../src/runtime.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { Effect } from "effect";

describe("Harbor Runtime Integration", () => {
  const runtime = makeHarborRuntime();

  it("spawns tasks and queries job registry through HarborLive runtime", async () => {
    const job = await runTool(
      runtime,
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Runtime integration task test",
          name: "IntegrationTask"
        })
      )
    );

    expect(job.id).toBeDefined();
    expect(job.status).toBe("running");

    const fetchedJob = await runTool(
      runtime,
      JobRegistry.use((reg) => reg.get(job.id))
    );

    expect(fetchedJob).toBeDefined();
    expect(fetchedJob?.id).toBe(job.id);
  });

  it("handles process supervision via runtime", async () => {
    const proc = await runTool(
      runtime,
      ProcessSupervisor.use((svc) =>
        svc.start({
          name: "proc-rt-1",
          command: "node -e process.exit(0)"
        })
      )
    );

    expect(proc.name).toBe("proc-rt-1");
  });

  it("handles operation abortion / cancellation in runTool", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTool(
        runtime,
        Effect.sleep("10 seconds"),
        { signal: controller.signal }
      )
    ).rejects.toThrow("Operation was aborted.");
  });
});
