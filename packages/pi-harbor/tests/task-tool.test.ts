import { describe, expect, it } from "vitest";
import { ManagedRuntime, Layer } from "effect";
import { TaskToolParamsSchema, taskToolDefinition, handleTask } from "../src/tools/task.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { JobRegistry } from "../src/services/JobRegistry.js";

describe("task tool", () => {
  function makeTestRuntime() {
    const TestLayer = TaskManager.layer.pipe(Layer.provideMerge(JobRegistry.layer));
    return ManagedRuntime.make(TestLayer);
  }

  it("exports valid task tool definition and schema", () => {
    expect(taskToolDefinition.name).toBe("task");
    expect(TaskToolParamsSchema).toBeDefined();
  });

  it("handles single flat task execution (async by default)", async () => {
    const runtime = makeTestRuntime();
    const res = await runtime.runPromise(
      handleTask({
        task: "do single task",
        name: "my-task",
        agent: "scout"
      })
    );

    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.jobs[0].name).toBe("my-task");
    expect(res.jobs[0].agent).toBe("scout");
    expect(res.jobs[0].async).toBe(true);
    expect(res.jobs[0].id).toMatch(/^task-\d+/);
  });

  it("prepends context to batch tasks when provided", async () => {
    const runtime = makeTestRuntime();
    const res = await runtime.runPromise(
      handleTask({
        context: "Global Context Here",
        tasks: [
          { task: "task 1", name: "t1" },
          { task: "task 2", name: "t2" }
        ]
      })
    );

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);

    const job1 = await runtime.runPromise(JobRegistry.use((svc) => svc.get(res.jobs[0].id)));
    expect(job1?.promptOrCommand).toBe("Global Context Here\n\ntask 1");
  });

  it("handles mixed sync/async batch response shape", async () => {
    const runtime = makeTestRuntime();
    // For sync tasks, update job status to completed in background so awaitSettlement resolves
    const taskPromise = runtime.runPromise(
      handleTask({
        tasks: [
          { task: "async task", name: "t-async", async: true },
          { task: "sync task", name: "t-sync", async: false }
        ]
      })
    );

    // Give microtask time to register job, then settle sync task
    setTimeout(async () => {
      await runtime.runPromise(
        JobRegistry.use((svc) => svc.updateStatus("task-2", "completed", { resultData: { done: true } }))
      );
    }, 10);

    const res = await taskPromise;

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.batchId).toMatch(/^batch-/);
    expect(Array.isArray(res.jobs)).toBe(true);
    expect(res.jobs[0].async).toBe(true);
    expect(res.jobs[1].async).toBe(false);
    expect(res.jobs[1].status).toBe("completed");
    expect(res.syncSettled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.aborted).toBe(false);
  });
});
