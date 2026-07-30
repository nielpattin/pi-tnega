import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { registerHarborExtension } from "../src/extension.js";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { HarborJobPersistence } from "../src/services/HarborJobPersistence.js";
import { runTool } from "../src/runtime.js";
import { activateParentSession, flushPendingWrites } from "../src/services/HarborJobRecovery.js";
import { ParentSessionGate } from "../src/services/ParentSessionGate.js";
import type { Job } from "../src/domain.js";

function makeTempSessionDir(prefix = "harbor-lifecycle-") {
   const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
   const parentFile = path.join(base, "2026-01-15T123456Z_parent-session-id.jsonl");
   return { base, parentFile, childDir: parentFile.slice(0, -".jsonl".length) };
}

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

function writeIndex(childDir: string, jobs: ReadonlyArray<Job>, extra?: object) {
   fs.mkdirSync(childDir, { recursive: true });
   const index = {
      version: 1,
      parentSessionFile: path.join(path.dirname(childDir), path.basename(childDir) + ".jsonl"),
      writtenAt: Date.now(),
      ...extra,
      jobs
   };
   fs.writeFileSync(path.join(childDir, "harbor-jobs.json"), JSON.stringify(index, undefined, 2), "utf8");
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
      eventHandlers,
      emit: async (event: string, payload: unknown, ctx: unknown) => {
         for (const handler of eventHandlers.get(event) ?? []) {
            await handler(payload, ctx);
         }
      }
   };
}

const HARBOR_FORCE_EXCLUDES = ["-extensions/tasks/index.ts", "-extensions/background-terminals/index.ts"];

