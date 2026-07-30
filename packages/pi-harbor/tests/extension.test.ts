import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { registerHarborExtension } from "../src/extension.js";
import { setKeybindings, getKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { runTool } from "../src/runtime.js";
import { Effect, Layer } from "effect";
import { ASYNC_TASK_WIDGET_KEY } from "../src/ui/async-task-widget.js";
import { PiBackend, PI_BACKEND_CAPABILITIES } from "../src/backends/pi.js";
import { AgentsStore } from "../src/services/AgentsStore.js";

function createMockPi(opts?: {
   settingsExtensions?: string[];
   tools?: Array<{ name: string; sourceInfo?: { path?: string } }>;
   commands?: Array<{ name: string }>;
}) {
   const registeredTools: Array<{
      name: string;
      description?: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      execute?: Function;
      parameters?: unknown;
      renderCall?: Function;
      renderResult?: Function;
   }> = [];
   const registeredCommands: Array<{ name: string; handler?: Function }> = [];
   const eventHandlers = new Map<string, Function[]>();
   const renderers: string[] = [];
   const messageRenderers: string[] = [];
   const messageRendererFactories = new Map<string, Function>();
   const entries: Array<{ type: string; data: unknown }> = [];
   let activeTools: string[] = [];
   const settingsExtensions = opts?.settingsExtensions ?? [];
   const existingTools = opts?.tools ?? [];
   const existingCommands = opts?.commands ?? [];

   const pi = {
      getAllTools: () => [
         ...existingTools.map((t) => ({
            name: t.name,
            description: t.name,
            parameters: {},
            sourceInfo: t.sourceInfo
         })),
         ...registeredTools.map((t) => ({
            name: t.name,
            description: t.description ?? t.name,
            promptSnippet: t.promptSnippet,
            promptGuidelines: t.promptGuidelines,
            parameters: t.parameters ?? {},
            sourceInfo: { path: "packages/pi-harbor/index.ts" }
         }))
      ],
      getActiveTools: () => activeTools,
      setActiveTools: vi.fn((names: string[]) => {
         activeTools = [...names];
      }),
      getCommands: () => [
         ...existingCommands.map((c) => ({ name: c.name, source: "prompt" as const })),
         ...registeredCommands.map((c) => ({ name: c.name, source: "prompt" as const }))
      ],
      getSettings: () => ({ extensions: settingsExtensions }),
      registerTool: vi.fn((def: any) => {
         // last register wins for same name
         const idx = registeredTools.findIndex((t) => t.name === def.name);
         if (idx >= 0) registeredTools[idx] = def;
         else registeredTools.push(def);
         if (!activeTools.includes(def.name)) activeTools.push(def.name);
      }),
      registerCommand: vi.fn((name: string, options: any) => {
         registeredCommands.push({ name, handler: options.handler });
      }),
      registerEntryRenderer: vi.fn((type: string) => {
         renderers.push(type);
      }),
      registerMessageRenderer: vi.fn((type: string, factory: Function) => {
         messageRenderers.push(type);
         messageRendererFactories.set(type, factory);
      }),
      appendEntry: vi.fn((type: string, data: unknown) => {
         entries.push({ type, data });
      }),
      on: vi.fn((event: string, handler: Function) => {
         const handlers = eventHandlers.get(event) ?? [];
         handlers.push(handler);
         eventHandlers.set(event, handlers);
      }),
      sendMessage: vi.fn()
   };

   return {
      pi: pi as any,
      registeredTools,
      registeredCommands,
      renderers,
      messageRenderers,
      messageRendererFactories,
      entries,
      activeTools: () => activeTools,
      emit: async (event: string, payload: unknown, ctx: unknown) => {
         for (const handler of eventHandlers.get(event) ?? []) await handler(payload, ctx);
      }
   };
}

describe("Harbor Extension Registration & Real Wiring", () => {

   it("full mode registers parent tools/commands with execute handlers when cutover passes", () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();

      const res = registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      expect(res.ok).toBe(true);
      if (res.ok) {
         expect(res.registered).toBe("full");
         expect(res.cutoverOk).toBe(true);
      }

      const toolNames = mock.registeredTools.map((t) => t.name);
      expect(toolNames).toEqual(expect.arrayContaining(["task", "hub", "submit", "vibe"]));
      expect(toolNames.filter((name) => name === "vibe")).toHaveLength(1);
      expect(toolNames.some((name) => name.startsWith("vibe_"))).toBe(false);

      const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
      expect(taskTool?.description).toContain('{ task: "prompt"');
      expect(taskTool?.description).toContain('{ tasks: [{ task: "prompt"');

      for (const name of ["task", "hub", "vibe"]) {
         const tool = mock.registeredTools.find((candidate) => candidate.name === name);
         expect(tool?.promptSnippet).toBeTruthy();
         expect(tool?.promptGuidelines?.length).toBeGreaterThan(0);
         expect(tool?.promptGuidelines?.every((guideline) => guideline.includes(name))).toBe(true);
      }
      expect(taskTool?.description).toContain("agent field selects");
      expect(taskTool?.description).toContain("model only overrides");
      expect(taskTool?.promptGuidelines?.join(" ")).toContain('agent: "high-task"');
      expect(taskTool?.promptGuidelines?.join(" ")).toContain("steers the result to the parent session immediately");
      expect(taskTool?.promptGuidelines?.join(" ")).toContain("hub wait or describe");
      expect(taskTool?.promptGuidelines?.join(" ")).toContain(
         "When the user explicitly asks to delegate to an agent, call task before reading"
      );

      for (const tool of mock.registeredTools) {
         expect(typeof tool.execute).toBe("function");
      }
      for (const name of ["task", "hub", "vibe"]) {
         const tool = mock.registeredTools.find((candidate) => candidate.name === name);
         expect(typeof tool?.renderCall).toBe("function");
         expect(typeof tool?.renderResult).toBe("function");
      }

      expect(mock.registeredCommands.map((c) => c.name).sort()).toEqual(["agents", "btw", "tasks", "vibe"]);
      for (const cmd of mock.registeredCommands) {
         expect(typeof cmd.handler).toBe("function");
      }
      expect(mock.renderers).toEqual(expect.arrayContaining(["harbor-result", "btw-result"]));
   });

   it("keeps the unified vibe tool inactive until Vibe mode is enabled", async () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      await mock.emit("session_start", {}, {
         mode: "tui",
         hasUI: true,
         ui: { notify: vi.fn() },
         sessionManager: { getEntries: () => [], getSessionId: () => "s" },
         cwd: process.cwd()
      });

      expect(mock.activeTools()).not.toContain("vibe");
      expect(mock.activeTools()).toContain("task");
      await runtime.dispose();
   });

   it("keeps full job details for rendering but bounds model-facing hub content", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime();
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    const ctx = {
      sessionManager: { getSessionId: () => "sess-1", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: undefined
    };

    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
    const spawned = await taskTool!.execute!(
      "tc-large-task",
      { task: "large task", name: "large", agent: "task", background: true },
      undefined,
      undefined,
      ctx
    );
    const taskId = JSON.parse(spawned.content[0].text).id as string;
    const huge = "x".repeat(400_000);
    await runTool(
      runtime,
      JobRegistry.use((registry) =>
        registry.updateStatus(taskId, "completed", {
          rawText: huge,
          transcript: [{ type: "assistant", text: huge }],
          resultData: { summary: "small result" }
        })
      )
    );

    const hubTool = mock.registeredTools.find((tool) => tool.name === "hub");
    const result = await hubTool!.execute!("tc-large-hub", { op: "jobs" }, undefined, undefined, ctx);

    expect(result.content[0].text.length).toBeLessThan(20_000);
    expect(result.content[0].text).not.toContain(huge.slice(0, 100));
    expect(result.content[0].text).toContain("small result");
    expect(result.details.jobs[0].rawText).toHaveLength(400_000);
    await runtime.dispose();
  });

  it("passes the parent model registry so the selected agent model reaches Pi", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const modelRegistry = { find: vi.fn(), getAll: vi.fn(() => []) };
    let receivedModelRegistry: unknown;
    let receivedAgentModel: string | undefined;
    const RecordingPi = Layer.succeed(
      PiBackend,
      PiBackend.of({
        capabilities: PI_BACKEND_CAPABILITIES,
        spawnSession: async (options) => {
          receivedModelRegistry = options.modelRegistry;
          receivedAgentModel = options.agentDef?.model;
          return { session: {}, abort: () => Effect.void, control: () => Effect.void };
        }
      })
    );
    const TestAgents = Layer.succeed(
      AgentsStore,
      AgentsStore.of({
        getAgent: () =>
          Effect.succeed({
            name: "light-task",
            description: "Light task",
            tools: ["read", "submit"],
            harness: "pi" as const,
            enabled: true,
            source: "global" as const,
            body: "Light task body",
            model: "proxy/cfai/@cf/moonshotai/kimi-k2.7-code",
            thinking: "high"
          }),
        listAgents: () => Effect.succeed([]),
        getVibeProfiles: () => Effect.die("unused"),
        updateAgent: () => Effect.die("unused"),
        deleteAgent: () => Effect.die("unused"),
        updateVibeProfile: () => Effect.die("unused")
      })
    );
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime(undefined, RecordingPi, TestAgents);
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    const ctx = {
      sessionManager: { getSessionId: () => "sess-model", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: { provider: "parent", id: "parent-model" },
      modelRegistry,
      isIdle: () => true
    };
    await mock.emit("session_start", {}, ctx);
    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");

    await taskTool!.execute!(
      "tc-model",
      { task: "Inspect copy all", name: "inspect-copy-all", agent: "light-task", background: true },
      undefined,
      undefined,
      ctx
    );

    expect(receivedModelRegistry).toBe(modelRegistry);
    expect(receivedAgentModel).toBe("proxy/cfai/@cf/moonshotai/kimi-k2.7-code");
    await runtime.dispose();
  });

  it("delivers an unconsumed async task result as one parent steering message", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime();
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    const ctx = {
      sessionManager: { getSessionId: () => "sess-async", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: undefined,
      isIdle: () => true
    };
    await mock.emit("session_start", {}, ctx);
    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
    const spawned = await taskTool!.execute!(
      "tc-async",
      { task: "Investigate copy all", name: "investigate-copy-all", agent: "task", background: true },
      undefined,
      undefined,
      ctx
    );
    const taskId = JSON.parse(spawned.content[0].text).id as string;

    await runTool(
      runtime,
      JobRegistry.use((registry) =>
        registry.updateStatus(taskId, "completed", { resultData: { summary: "Copy-all result" } })
      )
    );
    await vi.waitFor(() => expect(mock.pi.sendMessage).toHaveBeenCalledOnce());

    expect(mock.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harbor-result",
        content: expect.stringContaining("Copy-all result")
      }),
      { deliverAs: "steer", triggerTurn: true }
    );
    await runtime.dispose();
  });

  it("defers an unconsumed async task result while the parent is active, then steers it on agent_end", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime();
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    let idle = true;
    const ctx = {
      sessionManager: { getSessionId: () => "sess-active", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: undefined,
      isIdle: () => idle
    };
    await mock.emit("session_start", {}, ctx);
    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
    const spawned = await taskTool!.execute!(
      "tc-active",
      { task: "Investigate while parent streams", name: "investigate-active", agent: "task", background: true },
      undefined,
      undefined,
      ctx
    );
    const taskId = JSON.parse(spawned.content[0].text).id as string;

    idle = false;
    await runTool(
      runtime,
      JobRegistry.use((registry) =>
        registry.updateStatus(taskId, "completed", { resultData: { summary: "Active-parent result" } })
      )
    );
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();

    await mock.emit("agent_end", {}, ctx);
    await vi.waitFor(() => expect(mock.pi.sendMessage).toHaveBeenCalledOnce());

    expect(mock.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harbor-result",
        content: expect.stringContaining("Active-parent result")
      }),
      { deliverAs: "steer", triggerTurn: true }
    );
    await runtime.dispose();
  });

  it("does not inject an async steering message when hub wait consumes the result", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime();
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    const ctx = {
      sessionManager: { getSessionId: () => "sess-wait", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: undefined,
      isIdle: () => true
    };
    await mock.emit("session_start", {}, ctx);
    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
    const spawned = await taskTool!.execute!(
      "tc-wait-task",
      { task: "Inspect background wait", name: "inspect-background-wait", background: true },
      undefined,
      undefined,
      ctx
    );
    const taskId = JSON.parse(spawned.content[0].text).id as string;
    const hubTool = mock.registeredTools.find((tool) => tool.name === "hub");
    const waitPromise = hubTool!.execute!(
      "tc-wait-hub",
      { op: "wait", target: "jobs", ids: [taskId] },
      undefined,
      undefined,
      ctx
    );
    await vi.waitFor(async () => {
      const job = await runTool(runtime, JobRegistry.use((registry) => registry.get(taskId)));
      expect(job?.waitInterest).toBe(1);
    });
    await runTool(
      runtime,
      JobRegistry.use((registry) =>
        registry.updateStatus(taskId, "completed", { resultData: { summary: "Waited result" } })
      )
    );
    const waited = await waitPromise;

    expect(waited.content[0].text).toContain("Waited result");
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("hub wait returns nested structured results directly without nested value omitted", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime();
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    const ctx = {
      sessionManager: { getSessionId: () => "sess-nested", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: undefined,
      isIdle: () => true
    };
    await mock.emit("session_start", {}, ctx);
    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
    const spawned = await taskTool!.execute!(
      "tc-nested",
      { task: "Produce nested result", name: "nested-result", agent: "task", background: true },
      undefined,
      undefined,
      ctx
    );
    const taskId = JSON.parse(spawned.content[0].text).id as string;
    const nested = { level1: { level2: { level3: { level4: "deep value" } } } };

    const hubTool = mock.registeredTools.find((tool) => tool.name === "hub");
    const waitPromise = hubTool!.execute!(
      "tc-wait-nested",
      { op: "wait", target: "jobs", ids: [taskId] },
      undefined,
      undefined,
      ctx
    );
    await vi.waitFor(async () => {
      const job = await runTool(runtime, JobRegistry.use((registry) => registry.get(taskId)));
      expect(job?.waitInterest).toBe(1);
    });
    await runTool(
      runtime,
      JobRegistry.use((registry) => registry.updateStatus(taskId, "completed", { resultData: nested }))
    );
    const waited = await waitPromise;

    expect(waited.content[0].text).toContain("deep value");
    expect(waited.content[0].text).not.toContain("[nested value omitted]");
    expect(waited.content[0].text.length).toBeLessThanOrEqual(16_000);
    expect(waited.details).toEqual(expect.objectContaining({ ok: true }));
    expect((waited.details as any).jobs[0]).toMatchObject({
      id: taskId,
      status: "completed",
      resultData: nested
    });
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("returns a sync result in the task tool without injecting a steering message", async () => {
    const settings = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];
    const mock = createMockPi({ settingsExtensions: settings });
    const runtime = makeFakeHarborRuntime();
    registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
    const ctx = {
      sessionManager: { getSessionId: () => "sess-sync", getEntries: () => [] },
      cwd: process.cwd(),
      hasUI: true,
      model: undefined,
      isIdle: () => true
    };
    await mock.emit("session_start", {}, ctx);
    const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
    const taskPromise = taskTool!.execute!(
      "tc-sync",
      { task: "Inspect copy all", name: "inspect-copy-all", agent: "task" },
      undefined,
      undefined,
      ctx
    );
    await vi.waitFor(async () => {
      const jobs = await runTool(runtime, JobRegistry.use((registry) => registry.list({ status: "running" })));
      expect(jobs).toHaveLength(1);
    });
    const [job] = await runTool(runtime, JobRegistry.use((registry) => registry.list({ status: "running" })));
    await runTool(
      runtime,
      JobRegistry.use((registry) =>
        registry.updateStatus(job.id, "completed", { resultData: { summary: "Sync result" } })
      )
    );
    const result = await taskPromise;

    expect(result.content[0].text).toContain("Sync result");
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("task tool execute spawns a job and hub jobs lists it", async () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      const taskTool = mock.registeredTools.find((t) => t.name === "task");
      expect(taskTool).toBeDefined();

      const ctx = {
         sessionManager: { getSessionId: () => "sess-1", getEntries: () => [] },
         cwd: process.cwd(),
         hasUI: true,
         model: undefined
      };

      const spawnResult = await taskTool!.execute!(
         "tc1",
         { task: "do work", name: "n1", agent: "task", background: true },
         undefined,
         undefined,
         ctx
      );
      const spawnText = spawnResult.content[0].text;
      const spawnPayload = JSON.parse(spawnText);
      expect(spawnPayload.ok).toBe(true);
      expect(spawnPayload.id).toMatch(/^task-\d+$/);

      const hubTool = mock.registeredTools.find((t) => t.name === "hub");
      const jobsResult = await hubTool!.execute!("tc2", { op: "jobs" }, undefined, undefined, ctx);
      const jobsPayload = JSON.parse(jobsResult.content[0].text);
      expect(jobsPayload.ok).toBe(true);
      expect(jobsPayload.jobs.some((j: any) => j.id === spawnPayload.id)).toBe(true);

      // Direct registry view via same runtime confirms shared JobRegistry instance.
      const listed = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(listed.some((j) => j.id === spawnPayload.id)).toBe(true);

      await runtime.dispose();
   });

   it("tasks command handler writes a snapshot entry", async () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      const tasksCmd = mock.registeredCommands.find((c) => c.name === "tasks");
      expect(tasksCmd).toBeDefined();

      await tasksCmd!.handler!("", {
         hasUI: true,
         ui: { notify: vi.fn() },
         sessionManager: { getEntries: () => [], getSessionId: () => "s" },
         cwd: process.cwd(),
         model: undefined
      });

      expect(mock.entries.some((e) => e.type === "harbor-tasks-snapshot")).toBe(true);
      await runtime.dispose();
   });

   function mockWidgetUi() {
      return {
         notify: vi.fn(),
         setWidget: vi.fn(),
         theme: { fg: (_color: string, text: string) => text } as never
      };
   }

   function renderWidgetFactory(factory: unknown, width = 80): string | undefined {
      if (typeof factory !== "function") return undefined;
      const component = (factory as (tui: unknown, theme: { fg: (color: string, text: string) => string }) => {
         render: (width: number) => string[];
      })(undefined, { fg: (_color, text) => text });
      return component.render(width)[0];
   }

   it("shows an above-editor async task widget while async jobs run", async () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      const ui = mockWidgetUi();
      const ctx = {
         sessionManager: { getSessionId: () => "sess-widget", getEntries: () => [] },
         cwd: process.cwd(),
         hasUI: true,
         model: undefined,
         isIdle: () => true,
         ui
      };

      await mock.emit("session_start", {}, ctx);

      const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
      const spawned = await taskTool!.execute!(
         "tc-widget",
         { task: "Inspect background widget", name: "widget-task", agent: "task", background: true },
         undefined,
         undefined,
         ctx
      );
      const taskId = JSON.parse(spawned.content[0].text).id as string;

      await vi.waitFor(() => {
         const calls = (ui.setWidget.mock.calls as Array<[string, unknown]>).filter(
            ([key]) => key === ASYNC_TASK_WIDGET_KEY
         );
         expect(calls.length).toBeGreaterThanOrEqual(1);
      });
      const widgetCalls = (ui.setWidget.mock.calls as Array<[string, unknown]>).filter(
         ([key]) => key === ASYNC_TASK_WIDGET_KEY
      );
      const line = renderWidgetFactory(widgetCalls[widgetCalls.length - 1]![1]);
      expect(line).toContain("tasks 1 running");
      expect(line).toContain("widget-task");

      await runTool(
         runtime,
         JobRegistry.use((registry) =>
            registry.updateStatus(taskId, "completed", { resultData: { summary: "done" } })
         )
      );

      await vi.waitFor(() => {
         const last = (ui.setWidget.mock.calls as Array<[string, unknown]>).at(-1);
         expect(last).toEqual([ASYNC_TASK_WIDGET_KEY, undefined]);
      });

      await runtime.dispose();
   });

   it("clears the async widget when the session shuts down", async () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      const ui = mockWidgetUi();
      const ctx = {
         sessionManager: { getSessionId: () => "sess-shutdown", getEntries: () => [] },
         cwd: process.cwd(),
         hasUI: true,
         model: undefined,
         isIdle: () => true,
         ui
      };

      await mock.emit("session_start", {}, ctx);

      const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
      await taskTool!.execute!(
         "tc-shutdown",
         { task: "Long running", name: "long-task", agent: "task", background: true },
         undefined,
         undefined,
         ctx
      );

      await vi.waitFor(() => {
         const shown = (ui.setWidget.mock.calls as Array<[string, unknown]>).some(
            ([key, factory]) => key === ASYNC_TASK_WIDGET_KEY && typeof factory === "function"
         );
         expect(shown).toBe(true);
      });

      const lastBeforeShutdown = (ui.setWidget.mock.calls as Array<[string, unknown]>).at(-1);
      expect(lastBeforeShutdown?.[0]).toBe(ASYNC_TASK_WIDGET_KEY);
      expect(typeof lastBeforeShutdown?.[1]).toBe("function");

      await mock.emit("session_shutdown", {}, ctx);
      const last = (ui.setWidget.mock.calls as Array<[string, unknown]>).at(-1);
      expect(last).toEqual([ASYNC_TASK_WIDGET_KEY, undefined]);

      await runtime.dispose();
   });

   it("does not display an async widget for synchronous tasks", async () => {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });

      const ui = mockWidgetUi();
      const ctx = {
         sessionManager: { getSessionId: () => "sess-sync-widget", getEntries: () => [] },
         cwd: process.cwd(),
         hasUI: true,
         model: undefined,
         isIdle: () => true,
         ui
      };

      await mock.emit("session_start", {}, ctx);

      const taskTool = mock.registeredTools.find((tool) => tool.name === "task");
      const taskPromise = taskTool!.execute!(
         "tc-sync-widget",
         { task: "Sync work", name: "sync-task", agent: "task" },
         undefined,
         undefined,
         ctx
      );

      await vi.waitFor(async () => {
         const jobs = await runTool(runtime, JobRegistry.use((registry) => registry.list({ status: "running" })));
         expect(jobs).toHaveLength(1);
      });

      const [job] = await runTool(runtime, JobRegistry.use((registry) => registry.list({ status: "running" })));
      await runTool(
         runtime,
         JobRegistry.use((registry) =>
            registry.updateStatus(job.id, "completed", { resultData: { summary: "Sync done" } })
         )
      );

      await taskPromise;

      const widgetCalls = (ui.setWidget.mock.calls as Array<[string, unknown]>).filter(
         ([key]) => key === ASYNC_TASK_WIDGET_KEY
      );
      expect(widgetCalls).toHaveLength(0);

      await runtime.dispose();
   });
});

