import { describe, it, expect } from "vitest";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { CapacityError, type Job } from "../src/domain.js";
import { ManagedRuntime, Effect } from "effect";

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
});