describe("Harbor recovery lifecycle", () => {
   it("isolates jobs and manifests when switching parent A -> B -> A", async () => {
      const a = makeTempSessionDir("harbor-A-");
      const b = makeTempSessionDir("harbor-B-");

      writeIndex(a.childDir, [buildPersistedJob({ id: "task-1", status: "completed", name: "in-a" })]);
      writeIndex(b.childDir, [buildPersistedJob({ id: "task-5", status: "completed", name: "in-b" })]);

      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      let currentFile: string | undefined = a.parentFile;
      const ctx = {
         mode: "tui" as const,
         hasUI: true,
         cwd: process.cwd(),
         sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => currentFile
         },
         model: undefined,
         isIdle: () => true
      };

      await mock.emit("session_start", {}, ctx);

      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
      await taskTool.execute!(
         "tc-a1",
         { task: "after a", name: "after a", background: true },
         undefined,
         undefined,
         ctx
      );

      const jobsAfterA = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobsAfterA.map((j) => j.name).sort()).toEqual(["after a", "in-a"].sort());

      await runTool(runtime, flushPendingWrites());

      const aIndexPath = path.join(a.childDir, "harbor-jobs.json");
      const aAfterFirst = JSON.parse(fs.readFileSync(aIndexPath, "utf8"));
      expect(aAfterFirst.jobs).toHaveLength(2);
      expect(aAfterFirst.jobs.some((j: Job) => j.name === "in-a")).toBe(true);

      currentFile = b.parentFile;
      await mock.emit("session_start", {}, ctx);
      await taskTool.execute!(
         "tc-b1",
         { task: "after b", name: "after b", background: true },
         undefined,
         undefined,
         ctx
      );

      const jobsAfterB = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobsAfterB.map((j) => j.name)).toContain("in-b");
      expect(jobsAfterB.map((j) => j.name)).toContain("after b");
      expect(jobsAfterB.some((j) => j.name === "in-a" || j.name === "after a")).toBe(false);

      await runTool(runtime, flushPendingWrites());

      const bIndexPath = path.join(b.childDir, "harbor-jobs.json");
      const bAfter = JSON.parse(fs.readFileSync(bIndexPath, "utf8"));
      expect(bAfter.jobs).toHaveLength(2);

      const aAfterSwitch = JSON.parse(fs.readFileSync(aIndexPath, "utf8"));
      expect(aAfterSwitch.jobs).toHaveLength(2);

      currentFile = a.parentFile;
      await mock.emit("session_start", {}, ctx);
      const jobsBackToA = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobsBackToA.map((j) => j.name).sort()).toEqual(["after a", "in-a"].sort());

      await runtime.dispose();

      fs.rmSync(a.base, { recursive: true, force: true });
      fs.rmSync(b.base, { recursive: true, force: true });
   });

   it("isolates parent A through malformed lazy paths before recovering parent B", async () => {
      const a = makeTempSessionDir("harbor-malformed-a-");
      const b = makeTempSessionDir("harbor-malformed-b-");
      writeIndex(a.childDir, [buildPersistedJob({ id: "task-1", status: "completed", name: "in-a" })]);
      writeIndex(b.childDir, [buildPersistedJob({ id: "task-5", status: "completed", name: "in-b" })]);

      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });
      const persistence = await runTool(runtime, HarborJobPersistence);

      let currentFile: string | undefined = a.parentFile;
      const ctx = {
         mode: "tui" as const,
         hasUI: true,
         cwd: process.cwd(),
         sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => currentFile
         },
         model: undefined,
         isIdle: () => true
      };

      try {
         await mock.emit("session_start", {}, ctx);
         const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
         await taskTool.execute!(
            "tc-a1",
            { task: "after a", name: "after a", background: true },
            undefined,
            undefined,
            ctx
         );
         await runTool(runtime, flushPendingWrites());
         const aManifestPath = path.join(a.childDir, "harbor-jobs.json");
         const aManifestBeforeInvalid = fs.readFileSync(aManifestPath, "utf8");

         for (const invalid of [
            path.join(a.base, "not-a-session.txt"),
            "C:\\\\Sessions\\\\not-a-session.txt"
         ]) {
            currentFile = invalid;
            await mock.emit("session_start", {}, ctx);

            expect(await runTool(runtime, persistence.currentTarget())).toBeUndefined();
            expect(await runTool(runtime, JobRegistry.use((r) => r.list()))).toHaveLength(0);

            const invalidResult = await taskTool.execute!(
               "tc-invalid",
               { task: "ephemeral work", name: "ephemeral", background: true },
               undefined,
               undefined,
               ctx
            );
            expect(JSON.parse(invalidResult.content[0].text).ok).toBe(true);
            const secondInvalidResult = await taskTool.execute!(
               "tc-invalid-2",
               { task: "another ephemeral work item", name: "ephemeral-2", background: true },
               undefined,
               undefined,
               ctx
            );
            expect(JSON.parse(secondInvalidResult.content[0].text).ok).toBe(true);
            await runTool(runtime, flushPendingWrites());
            expect(fs.readFileSync(aManifestPath, "utf8")).toBe(aManifestBeforeInvalid);

            // Session-start activation on the next malformed path must not inherit
            // the ephemeral jobs from the prior invalid phase either.
            expect(await runTool(runtime, JobRegistry.use((r) => r.list()))).toHaveLength(2);
         }

         currentFile = b.parentFile;
         await mock.emit("session_start", {}, ctx);
         const recovered = await runTool(runtime, JobRegistry.use((r) => r.list()));
         expect(recovered.map((job) => job.name)).toEqual(["in-b"]);

         const bResult = await taskTool.execute!(
            "tc-b1",
            { task: "after b", name: "after b", background: true },
            undefined,
            undefined,
            ctx
         );
         expect(JSON.parse(bResult.content[0].text).ok).toBe(true);
         await runTool(runtime, flushPendingWrites());

         const bIndex = JSON.parse(fs.readFileSync(path.join(b.childDir, "harbor-jobs.json"), "utf8"));
         expect(bIndex.jobs.map((job: Job) => job.name).sort()).toEqual(["after b", "in-b"].sort());
      } finally {
         await runtime.dispose();
         fs.rmSync(a.base, { recursive: true, force: true });
         fs.rmSync(b.base, { recursive: true, force: true });
      }
   });

   it("clears target for undefined parent session file and recovers when file becomes available", async () => {
      const a = makeTempSessionDir("harbor-undef-");
      writeIndex(a.childDir, [buildPersistedJob({ id: "task-3", status: "completed", name: "lazy" })]);
      const previous = makeTempSessionDir("harbor-prev-");
      writeIndex(previous.childDir, [buildPersistedJob({ id: "task-1", status: "completed", name: "previous" })]);

      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      let currentFile: string | undefined = previous.parentFile;
      const ctx = {
         mode: "tui" as const,
         hasUI: true,
         cwd: process.cwd(),
         sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => currentFile
         },
         model: undefined,
         isIdle: () => true
      };

      await mock.emit("session_start", {}, ctx);
      currentFile = undefined;
      await mock.emit("session_start", {}, ctx);

      const jobsAfterClear = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobsAfterClear).toHaveLength(0);

      const previousFilesAfterClear = fs
         .readdirSync(previous.childDir)
         .filter((f) => f.startsWith("harbor-jobs"));
      expect(previousFilesAfterClear).toHaveLength(1);

      currentFile = a.parentFile;
      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;
      await taskTool.execute!(
         "tc-lazy",
         { task: "lazy spawn", name: "lazy spawn", background: true },
         undefined,
         undefined,
         ctx
      );

      const jobsAfterLazy = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobsAfterLazy.map((j) => j.name)).toContain("lazy");
      expect(jobsAfterLazy.some((j) => j.id === "task-4")).toBe(true);

      const aIndexPath = path.join(a.childDir, "harbor-jobs.json");
      expect(fs.existsSync(aIndexPath)).toBe(true);

      await runtime.dispose();

      fs.rmSync(a.base, { recursive: true, force: true });
      fs.rmSync(previous.base, { recursive: true, force: true });
   });

   it("recovers a preloaded manifest without per-job partial writes and persists once", async () => {
      const a = makeTempSessionDir("harbor-preload-");
      const stored = [
         buildPersistedJob({ id: "task-1", status: "completed", name: "one" }),
         buildPersistedJob({ id: "task-2", status: "failed", name: "two" }),
         buildPersistedJob({ id: "task-3", status: "running", name: "three" })
      ];
      writeIndex(a.childDir, stored);

      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      const ctx = {
         mode: "tui" as const,
         hasUI: true,
         cwd: process.cwd(),
         sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => a.parentFile
         },
         model: undefined,
         isIdle: () => true
      };

      await mock.emit("session_start", {}, ctx);

      const jobs = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobs.map((j) => j.id).sort()).toEqual(["task-1", "task-2", "task-3"]);
      expect(jobs.find((j) => j.id === "task-3")!.status).toBe("failed");

      const indexPath = path.join(a.childDir, "harbor-jobs.json");
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      expect(index.jobs).toHaveLength(3);
      expect(index.jobs.map((j: Job) => j.name).sort()).toEqual(["one", "three", "two"].sort());

      const leftovers = fs.readdirSync(a.childDir).filter((f) => f.startsWith("harbor-jobs.json.tmp-"));
      expect(leftovers).toHaveLength(0);

      await runtime.dispose();

      fs.rmSync(a.base, { recursive: true, force: true });
   });

   it("gates task spawning until recovery activation completes", async () => {
      const a = makeTempSessionDir("harbor-race-");
      writeIndex(a.childDir, [buildPersistedJob({ id: "task-5", status: "completed", name: "recovered" })]);

      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      const ctx = {
         mode: "tui" as const,
         hasUI: true,
         cwd: process.cwd(),
         sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => a.parentFile
         },
         model: undefined,
         isIdle: () => true
      };

      const startHandler = mock.eventHandlers.get("session_start")![0];
      const startPromise = startHandler({}, ctx);
      const taskTool = mock.registeredTools.find((t) => t.name === "task")!;

      const [spawned] = await Promise.all([
         taskTool.execute!(
            "tc-race",
            { task: "racing spawn", name: "racing spawn", background: true },
            undefined,
            undefined,
            ctx
         ),
         startPromise
      ]);

      const payload = JSON.parse(spawned.content[0].text);
      expect(payload.id).toBe("task-6");

      const jobs = await runTool(runtime, JobRegistry.use((r) => r.list()));
      expect(jobs.map((j) => j.id).sort()).toEqual(["task-5", "task-6"]);

      await runtime.dispose();
      fs.rmSync(a.base, { recursive: true, force: true });
   });

   it("rejects duplicate job IDs in the registry", async () => {
      const runtime = makeFakeHarborRuntime();

      const exit = await runtime.runPromiseExit(
         Effect.gen(function* () {
            const registry = yield* JobRegistry;
            yield* registry.register({
               id: "task-1",
               ownerSessionId: "parent",
               name: "first",
               kind: "agent",
               promptOrCommand: "first"
            });
            return yield* registry.register({
               id: "task-1",
               ownerSessionId: "parent",
               name: "second",
               kind: "agent",
               promptOrCommand: "second"
            });
         })
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
         const message = Cause.pretty(exit.cause);
         expect(message).toContain("DuplicateJobError");
      }
      await runtime.dispose();
   });

   it("cleans up and reloads exactly one persistence listener per parent", async () => {
      const a = makeTempSessionDir("harbor-listener-a-");
      const b = makeTempSessionDir("harbor-listener-b-");
      writeIndex(a.childDir, [buildPersistedJob({ id: "task-1", status: "completed", name: "listener-a" })]);
      writeIndex(b.childDir, [buildPersistedJob({ id: "task-1", status: "completed", name: "listener-b" })]);

      const runtime = makeFakeHarborRuntime();
      const persistence = await runTool(runtime, HarborJobPersistence);

      await runtime.runPromise(activateParentSession(a.parentFile));
      const aMtimeBefore = fs.statSync(path.join(a.childDir, "harbor-jobs.json")).mtimeMs;

      await new Promise((resolve) => setTimeout(resolve, 20));
      await runtime.runPromise(
         JobRegistry.use((registry) =>
            registry.register({
               id: "task-2",
               ownerSessionId: "parent",
               name: "new-in-a",
               kind: "agent",
               promptOrCommand: "new"
            })
         )
      );
      await runTool(runtime, flushPendingWrites());
      const aMtimeAfter = fs.statSync(path.join(a.childDir, "harbor-jobs.json")).mtimeMs;
      expect(aMtimeAfter).toBeGreaterThan(aMtimeBefore);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await runtime.runPromise(activateParentSession(b.parentFile));
      await runtime.runPromise(
         JobRegistry.use((registry) =>
            registry.register({
               id: "task-2",
               ownerSessionId: "parent",
               name: "new-in-b",
               kind: "agent",
               promptOrCommand: "new-b"
            })
         )
      );
      await runTool(runtime, flushPendingWrites());

      const aMtimeFinal = fs.statSync(path.join(a.childDir, "harbor-jobs.json")).mtimeMs;
      expect(aMtimeFinal).toBe(aMtimeAfter);

      const bIndex = JSON.parse(fs.readFileSync(path.join(b.childDir, "harbor-jobs.json"), "utf8"));
      expect(bIndex.jobs).toHaveLength(2);
      expect(bIndex.jobs.some((j: Job) => j.name === "new-in-b")).toBe(true);

      await runtime.dispose();

      fs.rmSync(a.base, { recursive: true, force: true });
      fs.rmSync(b.base, { recursive: true, force: true });
   });

   it("makes recovered jobs visible through /tasks", async () => {
      const a = makeTempSessionDir("harbor-tasks-");
      writeIndex(a.childDir, [
         buildPersistedJob({ id: "task-1", status: "completed", name: "visible-done" }),
         buildPersistedJob({ id: "task-2", status: "failed", name: "visible-fail" })
      ]);

      const mock = createMockPi({ settingsExtensions: HARBOR_FORCE_EXCLUDES });
      const runtime = makeFakeHarborRuntime();
      registerHarborExtension(mock.pi, { settingsExtensions: HARBOR_FORCE_EXCLUDES, runtime });

      const ctx = {
         mode: "tui" as const,
         hasUI: false,
         cwd: process.cwd(),
         sessionManager: {
            getSessionId: () => "parent",
            getSessionFile: () => a.parentFile,
            getEntries: () => []
         },
         model: undefined
      };

      await runTool(runtime, activateParentSession(a.parentFile));

      const tasksCmd = mock.registeredCommands.find((c) => c.name === "tasks")!;
      await tasksCmd.handler!("", ctx);

      expect(mock.entries.some((e) => e.type === "harbor-tasks-snapshot")).toBe(true);
      const snapshot = mock.entries.find((e) => e.type === "harbor-tasks-snapshot")!;
      expect((snapshot.data as { text: string }).text).toContain("visible-done");
      expect((snapshot.data as { text: string }).text).toContain("visible-fail");

      await runtime.dispose();

      fs.rmSync(a.base, { recursive: true, force: true });
   });
});
