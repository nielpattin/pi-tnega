import { describe, expect, it } from "vitest";
import { ManagedRuntime, Layer } from "effect";
import { HubToolParamsSchema, hubToolDefinition, handleHub } from "../src/tools/hub.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { ShellExecutor } from "../src/services/ShellExecutor.js";

describe("hub tool & validation guards", () => {
  function makeTestRuntime() {
    const TestLayer = ProcessSupervisor.layer.pipe(
      Layer.provideMerge(ShellExecutor.layer),
      Layer.provideMerge(JobRegistry.layer)
    );
    return ManagedRuntime.make(TestLayer);
  }

  it("exports valid hub tool definition and schema", () => {
    expect(hubToolDefinition.name).toBe("hub");
    expect(HubToolParamsSchema).toBeDefined();
  });

  describe("guards & param validation", () => {
    it("rejects op: 'wait' when target is missing", async () => {
      const runtime = makeTestRuntime();
      const res: any = await runtime.runPromise(handleHub({ op: "wait" } as any));
      expect(res.ok).toBe(false);
      expect(res.error).toContain("target");
    });

    it("rejects op: 'wait-from' when from is missing", async () => {
      const runtime = makeTestRuntime();
      const res: any = await runtime.runPromise(handleHub({ op: "wait-from" } as any));
      expect(res.ok).toBe(false);
      expect(res.error).toContain("from");
    });

    it("rejects op: 'describe' when both id and name are missing, both present, or ids array is used", async () => {
      const runtime = makeTestRuntime();

      // missing both
      const r1: any = await runtime.runPromise(handleHub({ op: "describe" } as any));
      expect(r1.ok).toBe(false);

      // both present
      const r2: any = await runtime.runPromise(
        handleHub({ op: "describe", id: "task-1", name: "proc-1" } as any)
      );
      expect(r2.ok).toBe(false);

      // ids array used
      const r3: any = await runtime.runPromise(handleHub({ op: "describe", ids: ["task-1"] } as any));
      expect(r3.ok).toBe(false);
    });

    it("rejects worker op: 'exec' with async: true", async () => {
      const runtime = makeTestRuntime();
      const res: any = await runtime.runPromise(
        handleHub({ op: "exec", command: "echo hi", async: true } as any, { isWorker: true })
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("async");
    });
  });

  describe("working ops against services", () => {
    it("lists jobs via op: 'jobs'", async () => {
      const runtime = makeTestRuntime();
      await runtime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id: "task-1",
            ownerSessionId: "parent",
            name: "j1",
            kind: "agent",
            promptOrCommand: "test"
          })
        )
      );

      const res: any = await runtime.runPromise(handleHub({ op: "jobs" }));
      expect(res.ok).toBe(true);
      expect(res.jobs.length).toBe(1);
    });

    it("waits for job settlement via op: 'wait' target: 'jobs'", async () => {
      const runtime = makeTestRuntime();
      await runtime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id: "task-1",
            ownerSessionId: "parent",
            name: "j1",
            kind: "agent",
            promptOrCommand: "test"
          })
        )
      );
      await runtime.runPromise(JobRegistry.use((svc) => svc.updateStatus("task-1", "completed")));

      const res: any = await runtime.runPromise(
        handleHub({ op: "wait", target: "jobs", ids: ["task-1"] })
      );
      expect(res.ok).toBe(true);
      expect(res.jobs[0].status).toBe("completed");
    });

    it("cancels a job via op: 'cancel'", async () => {
      const runtime = makeTestRuntime();
      await runtime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id: "task-1",
            ownerSessionId: "parent",
            name: "j1",
            kind: "agent",
            promptOrCommand: "test"
          })
        )
      );

      const res: any = await runtime.runPromise(handleHub({ op: "cancel", id: "task-1" }));
      expect(res.ok).toBe(true);

      const job = await runtime.runPromise(JobRegistry.use((svc) => svc.get("task-1")));
      expect(job?.status).toBe("cancelled");
    });

    it("executes sync shell command via op: 'exec'", async () => {
      const runtime = makeTestRuntime();
      const res: any = await runtime.runPromise(handleHub({ op: "exec", command: "echo hello" }));
      expect(res.ok).toBe(true);
      expect(res.stdout.trim()).toBe("hello");
      expect(res.exitCode).toBe(0);
    });

    it("describes job by id or process by name via op: 'describe'", async () => {
      const runtime = makeTestRuntime();
      await runtime.runPromise(
        JobRegistry.use((svc) =>
          svc.register({
            id: "task-10",
            ownerSessionId: "parent",
            name: "described-job",
            kind: "agent",
            promptOrCommand: "test"
          })
        )
      );

      const resJob: any = await runtime.runPromise(handleHub({ op: "describe", id: "task-10" }));
      expect(resJob.ok).toBe(true);
      expect(resJob.job.id).toBe("task-10");
    });
  });
});
