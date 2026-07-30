import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import * as path from "node:path";
import { registerHarborExtension } from "../src/extension.js";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";
import { makeInjectedPersistenceLayer, type InjectedPersistenceOptions } from "./helpers/injectable-recovery.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { ParentSessionGate } from "../src/services/ParentSessionGate.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { HarborJobPersistence } from "../src/services/HarborJobPersistence.js";
import { ensureParentSessionRecovery } from "../src/services/HarborJobRecovery.js";
import { runTool } from "../src/runtime.js";
import type { Job } from "../src/domain.js";

const HARBOR_FORCE_EXCLUDES = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];

function buildPersistedJob(overrides: Partial<Job> & Pick<Job, "id" | "status">): Job {
   return {
      ownerSessionId: "parent",
      name: overrides.name ?? overrides.id,
      kind: "agent",
      agent: "task",
      async: false,
      model: undefined,
      thinking: undefined,
      cwd: process.cwd(),
      origin: "standard",
      promptOrCommand: "test prompt",
      createdAt: Date.now(),
      waitInterest: 0,
      killInterest: 0,
      sessionFile: undefined,
      sessionId: undefined,
      ...overrides
   } as Job;
}

function createMockPi(opts?: { settingsExtensions?: string[] }) {
   const registeredTools: Array<{ name: string; execute?: Function }> = [];
   const registeredCommands: Array<{ name: string; handler?: Function }> = [];
   const eventHandlers = new Map<string, Function[]>();
   const entries: Array<{ type: string; data: unknown }> = [];
   let activeTools: string[] = [];

   const pi = {
      getAllTools: () =>
         registeredTools.map((t) => ({
            name: t.name,
            description: t.name,
            parameters: {},
            sourceInfo: { path: "packages/pi-harbor/index.ts" }
         })),
      getActiveTools: () => activeTools,
      setActiveTools: vi.fn((names: string[]) => {
         activeTools = [...names];
      }),
      getCommands: () => registeredCommands.map((c) => ({ name: c.name, source: "prompt" as const })),
      getSettings: () => ({ extensions: opts?.settingsExtensions ?? [] }),
      registerTool: vi.fn((def: any) => {
         const idx = registeredTools.findIndex((t) => t.name === def.name);
         if (idx >= 0) registeredTools[idx] = def;
         else registeredTools.push(def);
         if (!activeTools.includes(def.name)) activeTools.push(def.name);
      }),
      registerCommand: vi.fn((name: string, options: any) => {
         registeredCommands.push({ name, handler: options.handler ?? options });
      }),
      registerEntryRenderer: vi.fn(),
      registerMessageRenderer: vi.fn(),
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
      entries,
      emit: async (event: string, payload: unknown, ctx: unknown) => {
         for (const handler of eventHandlers.get(event) ?? []) {
            await handler(payload, ctx);
         }
      }
   };
}

function makeCtx(parentSessionFile?: string) {
   return {
      mode: "tui" as const,
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: {
         getSessionId: () => "parent",
         getSessionFile: () => parentSessionFile,
         getEntries: () => []
      },
      model: undefined,
      isIdle: () => true
   };
}

function runtimeWithPersistence(options: InjectedPersistenceOptions = {}) {
   const persistenceLayer = makeInjectedPersistenceLayer(options);
   return makeFakeHarborRuntime(undefined, undefined, undefined, persistenceLayer);
}

async function expectActivationFailure(
   runtime: ReturnType<typeof makeFakeHarborRuntime>,
   parentSessionFile?: string,
   pattern?: RegExp
) {
   const exit = await runtime.runPromiseExit(ensureParentSessionRecovery(parentSessionFile));
   expect(Exit.isFailure(exit)).toBe(true);
   const error = Exit.isFailure(exit) ? String(exit.cause) : "";
   expect(error).toMatch(pattern ?? /activation failed|cannot|full|broken|transient|Injected/i);
}

async function expectNoJobs(runtime: ReturnType<typeof makeFakeHarborRuntime>) {
   const jobs = await runTool(runtime, JobRegistry.use((r) => r.list()));
   expect(jobs).toHaveLength(0);
}

