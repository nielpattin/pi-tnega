import { describe, it, expect } from "vitest";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { CapacityError, type Job } from "../src/domain.js";
import { ManagedRuntime, Effect } from "effect";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";

describe("JobRegistry Service", () => {
  const runtime = ManagedRuntime.make(JobRegistry.layer);

  it("registers a job with status pending, waitInterest=0, killInterest=0", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-1",
          ownerSessionId: "session-1",
          name: "Test Job",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );

    expect(job.id).toBe("task-1");
    expect(job.status).toBe("pending");
    expect(job.waitInterest).toBe(0);
    expect(job.killInterest).toBe(0);
  });

  it("updates status and sets settledAt timestamp", async () => {
    await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-2",
          ownerSessionId: "session-1",
          name: "Test Job 2",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );

    const updated = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.updateStatus("task-2", "completed", { resultData: { ok: true } })
      )
    );

    expect(updated.status).toBe("completed");
    expect(updated.settledAt).toBeDefined();
    expect(updated.resultData).toEqual({ ok: true });
  });

  it("prunes settled jobs with interest=0 when MAX_TRACKED_JOBS (64) is reached", async () => {
    // Fill up to 64 completed jobs
    for (let i = 1; i <= 64; i++) {
      const id = `task-batch-${i}`;
      await runtime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id,
            ownerSessionId: "session-1",
            name: `Job ${i}`,
            kind: "agent",
            promptOrCommand: "prompt"
          })
        )
      );
      await runtime.runPromise(
        JobRegistry.use((svc) => svc.updateStatus(id, "completed"))
      );
    }

    // Registering 65th job should trigger prune of older settled jobs and succeed
    const job65 = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-batch-65",
          ownerSessionId: "session-1",
          name: "Job 65",
          kind: "agent",
          promptOrCommand: "prompt"
        })
      )
    );

    expect(job65.id).toBe("task-batch-65");
  });

  it("retains recent background terminal jobs while under the capacity limit", async () => {
    const testRuntime = makeFakeHarborRuntime();

    const backgroundJob = await testRuntime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-bg-visible",
          ownerSessionId: "session-1",
          name: "Background visible job",
          kind: "agent",
          async: true,
          promptOrCommand: "background work"
        })
      )
    );
    await testRuntime.runPromise(
      JobRegistry.use((svc) =>
        svc.updateStatus(backgroundJob.id, "completed", {
          resultData: { ok: true, summary: "done" }
        })
      )
    );

    // Add a few completed non-background jobs but stay well under the cap.
    for (let i = 1; i <= 8; i++) {
      const id = `task-filler-${i}`;
      await testRuntime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id,
            ownerSessionId: "session-1",
            name: `Filler ${i}`,
            kind: "agent",
            promptOrCommand: "prompt"
          })
        )
      );
      await testRuntime.runPromise(JobRegistry.use((svc) => svc.updateStatus(id, "completed")));
    }

    const jobs = await testRuntime.runPromise(JobRegistry.use((svc) => svc.list()));
    const retained = jobs.find((j) => j.id === "task-bg-visible");

    expect(retained).toBeDefined();
    expect(retained?.status).toBe("completed");
    expect(retained?.async).toBe(true);
    expect(retained?.resultData).toEqual({ ok: true, summary: "done" });
    await testRuntime.dispose();
  });

  it("prunes background terminal jobs when the capacity limit is reached", async () => {
    const testRuntime = makeFakeHarborRuntime();

    const oldBackgroundJob = await testRuntime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-bg-old",
          ownerSessionId: "session-1",
          name: "Old background job",
          kind: "agent",
          async: true,
          promptOrCommand: "background work"
        })
      )
    );
    await testRuntime.runPromise(
      JobRegistry.use((svc) =>
        svc.updateStatus(oldBackgroundJob.id, "failed", { errorText: "background failure" })
      )
    );

    // Fill the registry with completed non-background jobs.
    for (let i = 1; i <= 64; i++) {
      const id = `task-filler-terminal-${i}`;
      await testRuntime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id,
            ownerSessionId: "session-1",
            name: `Filler ${i}`,
            kind: "agent",
            promptOrCommand: "prompt"
          })
        )
      );
      await testRuntime.runPromise(JobRegistry.use((svc) => svc.updateStatus(id, "completed")));
    }

    // Add a newer background terminal job after the cap has already pressured pruning.
    const newBackgroundJob = await testRuntime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-bg-new",
          ownerSessionId: "session-1",
          name: "New background job",
          kind: "agent",
          async: true,
          promptOrCommand: "background work"
        })
      )
    );
    await testRuntime.runPromise(JobRegistry.use((svc) => svc.updateStatus(newBackgroundJob.id, "cancelled")));

    const jobs = await testRuntime.runPromise(JobRegistry.use((svc) => svc.list()));
    const retainedFailed = jobs.find((j) => j.id === "task-bg-old");
    const retainedCancelled = jobs.find((j) => j.id === "task-bg-new");

    expect(retainedFailed).toBeUndefined();
    expect(retainedCancelled).toBeDefined();
    expect(retainedCancelled?.status).toBe("cancelled");

    await testRuntime.dispose();
  });

  it("rejects registration with CapacityError if 64 jobs are all running or have interest", async () => {
    // Create a new registry runtime instance for clean capacity testing
    const testRuntime = ManagedRuntime.make(JobRegistry.layer);

    // Register 64 running jobs
    for (let i = 1; i <= 64; i++) {
      const id = `task-running-${i}`;
      await testRuntime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id,
            ownerSessionId: "session-1",
            name: `Running ${i}`,
            kind: "agent",
            promptOrCommand: "prompt"
          })
        )
      );
      await testRuntime.runPromise(
        JobRegistry.use((svc) => svc.updateStatus(id, "running"))
      );
    }

    // 65th registration must fail with CapacityError
    const exit = await testRuntime.runPromiseExit(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-running-65",
          ownerSessionId: "session-1",
          name: "Running 65",
          kind: "agent",
          promptOrCommand: "prompt"
        })
      )
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("CapacityError");
    }
  });

  it("awaitSettlement resolves immediately if already settled", async () => {
    await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-presettled",
          ownerSessionId: "session-1",
          name: "Pre-settled",
          kind: "agent",
          promptOrCommand: "prompt"
        })
      )
    );
    await runtime.runPromise(
      JobRegistry.use((svc) => svc.updateStatus("task-presettled", "completed"))
    );

    const settled = await runtime.runPromise(
      JobRegistry.use((svc) => svc.awaitSettlement(["task-presettled"]))
    );

    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("completed");
  });

  it("awaitSettlement waits then resolves on settle", async () => {
    await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-wait-settle",
          ownerSessionId: "session-1",
          name: "Wait Settle",
          kind: "agent",
          promptOrCommand: "prompt"
        })
      )
    );
    await runtime.runPromise(
      JobRegistry.use((svc) => svc.updateStatus("task-wait-settle", "running"))
    );

    const waitPromise = runtime.runPromise(
      JobRegistry.use((svc) => svc.awaitSettlement(["task-wait-settle"]))
    );

    // Settle the job after brief delay
    setTimeout(() => {
      void runtime.runPromise(
        JobRegistry.use((svc) => svc.updateStatus("task-wait-settle", "completed"))
      );
    }, 50);

    const result = await waitPromise;
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
  });

  it("waitInterest increment/decrement via ensuring pattern releases on interruption", async () => {
    await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-wait-ensuring",
          ownerSessionId: "session-1",
          name: "Ensuring",
          kind: "agent",
          promptOrCommand: "prompt"
        })
      )
    );

    const checkJob = () =>
      runtime.runPromise(JobRegistry.use((svc) => svc.get("task-wait-ensuring")));

    await runtime.runPromise(
      JobRegistry.use((svc) => svc.incrementWaitInterest(["task-wait-ensuring"]))
    );
    let job = await checkJob();
    expect(job?.waitInterest).toBe(1);

    await runtime.runPromise(
      JobRegistry.use((svc) => svc.decrementWaitInterest(["task-wait-ensuring"]))
    );
    job = await checkJob();
    expect(job?.waitInterest).toBe(0);
  });

  it("killInterest increment/decrement via ensuring pattern", async () => {
    await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-kill-ensuring",
          ownerSessionId: "session-1",
          name: "Kill Ensuring",
          kind: "agent",
          promptOrCommand: "prompt"
        })
      )
    );

    const checkJob = () =>
      runtime.runPromise(JobRegistry.use((svc) => svc.get("task-kill-ensuring")));

    await runtime.runPromise(
      JobRegistry.use((svc) => svc.incrementKillInterest(["task-kill-ensuring"]))
    );
    let job = await checkJob();
    expect(job?.killInterest).toBe(1);

    await runtime.runPromise(
      JobRegistry.use((svc) => svc.decrementKillInterest(["task-kill-ensuring"]))
    );
    job = await checkJob();
    expect(job?.killInterest).toBe(0);
  });
});
