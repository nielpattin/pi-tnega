import { Context, Effect, Layer } from "effect";
import { CapacityError, DuplicateTaskError, type Task, type TaskStatus } from "../domain.js";
import { WORKERS_TASK_MANIFEST_LIMITS, pruneTerminalTasksForRetention } from "./workers-task-manifest.js";

export interface TaskRegistryShape {
   readonly register: (
      init: Omit<Task, "status" | "createdAt">
   ) => Effect.Effect<Task, CapacityError | DuplicateTaskError>;
   readonly restore: (task: Task) => Effect.Effect<Task, CapacityError>;
   readonly get: (id: string) => Effect.Effect<Task | undefined>;
   readonly list: (filter?: { status?: TaskStatus }) => Effect.Effect<ReadonlyArray<Task>>;
   readonly updateStatus: (id: string, status: TaskStatus, patch?: Partial<Task>) => Effect.Effect<Task>;
   readonly onSettled: (listener: (task: Task) => void) => Effect.Effect<() => void>;
   readonly onChange: (listener: (jobs: ReadonlyArray<Task>) => void) => Effect.Effect<() => void>;
   readonly replaceAll: (jobs: ReadonlyArray<Task>) => Effect.Effect<void, CapacityError>;
   readonly clear: () => Effect.Effect<void>;
}

export class TaskRegistry extends Context.Service<TaskRegistry, TaskRegistryShape>()("workers/TaskRegistry") {
   static readonly layer = Layer.effect(
      TaskRegistry,
      Effect.gen(function* () {
         yield* Effect.void;
         const jobs = new Map<string, Task>();
         const settledListeners = new Set<(task: Task) => void>();
         const changeListeners = new Set<(jobs: ReadonlyArray<Task>) => void>();

         const notifyChange = () => {
            const snapshot = Array.from(jobs.values());
            for (const listener of changeListeners) {
               try {
                  listener(snapshot);
               } catch {
                  // A change listener cannot break registry updates.
               }
            }
         };

         const prune = () => {
            const limit = WORKERS_TASK_MANIFEST_LIMITS.maxTrackedJobs;
            const retained = pruneTerminalTasksForRetention(Array.from(jobs.values()), Date.now(), limit - 1);
            if (retained.length === jobs.size) return;

            const retainedIds = new Set(retained.map((task) => task.id));
            const toDelete: string[] = [];
            for (const id of jobs.keys()) {
               if (!retainedIds.has(id)) {
                  toDelete.push(id);
               }
            }
            for (const id of toDelete) {
               jobs.delete(id);
            }
         };

         const register = Effect.fn("TaskRegistry.register")(function* (taskInit) {
            prune();
            const limit = WORKERS_TASK_MANIFEST_LIMITS.maxTrackedJobs;
            if (jobs.size >= limit) {
               return yield* new CapacityError({
                  message: `Task registry full. Maximum tracked jobs cap (${limit}) reached.`,
                  limit
               });
            }

            if (jobs.has(taskInit.id)) {
               return yield* new DuplicateTaskError({
                  message: `Task ${taskInit.id} already exists in the registry.`,
                  id: taskInit.id
               });
            }

            const newTask: Task = {
               ...taskInit,
               status: "pending",
               createdAt: Date.now()
            };

            jobs.set(newTask.id, newTask);
            notifyChange();
            return newTask;
         });

         const get = Effect.fn("TaskRegistry.get")(function* (id: string) {
            yield* Effect.void;
            return jobs.get(id);
         });

         const list = Effect.fn("TaskRegistry.list")(function* (filter?: { status?: TaskStatus }) {
            yield* Effect.void;
            let result = Array.from(jobs.values());
            if (filter?.status) {
               result = result.filter((j) => j.status === filter.status);
            }
            return result;
         });

         const updateStatus = Effect.fn("TaskRegistry.updateStatus")(function* (
            id: string,
            status: TaskStatus,
            patch?: Partial<Task>
         ) {
            yield* Effect.void;
            const existing = jobs.get(id);
            if (!existing) {
               throw new Error(`Task not found: ${id}`);
            }

            const now = Date.now();
            const updated: Task = {
               ...existing,
               ...patch,
               status,
               startedAt: status === "running" ? (existing.startedAt ?? now) : existing.startedAt,
               settledAt:
                  status === "completed" || status === "failed" || status === "cancelled" || status === "recoverable"
                     ? existing.status === "running" || existing.status === "pending"
                        ? now
                        : (existing.settledAt ?? now)
                     : status === "running"
                       ? undefined
                       : existing.settledAt
            };

            jobs.set(id, updated);
            notifyChange();

            const becameSettled =
               (status === "completed" || status === "failed" || status === "cancelled" || status === "recoverable") &&
               existing.status !== "completed" &&
               existing.status !== "failed" &&
               existing.status !== "cancelled" &&
               existing.status !== "recoverable";
            if (becameSettled) {
               for (const listener of settledListeners) {
                  try {
                     listener({ ...updated });
                  } catch {
                     // A delivery listener cannot break registry settlement.
                  }
               }
            }

            return updated;
         });

         const onSettled = Effect.fn("TaskRegistry.onSettled")(function* (listener: (task: Task) => void) {
            yield* Effect.sync(() => settledListeners.add(listener));
            return () => settledListeners.delete(listener);
         });

         const onChange = Effect.fn("TaskRegistry.onChange")(function* (listener: (jobs: ReadonlyArray<Task>) => void) {
            yield* Effect.sync(() => changeListeners.add(listener));
            return () => changeListeners.delete(listener);
         });

         const restore = Effect.fn("TaskRegistry.restore")(function* (task: Task) {
            if (jobs.has(task.id)) {
               return jobs.get(task.id)!;
            }
            const limit = WORKERS_TASK_MANIFEST_LIMITS.maxTrackedJobs;
            if (jobs.size >= limit) {
               return yield* new CapacityError({
                  message: `Task registry full. Maximum tracked jobs cap (${limit}) reached.`,
                  limit
               });
            }
            jobs.set(task.id, task);
            notifyChange();
            return task;
         });

         const clear = Effect.fn("TaskRegistry.clear")(() => Effect.sync(() => jobs.clear()));

         const replaceAll = Effect.fn("TaskRegistry.replaceAll")(function* (newJobs: ReadonlyArray<Task>) {
            const limit = WORKERS_TASK_MANIFEST_LIMITS.maxTrackedJobs;
            if (newJobs.length > limit) {
               return yield* new CapacityError({
                  message: `Task registry full. Maximum tracked jobs cap (${limit}) reached.`,
                  limit
               });
            }

            jobs.clear();
            for (const task of newJobs) {
               jobs.set(task.id, task);
            }
            return yield* Effect.void;
         });

         return TaskRegistry.of({
            register,
            get,
            list,
            updateStatus,
            onSettled,
            onChange,
            restore,
            replaceAll,
            clear
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: TaskRegistryShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | TaskRegistry> {
      return Effect.gen(function* () {
         const svc = yield* TaskRegistry;
         return yield* fn(svc);
      });
   }
}
