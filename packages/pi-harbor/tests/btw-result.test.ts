import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { PiBackend, PI_BACKEND_CAPABILITIES, spawnPiSession } from "../src/backends/pi.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { TaskManager, MAX_RUNNING_AGENTS } from "../src/services/TaskManager.js";
import { FakeAgyBackend, FakePiBackend, makeFakeHarborRuntime } from "./helpers/fake-backends.js";
import {
   canSpawnBtw,
   buildBtwJobFields,
   formatBtwResultEntry,
   handleBtwCommand
} from "../src/commands/btw.js";

describe("/btw Side Task Command & Helpers", () => {
   it("canSpawnBtw returns true only when activeBtwCount < 1", () => {
      expect(canSpawnBtw(0)).toBe(true);
      expect(canSpawnBtw(1)).toBe(false);
      expect(canSpawnBtw(2)).toBe(false);
   });

   it("buildBtwJobFields creates spec with task agent, prompt, parentModel, and btw origin", () => {
      const spec = buildBtwJobFields("quick query", "gpt-5.6-sol");
      expect(spec.task).toBe("quick query");
      expect(spec.agent).toBe("task");
      expect(spec.model).toBe("gpt-5.6-sol");
      expect(spec.origin).toBe("btw");
   });

   it("formatBtwResultEntry formats custom btw-result entry", () => {
      const entry = formatBtwResultEntry({
         id: "task-99",
         status: "completed",
         promptOrCommand: "what time is it?",
         rawText: "It is 9:00 PM."
      });
      expect(entry.customType).toBe("btw-result");
      expect(entry.data).toEqual({
         jobId: "task-99",
         status: "completed",
         prompt: "what time is it?",
         text: "It is 9:00 PM."
      });
   });

   it("TaskManager spawns btw task with skipAgentSlot: true without consuming MAX_RUNNING_AGENTS slot", async () => {
      const program = Effect.gen(function* () {
         const tm = yield* TaskManager;
         const registry = yield* JobRegistry;

         // Fill up max running standard agent slots (4)
         for (let i = 1; i <= MAX_RUNNING_AGENTS; i++) {
            const job = yield* registry.register({
               id: `task-${i}`,
               ownerSessionId: "parent",
               name: null,
               kind: "agent",
               promptOrCommand: `job ${i}`
            });
            yield* registry.updateStatus(job.id, "running");
         }

         // Align TaskManager sequence so it does not attempt ids already in the registry.
         yield* tm.reserveTaskSeq(MAX_RUNNING_AGENTS);

         // Spawning standard task now fails due to limit
         const standardExit = yield* Effect.exit(
            tm.spawnTask({ task: "standard overflow" })
         );
         expect(standardExit._tag).toBe("Failure");

         // Spawning btw task with skipAgentSlot: true succeeds
         const btwJob = yield* tm.spawnTask(
            { task: "side question", agent: "task" },
            { origin: "btw", skipAgentSlot: true }
         );

         expect(btwJob.origin).toBe("btw");
         expect(btwJob.status).toBe("running");
         return btwJob;
      }).pipe(
         Effect.provide(TaskManager.layer),
         Effect.provide(FakePiBackend),
         Effect.provide(FakeAgyBackend),
         Effect.provide(JobRegistry.layer)
      );

      await Effect.runPromise(program);
   });

   it("routes /btw parent session files into the Pi child session directory", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-btw-child-"));
      const parentSessionFile = path.join(tmpBase, "2026-01-15T123456Z_parent.jsonl");
      const expectedChildDir = path.join(tmpBase, "2026-01-15T123456Z_parent");
      let capturedParentSessionFile: string | undefined;
      let capturedSessionManager: { getSessionDir: () => string } | undefined;
      const fakeSession = {
         getAllTools: () => [{ name: "submit" }, { name: "hub" }],
         setActiveToolsByName: () => {},
         bindExtensions: async () => {},
         subscribe: () => () => {},
         prompt: async () => {},
         clearQueue: () => {},
         abort: async () => {},
         setSessionName: () => {},
         model: { provider: "proxy", id: "btw-model" },
         thinkingLevel: "medium",
         isStreaming: false
      };
      const piLayer = Layer.succeed(
         PiBackend,
         PiBackend.of({
            capabilities: PI_BACKEND_CAPABILITIES,
            spawnSession: async (options) => {
               capturedParentSessionFile = options.parentSessionFile;
               return spawnPiSession({
                  ...options,
                  createSessionFn: (async (createOptions: any) => {
                     capturedSessionManager = createOptions.sessionManager;
                     return { session: fakeSession, extensionsResult: {} };
                  }) as any
               });
            }
         })
      );
      const runtime = makeFakeHarborRuntime(FakeAgyBackend, piLayer);

      try {
         const taskManager = await runtime.runPromise(TaskManager);
         const result = await handleBtwCommand({
            prompt: "check the child session route",
            parentModel: "proxy/btw-model",
            activeBtwCount: 0,
            parentSessionFile,
            taskManager
         });

         expect(result.ok).toBe(true);
         expect(capturedParentSessionFile).toBe(parentSessionFile);
         expect(capturedSessionManager?.getSessionDir()).toBe(expectedChildDir);
         expect(fs.existsSync(expectedChildDir)).toBe(true);
      } finally {
         await runtime.dispose();
         fs.rmSync(tmpBase, { recursive: true, force: true });
      }
   });

   it("handleBtwCommand rejects when max concurrent btw is active", async () => {
      const mockTaskManager = {
         spawnTask: () => Effect.succeed({ id: "task-1", origin: "btw" })
      } as any;

      const resActive = await handleBtwCommand({
         prompt: "test",
         parentModel: "gpt-5",
         activeBtwCount: 1,
         taskManager: mockTaskManager
      });

      expect(resActive.ok).toBe(false);
      expect(resActive.message).toContain("Maximum 1 concurrent /btw");
   });

   it("handleBtwCommand spawns task when no active btw", async () => {
      let spawnedSpec: any;
      let spawnedOpts: any;

      const mockTaskManager = {
         spawnTask: (spec: any, opts: any) => {
            spawnedSpec = spec;
            spawnedOpts = opts;
            return Effect.succeed({ id: "task-10", origin: "btw" });
         }
      } as any;

      const res = await handleBtwCommand({
         prompt: "explain this diff",
         parentModel: "kimi-k2.7",
         activeBtwCount: 0,
         taskManager: mockTaskManager
      });

      expect(res.ok).toBe(true);
      expect(res.jobId).toBe("task-10");
      expect(spawnedSpec.task).toBe("explain this diff");
      expect(spawnedSpec.agent).toBe("task");
      expect(spawnedOpts).toEqual({ origin: "btw", skipAgentSlot: true });
   });
});