describe("Harbor result message renderer", () => {
   const previousKeybindings = getKeybindings();
   const THEME_SYM = Symbol.for("@earendil-works/pi-coding-agent:theme");
   const previousTheme = (globalThis as Record<symbol, unknown>)[THEME_SYM];

   function makeKeybindings(userBindings: Record<string, string | string[] | undefined> = {}) {
      return new KeybindingsManager(
         {
            ...TUI_KEYBINDINGS,
            "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" }
         },
         userBindings as KeybindingsConfig
      );
   }

   const fakeGlobalTheme = {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bg: (color: string, text: string) => `<bg:${color}:${text}>`,
      bold: (text: string) => text,
      italic: (text: string) => text
   };

   beforeAll(() => {
      setKeybindings(makeKeybindings());
      (globalThis as Record<symbol, unknown>)[THEME_SYM] = fakeGlobalTheme;
   });

   afterAll(() => {
      setKeybindings(previousKeybindings);
      (globalThis as Record<symbol, unknown>)[THEME_SYM] = previousTheme;
   });

   function setup() {
      const settings: string[] = [];
      const mock = createMockPi({ settingsExtensions: settings });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: settings, runtime });
      return { mock, runtime };
   }

   function recordingTheme() {
      const colors: Array<{ color: string; text: string }> = [];
      const backgrounds: Array<{ color: string; text: string }> = [];
      const theme = {
         bold: (text: string) => text,
         fg: (color: string, text: string) => {
            colors.push({ color, text });
            return `<${color}:${text}>`;
         },
         bg: (color: string, text: string) => {
            backgrounds.push({ color, text });
            return `<bg:${color}:${text}>`;
         }
      } as never;
      return { theme, colors, backgrounds };
   }

   function render(factory: Function, message: unknown, expanded: boolean, theme: never, width = 120) {
      return (factory as (message: unknown, opts: { expanded: boolean }, theme: never) => { render: (width: number) => string[] })(
         message,
         { expanded },
         theme
      ).render(width);
   }

   function unwrapBg(line: string, color: string): string | undefined {
      const prefix = `<bg:${color}:`;
      if (!line.startsWith(prefix) || !line.endsWith(">")) return undefined;
      return line.slice(prefix.length, -1);
   }

   function padToWidth(text: string, width: number): string {
      return text + " ".repeat(Math.max(0, width - text.length));
   }

   // Box samples its bgFn with the literal string "test" for cache invalidation.
   function withoutBgSample<T extends { text: string }>(backgrounds: T[]) {
      return backgrounds.filter((entry) => entry.text !== "test");
   }

   function everyLineUsesBg(lines: string[], color: string): boolean {
      return lines.every((line) => line.startsWith(`<bg:${color}:`) && line.endsWith(">"));
   }

   it("registers a harbor-result custom message renderer", () => {
      const { mock, runtime } = setup();
      expect(mock.messageRenderers).toContain("harbor-result");
      runtime.dispose();
   });

   it("renders a completed background result with tool result background fill behind the bg badge, separator, and body", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme, colors, backgrounds } = recordingTheme();
      const message = {
         customType: "harbor-result",
         content: "Task bg-task (task-1) completed.\nThe background task finished successfully.",
         details: { id: "task-1", name: "bg-task", status: "completed" }
      };
      const width = 120;
      const lines = render(factory, message, false, theme, width);
      const header =
         "<customMessageLabel:[bg]> <toolTitle:task> <accent:bg-task><muted: · task-1 · completed> <success:✓>";

      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe(`<bg:toolSuccessBg:${padToWidth(" ", width)}>`);
      expect(lines[1]).toBe(`<bg:toolSuccessBg:${padToWidth(" " + header, width)}>`);
      expect(lines[2]).toBe(`<bg:toolSuccessBg:${padToWidth(" " + "<dim:--->", width)}>`);
      expect(lines[3]).toBe(
         `<bg:toolSuccessBg:${padToWidth(" " + "<toolOutput:The background task finished successfully.>", width)}>`
      );
      expect(lines[4]).toBe(`<bg:toolSuccessBg:${padToWidth(" ", width)}>`);
      expect(everyLineUsesBg(lines, "toolSuccessBg")).toBe(true);
      expect(colors).toEqual([
         { color: "customMessageLabel", text: "[bg]" },
         { color: "toolTitle", text: "task" },
         { color: "accent", text: "bg-task" },
         { color: "muted", text: " · task-1 · completed" },
         { color: "success", text: "✓" },
         { color: "dim", text: "---" },
         { color: "toolOutput", text: "The background task finished successfully." }
      ]);
      expect(withoutBgSample(backgrounds).map((entry) => entry.color)).toEqual(
         Array(lines.length).fill("toolSuccessBg")
      );

      runtime.dispose();
   });

   it("renders a failed background result with error tokens and a tool-error background fill", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme, colors, backgrounds } = recordingTheme();
      const message = {
         customType: "harbor-result",
         content: "Task bg-task (task-1) failed.\nSomething broke.",
         details: { id: "task-1", name: "bg-task", status: "failed" }
      };
      const width = 120;
      const lines = render(factory, message, false, theme, width);
      const header =
         "<customMessageLabel:[bg]> <toolTitle:task> <accent:bg-task><muted: · task-1 · failed> <error:✗>";

      expect(lines).toHaveLength(5);
      expect(lines[1]).toBe(`<bg:toolErrorBg:${padToWidth(" " + header, width)}>`);
      expect(lines[3]).toBe(`<bg:toolErrorBg:${padToWidth(" " + "<toolOutput:Something broke.>", width)}>`);
      expect(everyLineUsesBg(lines, "toolErrorBg")).toBe(true);
      expect(colors).toEqual([
         { color: "customMessageLabel", text: "[bg]" },
         { color: "toolTitle", text: "task" },
         { color: "accent", text: "bg-task" },
         { color: "muted", text: " · task-1 · failed" },
         { color: "error", text: "✗" },
         { color: "dim", text: "---" },
         { color: "toolOutput", text: "Something broke." }
      ]);
      expect(withoutBgSample(backgrounds).map((entry) => entry.color)).toEqual(Array(lines.length).fill("toolErrorBg"));

      runtime.dispose();
   });

   it("renders a cancelled background result with the error terminal mark after the status text", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme, colors, backgrounds } = recordingTheme();
      const message = {
         customType: "harbor-result",
         content: "Task bg-task (task-1) cancelled.\nThe task was cancelled.",
         details: { id: "task-1", name: "bg-task", status: "cancelled" }
      };
      const width = 120;
      const lines = render(factory, message, false, theme, width);
      const header =
         "<customMessageLabel:[bg]> <toolTitle:task> <accent:bg-task><muted: · task-1 · cancelled> <error:✗>";

      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe(`<bg:toolErrorBg:${padToWidth(" ", width)}>`);
      expect(lines[1]).toBe(`<bg:toolErrorBg:${padToWidth(" " + header, width)}>`);
      expect(lines[2]).toBe(`<bg:toolErrorBg:${padToWidth(" " + "<dim:--->", width)}>`);
      expect(lines[3]).toBe(
         `<bg:toolErrorBg:${padToWidth(" " + "<toolOutput:The task was cancelled.>", width)}>`
      );
      expect(lines[4]).toBe(`<bg:toolErrorBg:${padToWidth(" ", width)}>`);
      expect(everyLineUsesBg(lines, "toolErrorBg")).toBe(true);
      expect(colors).toEqual([
         { color: "customMessageLabel", text: "[bg]" },
         { color: "toolTitle", text: "task" },
         { color: "accent", text: "bg-task" },
         { color: "muted", text: " · task-1 · cancelled" },
         { color: "error", text: "✗" },
         { color: "dim", text: "---" },
         { color: "toolOutput", text: "The task was cancelled." }
      ]);
      expect(withoutBgSample(backgrounds).map((entry) => entry.color)).toEqual(
         Array(lines.length).fill("toolErrorBg")
      );

      runtime.dispose();
   });

   it("collapses and expands long background results while preserving the background fill", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme: collapsedTheme, colors: collapsedColors, backgrounds: collapsedBackgrounds } = recordingTheme();
      const { theme: expandedTheme, colors: expandedColors, backgrounds: expandedBackgrounds } = recordingTheme();
      const body = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");
      const header =
         "<customMessageLabel:[bg]> <toolTitle:task> <accent:bg-task><muted: · task-1 · completed> <success:✓>";
      const message = {
         customType: "harbor-result",
         content: `Task bg-task (task-1) completed.\n${body}`,
         details: { id: "task-1", name: "bg-task", status: "completed" }
      };
      const width = 120;

      const collapsed = render(factory, message, false, collapsedTheme, width);
      const expanded = render(factory, message, true, expandedTheme, width);

      expect(collapsed).toHaveLength(13); // top + header + separator + 8 preview lines + expand hint + bottom
      expect(expanded).toHaveLength(16); // top + header + separator + 12 body lines + bottom

      expect(collapsed[1]).toBe(`<bg:toolSuccessBg:${padToWidth(" " + header, width)}>`);
      expect(unwrapBg(collapsed[collapsed.length - 2], "toolSuccessBg")?.trim()).toBe(
         "<muted:... (4 more lines,> <dim:ctrl+o><muted: to expand><muted:)>"
      );
      expect(unwrapBg(expanded[expanded.length - 2], "toolSuccessBg")?.trim()).toBe("<toolOutput:Line 12>");

      expect(everyLineUsesBg(collapsed, "toolSuccessBg")).toBe(true);
      expect(everyLineUsesBg(expanded, "toolSuccessBg")).toBe(true);

      expect(collapsedColors.filter((entry) => entry.color === "toolOutput")).toHaveLength(8);
      expect(expandedColors.filter((entry) => entry.color === "toolOutput")).toHaveLength(12);
      expect(collapsedColors.filter((entry) => entry.color === "dim")).toEqual([
         { color: "dim", text: "---" }
      ]);
      expect(withoutBgSample(collapsedBackgrounds).map((entry) => entry.color)).toEqual(
         Array(collapsed.length).fill("toolSuccessBg")
      );
      expect(withoutBgSample(expandedBackgrounds).map((entry) => entry.color)).toEqual(
         Array(expanded.length).fill("toolSuccessBg")
      );

      runtime.dispose();
   });

   it("collapsed truncated result shows the native expand keybinding hint with the omitted-line count", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme } = recordingTheme();
      const body = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");
      const message = {
         customType: "harbor-result",
         content: `Task bg-task (task-1) completed.\n${body}`,
         details: { id: "task-1", name: "bg-task", status: "completed" }
      };
      const width = 120;

      const lines = render(factory, message, false, theme, width);
      expect(lines).toHaveLength(13);
      expect(unwrapBg(lines[lines.length - 2], "toolSuccessBg")?.trim()).toBe(
         "<muted:... (4 more lines,> <dim:ctrl+o><muted: to expand><muted:)>"
      );
      expect(lines.every((line) => !line.includes("… expand for full result")));
      runtime.dispose();
   });

   it("collapsed non-truncated result omits the expand hint", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme } = recordingTheme();
      const body = ["one", "two", "three"].join("\n");
      const message = {
         customType: "harbor-result",
         content: `Task bg-task (task-1) completed.\n${body}`,
         details: { id: "task-1", name: "bg-task", status: "completed" }
      };
      const width = 120;

      const lines = render(factory, message, false, theme, width);
      expect(lines).toHaveLength(7); // top + header + separator + 3 body lines + bottom
      expect(lines.some((line) => line.includes("to expand"))).toBe(false);
      expect(lines.some((line) => line.includes("more line"))).toBe(false);
      runtime.dispose();
   });

   it("expanded result shows the full body and omits the expand/collapse hint", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme } = recordingTheme();
      const body = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");
      const message = {
         customType: "harbor-result",
         content: `Task bg-task (task-1) completed.\n${body}`,
         details: { id: "task-1", name: "bg-task", status: "completed" }
      };
      const width = 120;

      const lines = render(factory, message, true, theme, width);
      expect(lines).toHaveLength(16); // top + header + separator + 12 body lines + bottom
      expect(unwrapBg(lines[lines.length - 2], "toolSuccessBg")?.trim()).toBe("<toolOutput:Line 12>");
      expect(lines.some((line) => line.includes("to expand"))).toBe(false);
      expect(lines.some((line) => line.includes("more line"))).toBe(false);
      runtime.dispose();
   });

   it("uses the configured app.tools.expand keybinding for the expand hint", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const { theme } = recordingTheme();
      const customBindings = makeKeybindings({ "app.tools.expand": "ctrl+e" });
      setKeybindings(customBindings);
      const body = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
      const message = {
         customType: "harbor-result",
         content: `Task bg-task (task-1) completed.\n${body}`,
         details: { id: "task-1", name: "bg-task", status: "completed" }
      };
      const width = 120;

      const lines = render(factory, message, false, theme, width);
      expect(unwrapBg(lines[lines.length - 2], "toolSuccessBg")?.trim()).toBe(
         "<muted:... (2 more lines,> <dim:ctrl+e><muted: to expand><muted:)>"
      );

      setKeybindings(previousKeybindings);
      runtime.dispose();
   });

   it("uses theme.bg for a true full-width background fill, not foreground theme tokens, including padding and failed results", () => {
      const { mock, runtime } = setup();
      const factory = mock.messageRendererFactories.get("harbor-result")!;
      const width = 30;

      const success = recordingTheme();
      const successLines = render(factory, {
         customType: "harbor-result",
         content: "Task bg-task (task-1) completed.\nLine one.",
         details: { id: "task-1", name: "bg-task", status: "completed" }
      }, false, success.theme, width);

      const failed = recordingTheme();
      const failedLines = render(factory, {
         customType: "harbor-result",
         content: "Task bg-task (task-1) failed.\nLine one.",
         details: { id: "task-1", name: "bg-task", status: "failed" }
      }, false, failed.theme, width);

      const cancelled = recordingTheme();
      const cancelledLines = render(factory, {
         customType: "harbor-result",
         content: "Task bg-task (task-1) cancelled.\nLine one.",
         details: { id: "task-1", name: "bg-task", status: "cancelled" }
      }, false, cancelled.theme, width);

      // Each rendered line is wrapped in the correct tool-result background token.
      expect(everyLineUsesBg(successLines, "toolSuccessBg")).toBe(true);
      expect(everyLineUsesBg(failedLines, "toolErrorBg")).toBe(true);
      expect(everyLineUsesBg(cancelledLines, "toolErrorBg")).toBe(true);

      // Padding-only lines (top/bottom) are background-filled to the full render width.
      expect(unwrapBg(successLines[0], "toolSuccessBg")).toBe(" ".repeat(width));
      expect(unwrapBg(successLines[successLines.length - 1], "toolSuccessBg")).toBe(" ".repeat(width));
      expect(unwrapBg(failedLines[0], "toolErrorBg")).toBe(" ".repeat(width));
      expect(unwrapBg(failedLines[failedLines.length - 1], "toolErrorBg")).toBe(" ".repeat(width));

      // The inner space padding added by the Box is part of the background fill.
      expect(unwrapBg(successLines[1], "toolSuccessBg")?.startsWith(" <customMessageLabel:[bg]>")).toBe(true);
      expect(unwrapBg(failedLines[1], "toolErrorBg")?.startsWith(" <customMessageLabel:[bg]>")).toBe(true);

      // The foreground renderer never hijacks a background token.
      for (const { color } of [...success.colors, ...failed.colors]) {
         expect(color).not.toMatch(/^tool(Success|Error|Pending)Bg$/);
         expect(color).not.toBe("customMessageBg");
         expect(color).not.toBe("selectedBg");
         expect(color).not.toBe("userMessageBg");
      }

      // Background calls cover every output line so there are no un-painted gaps
      // (filter out Box's internal cache "test" sample call).
      expect(withoutBgSample(success.backgrounds)).toHaveLength(successLines.length);
      expect(withoutBgSample(failed.backgrounds)).toHaveLength(failedLines.length);

      runtime.dispose();
   });
});