describe("Harbor parent-recovery failure gating", () => {
   it("fails activation on configure error and prevents task spawn", async () => {
      const options: InjectedPersistenceOptions = { failAt: "configure", message: "cannot create child dir" };
      const runtime = runtimeWithPersistence(options);
      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      const parentB = path.join("/tmp", "harbor-gate-b", "2026-01-15T123456Z_b.jsonl");

      await expectActivationFailure(runtime, parentB, /cannot create child dir/i);

      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
      const result = await taskTool.execute!("tc-1", { task: "work", name: "work", agent: "task", background: true }, undefined, undefined, makeCtx(parentB));
      expect(result.details.ok).toBe(false);
      expect(result.content[0].text).toMatch(/cannot create child dir|Harbor parent session activation failed/i);

      await expectNoJobs(runtime);
      await runtime.dispose();
   });

   it("fails activation on load error and prevents vibe spawn", async () => {
      const options: InjectedPersistenceOptions = { failAt: "load", message: "cannot read manifest" };
      const runtime = runtimeWithPersistence(options);
      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      const parentB = path.join("/tmp", "harbor-gate-b", "2026-01-15T123456Z_b.jsonl");

      await expectActivationFailure(runtime, parentB, /cannot read manifest/i);

      const vibeTool = mock.registeredTools.find((t) => t.name === "vibe")!;
      const result = await vibeTool.execute!("tc-1", { op: "spawn", cli: "fast", prompt: "vibe work" }, undefined, undefined, makeCtx(parentB));
      expect(result.details.ok).toBe(false);
      expect(result.content[0].text).toMatch(/cannot read manifest|Harbor parent session activation failed/i);

      await expectNoJobs(runtime);
      await runtime.dispose();
   });

   it("fails activation on replace/manifest capacity failure and prevents btw spawn", async () => {
      const parentB = path.join("/tmp", "harbor-gate-b", "2026-01-15T123456Z_b.jsonl");
      const oversized = Array.from({ length: 65 }, (_, i) =>
         buildPersistedJob({ id: `task-${i + 1}`, status: "completed", name: `job-${i + 1}` })
      );
      const runtime = runtimeWithPersistence({ initialIndexes: { [parentB]: oversized } });
      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      await expectActivationFailure(runtime, parentB, /registry full/i);

      const btwCmd = mock.registeredCommands.find((c) => c.name === "btw")!;
      const ctx = { ...makeCtx(parentB), ui: { notify: vi.fn() } };
      await btwCmd.handler!("side question", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/registry full|Harbor parent session activation failed/i), "error");
      await expectNoJobs(runtime);
      await runtime.dispose();
   });

   it("isolates parent A -> B failure from A jobs and target", async () => {
      const parentA = path.join("/tmp", "harbor-gate-a", "2026-01-15T123456Z_a.jsonl");
      const parentB = path.join("/tmp", "harbor-gate-b", "2026-01-15T123456Z_b.jsonl");
      const options: InjectedPersistenceOptions = { failAt: "configure", failAtParentFile: parentB, message: "B is broken" };
      const runtime = runtimeWithPersistence(options);
      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      // Activate A successfully.
      await mock.emit("session_start", {}, makeCtx(parentA));
      await runTool(
         runtime,
         Effect.gen(function* () {
            const registry = yield* JobRegistry;
            return yield* registry.register({
               id: "task-1",
               ownerSessionId: "parent",
               name: "in-a",
               kind: "agent",
               promptOrCommand: "a"
            });
         })
      );
      let jobs = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobs.some((j) => j.name === "in-a")).toBe(true);
      const persistence = await runTool(runtime, HarborJobPersistence);
      expect(await runTool(runtime, persistence.currentTarget())).toBe(parentA);

      // Switch to B and observe failure.
      await mock.emit("session_start", {}, makeCtx(parentB));
      jobs = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobs).toHaveLength(0);
      expect(await runTool(runtime, persistence.currentTarget())).toBeUndefined();
      await expectActivationFailure(runtime, parentB, /B is broken/i);

      // B spawns must be rejected and the previously active A jobs must not remain.
      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
      const result = await taskTool.execute!("tc-1", { task: "after fail", name: "after fail", agent: "task", background: true }, undefined, undefined, makeCtx(parentB));
      expect(result.details.ok).toBe(false);
      expect(result.content[0].text).toMatch(/B is broken|Harbor parent session activation failed/i);
      await expectNoJobs(runtime);

      await runtime.dispose();
   });

   it("does not register a job when task, vibe, or btw spawn is rejected", async () => {
      const parentB = path.join("/tmp", "harbor-gate-b", "2026-01-15T123456Z_b.jsonl");
      const options: InjectedPersistenceOptions = {
         failAt: "persist",
         message: "write refused",
         initialIndexes: { [parentB]: [buildPersistedJob({ id: "task-1", status: "completed", name: "preexisting" })] }
      };
      const runtime = runtimeWithPersistence(options);
      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
      const taskResult = await taskTool.execute!("tc-task", { task: "work", name: "work", agent: "task", background: true }, undefined, undefined, makeCtx(parentB));
      expect(taskResult.details.ok).toBe(false);

      const vibeTool = mock.registeredTools.find((t) => t.name === "vibe")!;
      const vibeResult = await vibeTool.execute!("tc-vibe", { op: "spawn", cli: "fast", prompt: "vibe work" }, undefined, undefined, makeCtx(parentB));
      expect(vibeResult.details.ok).toBe(false);

      const btwCmd = mock.registeredCommands.find((c) => c.name === "btw")!;
      const ctx = { ...makeCtx(parentB), ui: { notify: vi.fn() } };
      await btwCmd.handler!("side question", ctx);
      expect(ctx.ui.notify).toHaveBeenCalled();

      await expectNoJobs(runtime);
      await runtime.dispose();
   });

   it("allows a later retry to activate successfully", async () => {
      const parentB = path.join("/tmp", "harbor-gate-b", "2026-01-15T123456Z_b.jsonl");
      const options: InjectedPersistenceOptions = { failAt: "configure", failAtParentFile: parentB, message: "transient" };
      const runtime = runtimeWithPersistence(options);
      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      await expectActivationFailure(runtime, parentB, /transient/i);

      // Remove the injected failure and retry the same parent.
      options.failAt = undefined;

      await mock.emit("session_start", {}, makeCtx(parentB));

      const state = await runTool(runtime, ParentSessionGate.use((g) => g.stateFor(parentB)));
      expect(state).toBe("ready");

      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
      const result = await taskTool.execute!("tc-retry", { task: "retry work", name: "retry", agent: "task", background: true }, undefined, undefined, makeCtx(parentB));
      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.id).toMatch(/^task-\d+$/);

      const jobs = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobs).toHaveLength(1);

      await runtime.dispose();
   });
});
