import { describe, it, expect } from "vitest";
import { TaskManager } from "../src/services/TaskManager.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { ConcurrencyLimitError } from "../src/domain.js";
import { ManagedRuntime, Layer } from "effect";

describe("TaskManager Service", () => {
  const LiveLayer = TaskManager.layer.pipe(
    Layer.provide(JobRegistry.layer)
  );
  const runtime = ManagedRuntime.make(LiveLayer);

  it("spawns a task and sets status to running using reservation window", async () => {
    const job = await runtime.runPromise(
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Run research task",
          name: "Research"
        })
      )
    );

    expect(job.id).toBeDefined();
    expect(job.id).toMatch(/^task-\d+$/);
    expect(job.status).toBe("running");
  });

  it("rejects when MAX_RUNNING_AGENTS (4) cap is exceeded", async () => {
    const testRuntime = ManagedRuntime.make(LiveLayer);
    const jobs: string[] = [];

    // Spawn 4 running tasks
    for (let i = 1; i <= 4; i++) {
      const j = await testRuntime.runPromise(
        TaskManager.use((svc) =>
          svc.spawnTask({
            task: `Task ${i}`
          })
        )
      );
      jobs.push(j.id);
    }

    // 5th task spawn must fail with ConcurrencyLimitError
    const exit = await testRuntime.runPromiseExit(
      TaskManager.use((svc) =>
        svc.spawnTask({
          task: "Task 5"
        })
      )
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("ConcurrencyLimitError");
    }
  });
});
