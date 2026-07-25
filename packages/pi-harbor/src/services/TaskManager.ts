import { Context, Effect, Layer } from "effect";
import { CapacityError, ConcurrencyLimitError, formatJobId, type Job, type TaskSpec } from "../domain.js";
import { JobRegistry } from "./JobRegistry.js";

export const MAX_RUNNING_AGENTS = 4;

export interface TaskManagerSpawnOptions {
   ownerSessionId?: string;
   origin?: "standard" | "vibe" | "btw";
   skipAgentSlot?: boolean;
}

export interface TaskManagerShape {
   readonly spawnTask: (
      spec: TaskSpec,
      options?: TaskManagerSpawnOptions
   ) => Effect.Effect<Job, CapacityError | ConcurrencyLimitError>;

   readonly spawnBatch: (
      specs: ReadonlyArray<TaskSpec>,
      options?: TaskManagerSpawnOptions
   ) => Effect.Effect<ReadonlyArray<Job>, CapacityError | ConcurrencyLimitError>;
}

export class TaskManager extends Context.Service<TaskManager, TaskManagerShape>()("harbor/TaskManager") {
   static readonly layer = Layer.effect(
      TaskManager,
      Effect.gen(function* () {
         const registry = yield* JobRegistry;
         let reservedAgentSlots = 0;
         let taskSeq = 0;

         const spawnBatch = Effect.fn("TaskManager.spawnBatch")(function* (
            specs: ReadonlyArray<TaskSpec>,
            options?: TaskManagerSpawnOptions
         ) {
            const incomingCount = specs.length;
            const skipSlot = options?.skipAgentSlot ?? false;
            const origin = options?.origin ?? "standard";

            if (!skipSlot) {
               const runningJobs = yield* registry.list({ status: "running" });
               const runningCount = runningJobs.length;

               if (runningCount + reservedAgentSlots + incomingCount > MAX_RUNNING_AGENTS) {
                  return yield* new ConcurrencyLimitError({
                     message: `Concurrency limit exceeded. Maximum ${MAX_RUNNING_AGENTS} concurrent agent jobs allowed.`,
                     limit: MAX_RUNNING_AGENTS
                  });
               }

               reservedAgentSlots += incomingCount;
            }

            return yield* Effect.uninterruptible(
               Effect.gen(function* () {
                  const registeredJobs: Job[] = [];
                  for (const spec of specs) {
                     taskSeq++;
                     const jobId = formatJobId(taskSeq);
                     const job = yield* registry.register({
                        id: jobId,
                        ownerSessionId: options?.ownerSessionId ?? "parent",
                        name: spec.name ?? null,
                        kind: "agent",
                        agent: spec.agent ?? "task",
                        origin,
                        promptOrCommand: spec.task,
                        harness: "pi"
                     });
                     const runningJob = yield* registry.updateStatus(job.id, "running");
                     registeredJobs.push(runningJob);
                  }
                  return registeredJobs;
               }).pipe(
                  Effect.ensuring(
                     Effect.sync(() => {
                        if (!skipSlot) {
                           reservedAgentSlots = Math.max(0, reservedAgentSlots - incomingCount);
                        }
                     })
                  )
               )
            );
         });

         const spawnTask = Effect.fn("TaskManager.spawnTask")(function* (
            spec: TaskSpec,
            options?: TaskManagerSpawnOptions
         ) {
            const batch = yield* spawnBatch([spec], options);
            return batch[0];
         });

         return TaskManager.of({
            spawnTask,
            spawnBatch
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: TaskManagerShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | TaskManager> {
      return Effect.gen(function* () {
         const svc = yield* TaskManager;
         return yield* fn(svc);
      });
   }
}
