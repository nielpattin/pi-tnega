import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { TaskManager, MAX_RUNNING_AGENTS } from "../src/services/TaskManager.js";
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
         Effect.provide(JobRegistry.layer)
      );

      await Effect.runPromise(program);
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
