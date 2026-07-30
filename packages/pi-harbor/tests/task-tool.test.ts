import { describe, expect, it, vi } from "vitest";
import { ManagedRuntime, Layer } from "effect";
import {
  TaskToolParamsSchema,
  TASK_TOOL_BASE_DESCRIPTION,
  TASK_TOOL_BASE_PROMPT_GUIDELINES,
  TASK_TOOL_BASE_PROMPT_SNIPPET,
  taskToolDefinition,
  handleTask
} from "../src/tools/task.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { renderTaskCall, renderTaskResult } from "../src/ui/tool-renderers.js";
import { FakeAgyBackend, FakePiBackend } from "./helpers/fake-backends.js";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text
} as never;

function rendered(component: { render(width: number): string[] }): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

function textResult(details: unknown, text = ""): {
  content: ReadonlyArray<{ type: "text"; text: string }>;
  details: unknown;
} {
  return { content: [{ type: "text" as const, text }], details };
}

describe("task tool", () => {
  function makeTestRuntime() {
    const TestLayer = TaskManager.layer.pipe(
      Layer.provideMerge(JobRegistry.layer),
      Layer.provideMerge(FakePiBackend),
      Layer.provideMerge(FakeAgyBackend)
    );
    return ManagedRuntime.make(TestLayer);
  }

  it("documents agent selection, model override, background behavior, and both payload forms", () => {
    expect(taskToolDefinition.name).toBe("task");
    expect((TaskToolParamsSchema as any).type).toBe("object");
    const branches = (TaskToolParamsSchema as any).anyOf as any[];
    const batch = branches.find((branch) => branch.properties.tasks);
    const flat = branches.find((branch) => branch.properties.task);

    expect(batch.properties.context.description.toLowerCase()).toContain("batch");
    expect(batch.properties.tasks.description).toContain("1 to 4");
    expect(flat.required).toContain("name");
    expect(batch.properties.tasks.items.required).toContain("name");
    expect(flat.properties.name.description).toContain("AI-generated short");
    expect(flat.properties.agent.description).toContain("high-task");
    expect(flat.properties.agent.description).toContain("Omitting");
    expect(flat.properties.model.description).toContain("does not select an agent");
    expect(flat.properties.model.description).toContain("inherit");
    expect(flat.properties.background.default).toBe(false);
    expect(flat.properties.background.description).toContain("omitted blocks");
    expect(flat.properties.background.description).toContain("automatically");
    expect(flat.properties.async).toBeUndefined();
    expect(flat.properties.outputSchema.description).toContain("JSON Schema");
    expect(flat.properties.schemaMode).toBeUndefined();
  });

  it("instructs providers to batch 2 to 4 independent background tasks in a single call with background: true on each item", () => {
    const branches = (TaskToolParamsSchema as any).anyOf as any[];
    const batch = branches.find((branch) => branch.properties?.tasks);

    // The batch schema stays capped at 4 and advertises the background-batching rule.
    expect(batch.properties.tasks.maxItems).toBe(4);
    expect(batch.properties.tasks.description).toContain("1 to 4");
    expect(batch.properties.tasks.description).toContain("2 to 4 independent background");
    expect(batch.properties.tasks.description).toContain("background: true");

    // Concrete example appears in the provider-facing description and guidelines.
    expect(TASK_TOOL_BASE_DESCRIPTION).toContain("2 to 4 independent background");
    expect(TASK_TOOL_BASE_DESCRIPTION).toContain("background: true");
    expect(TASK_TOOL_BASE_DESCRIPTION).toContain(
      '{ tasks: [{ task: "investigate A", name: "investigate-a", background: true }, { task: "investigate B", name: "investigate-b", background: true }] }'
    );

    expect(TASK_TOOL_BASE_PROMPT_SNIPPET).toContain("2 to 4 independent background");
    expect(TASK_TOOL_BASE_PROMPT_SNIPPET).toContain("background: true");

    const guidelines = TASK_TOOL_BASE_PROMPT_GUIDELINES.join("\n");
    expect(guidelines).toContain("2 to 4 independent background");
    expect(guidelines).toContain("background: true");
    expect(guidelines).toContain(
      '{ tasks: [{ task: "investigate A", name: "investigate-a", background: true }, { task: "investigate B", name: "investigate-b", background: true }] }'
    );
  });

  it("returns only a clear acknowledgement for one background task", async () => {
    const runtime = makeTestRuntime();
    const res = await runtime.runPromise(
      handleTask({
        task: "do single task",
        name: "my-task",
        agent: "scout",
        background: true
      })
    );

    expect(res).toEqual({
      ok: true,
      id: expect.stringMatching(/^task-\d+/),
      name: "my-task",
      agent: "scout",
      status: "running",
      background: true,
      message: expect.stringContaining("delivered automatically")
    });
  });

  it("waits for one task by default so its output returns in the task tool", async () => {
    const runtime = makeTestRuntime();
    let resolved = false;
    const taskPromise = runtime
      .runPromise(handleTask({ task: "do single task", name: "do-single-task", agent: "scout" }))
      .then((result) => {
        resolved = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const jobs = await runtime.runPromise(JobRegistry.use((registry) => registry.list({ status: "running" })));
    expect(resolved).toBe(false);
    await runtime.runPromise(
      JobRegistry.use((registry) =>
        registry.updateStatus(jobs[0].id, "completed", { resultData: { summary: "done" } })
      )
    );

    const result: any = await taskPromise;
    expect(result.background).toBe(false);
    expect(result.name).toBe("do-single-task");
    expect(result.result).toEqual({ summary: "done" });
    await runtime.dispose();
  });

  it("prepends context to batch tasks when provided", async () => {
    const runtime = makeTestRuntime();
    const res: any = await runtime.runPromise(
      handleTask({
        context: "Global Context Here",
        tasks: [
          { task: "task 1", name: "t1", background: true },
          { task: "task 2", name: "t2", background: true }
        ]
      })
    );

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);

    const job1 = await runtime.runPromise(JobRegistry.use((svc) => svc.get(res.jobs[0].id)));
    expect(job1?.promptOrCommand).toBe("Global Context Here\n\ntask 1");
  });

  it("waits for every default batch task before returning results", async () => {
    const runtime = makeTestRuntime();
    let resolved = false;
    const taskPromise = runtime
      .runPromise(
        handleTask({
          tasks: [
            { task: "first task", name: "first" },
            { task: "second task", name: "second" }
          ]
        })
      )
      .then((result) => {
        resolved = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const jobs = await runtime.runPromise(JobRegistry.use((registry) => registry.list({ status: "running" })));
    expect(resolved).toBe(false);
    expect(jobs).toHaveLength(2);

    await runtime.runPromise(
      JobRegistry.use((registry) =>
        registry.updateStatus(jobs[0].id, "completed", { resultData: { summary: "first result" } })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);

    await runtime.runPromise(
      JobRegistry.use((registry) =>
        registry.updateStatus(jobs[1].id, "completed", { resultData: { summary: "second result" } })
      )
    );
    const result: any = await taskPromise;

    expect(result.jobs.map((job: { result: unknown }) => job.result)).toEqual([
      { summary: "first result" },
      { summary: "second result" }
    ]);
    await runtime.dispose();
  });

  it("emits a partial update when the first foreground job settles while another is still running", async () => {
    const runtime = makeTestRuntime();
    const updates: unknown[] = [];

    const taskPromise = runtime.runPromise(
      handleTask(
        {
          tasks: [
            { task: "first task", name: "first", agent: "scout" },
            { task: "second task", name: "second", agent: "reviewer" }
          ]
        },
        {
          onUpdate: (summary: unknown) => updates.push(summary)
        }
      )
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const jobs = await runtime.runPromise(JobRegistry.use((registry) => registry.list({ status: "running" })));
    expect(jobs).toHaveLength(2);

    await runtime.runPromise(
      JobRegistry.use((registry) =>
        registry.updateStatus(jobs[0].id, "completed", { resultData: { summary: "first result" } })
      )
    );

    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    const update = updates[0] as any;
    expect(update.ok).toBe(true);
    expect(update.count).toBe(2);
    expect(update.jobs[0].status).toBe("completed");
    expect(update.jobs[0].result).toEqual({ summary: "first result" });
    expect(update.jobs[1].status).toBe("running");

    const state: Record<string, unknown> = {};
    const invalidate = vi.fn();
    const context = { state, invalidate, isError: false } as never;
    const args = {
      tasks: [
        { task: "first task", name: "first", agent: "scout" },
        { task: "second task", name: "second", agent: "reviewer" }
      ]
    };

    rendered(renderTaskCall(args, theme, context));
    rendered(renderTaskResult(textResult(update), { expanded: false, isPartial: true }, theme, context));
    await Promise.resolve();
    const call = rendered(renderTaskCall(args, theme, context));

    expect(call).toContain("✓ first");
    expect(call).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*second/);

    await runtime.runPromise(
      JobRegistry.use((registry) =>
        registry.updateStatus(jobs[1].id, "completed", { resultData: { summary: "second result" } })
      )
    );
    await taskPromise;
    await runtime.dispose();
  });

  it("returns a concise mixed foreground/background batch response", async () => {
    const runtime = makeTestRuntime();
    // For sync tasks, update job status to completed in background so awaitSettlement resolves
    const taskPromise = runtime.runPromise(
      handleTask({
        tasks: [
          { task: "background task", name: "t-background", background: true },
          { task: "foreground task", name: "t-foreground", background: false }
        ]
      })
    );

    const timer = setInterval(async () => {
      try {
        const jobs = await runtime.runPromise(JobRegistry.use((svc) => svc.list({ status: "running" })));
        const foregroundJob = jobs.find((j) => j.name === "t-foreground");
        if (foregroundJob) {
          clearInterval(timer);
          await runtime.runPromise(
            JobRegistry.use((svc) =>
              svc.updateStatus(foregroundJob.id, "completed", { resultData: { done: true } })
            )
          );
        }
      } catch {
        // ignore errors during polling
      }
    }, 20);

    const res: any = await taskPromise;

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(Array.isArray(res.jobs)).toBe(true);
    expect(res.jobs[0]).toMatchObject({ name: "t-background", background: true, status: "running" });
    expect(res.jobs[0]).not.toHaveProperty("result");
    expect(res.jobs[1]).toMatchObject({
      name: "t-foreground",
      background: false,
      status: "completed",
      result: { done: true }
    });
    expect(res).not.toHaveProperty("batchId");
    expect(res).not.toHaveProperty("syncSettled");
    expect(res).not.toHaveProperty("timedOut");
    expect(res).not.toHaveProperty("aborted");
  });
});
