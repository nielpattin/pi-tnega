import { describe, it, expect } from "vitest";
import { runTool } from "../src/runtime.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { ProcessSupervisor } from "../src/services/ProcessSupervisor.js";
import { getGlobalAgentsDir } from "../src/services/AgentsStore.js";
import { handleTask } from "../src/tools/task.js";
import { handleHub } from "../src/tools/hub.js";
import { handleSubmit } from "../src/tools/submit.js";
import { Effect, Layer } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgyBackend } from "../src/backends/agy.js";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";

describe("Harbor Runtime Integration", () => {
  const runtime = makeFakeHarborRuntime();

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

  it("executes task, submit, and hub tools through HarborLive runtime via runTool", async () => {
    const taskRes: any = await runTool(
      runtime,
      handleTask({
        task: "Subagent tool test",
        name: "tool-test-job",
        background: true
      })
    );

    expect(taskRes.ok).toBe(true);
    const jobId = taskRes.id;

    const submitRes: any = await runTool(
      runtime,
      handleSubmit({ result: { data: { output: 123 } } }, { jobId })
    );

    expect(submitRes.ok).toBe(true);
    expect(submitRes.status).toBe("completed");

    const hubRes: any = await runTool(
      runtime,
      handleHub({ op: "jobs" })
    );

    expect(hubRes.ok).toBe(true);
    expect(hubRes.jobs.length).toBeGreaterThan(0);
  }, 30000);

  it("resolves a disk agent harness and executes through the injected Agy backend", async () => {
    let agyStarts = 0;
    const RecordingAgy = Layer.succeed(
      AgyBackend,
      AgyBackend.of({
        runOneShot: () => Effect.die("unused"),
        createFsmSession: () => ({
          state: "running" as const,
          pendingFollowUps: [],
          pendingSteerText: undefined,
          start: () => Effect.sync(() => void agyStarts++),
          control: () => Effect.void,
          abort: () => Effect.void
        })
      })
    );
    const testRuntime = makeFakeHarborRuntime(RecordingAgy);
    const agentsDir = getGlobalAgentsDir();
    const agentPath = path.join(agentsDir, "harbor-test-agy-agent.md");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      agentPath,
      [
        "---",
        "description: Temp test agent for harness regression test",
        "harness: agy",
        "enabled: true",
        "---",
        "",
        "Test body."
      ].join("\n"),
      "utf-8"
    );

    try {
      const job = await runTool(
        testRuntime,
        TaskManager.use((svc) =>
          svc.spawnTask({ task: "Harness resolution test", agent: "harbor-test-agy-agent" })
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(job.harness).toBe("agy");
      expect(agyStarts).toBe(1);
      await runTool(testRuntime, TaskManager.use((svc) => svc.cancelJob(job.id)));
    } finally {
      try {
        fs.unlinkSync(agentPath);
      } catch {}
    }
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
