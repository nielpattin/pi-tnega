import { Context, Effect, Layer, Deferred } from "effect";
import { CapacityError, DuplicateJobError, type Job, type JobKind, type JobStatus } from "../domain.js";
import { HARBOR_JOB_MANIFEST_LIMITS, pruneTerminalJobsForRetention } from "./HarborJobManifest.js";

export const MAX_TRACKED_JOBS = 64;

export interface JobRegistryShape {
   readonly register: (
      job: Omit<Job, "status" | "createdAt" | "waitInterest" | "killInterest">
   ) => Effect.Effect<Job, CapacityError | DuplicateJobError>;
   readonly restore: (job: Job) => Effect.Effect<Job, CapacityError>;
   readonly get: (id: string) => Effect.Effect<Job | undefined>;
   readonly list: (filter?: { kind?: JobKind; status?: JobStatus }) => Effect.Effect<ReadonlyArray<Job>>;
   readonly updateStatus: (id: string, status: JobStatus, patch?: Partial<Job>) => Effect.Effect<Job>;
   readonly onSettled: (listener: (job: Job) => void) => Effect.Effect<() => void>;
   readonly onChange: (listener: (jobs: ReadonlyArray<Job>) => void) => Effect.Effect<() => void>;
   readonly replaceAll: (jobs: ReadonlyArray<Job>) => Effect.Effect<void, CapacityError>;
   readonly clear: () => Effect.Effect<void>;
   readonly incrementWaitInterest: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
   readonly decrementWaitInterest: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
   readonly incrementKillInterest: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
   readonly decrementKillInterest: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
   readonly awaitSettlement: (ids: ReadonlyArray<string>, timeoutMs?: number) => Effect.Effect<ReadonlyArray<Job>>;
}

export class JobRegistry extends Context.Service<JobRegistry, JobRegistryShape>()("harbor/JobRegistry") {
   static readonly layer = Layer.effect(
      JobRegistry,
      Effect.gen(function* () {
         yield* Effect.void;
         const jobs = new Map<string, Job>();
         const waiters = new Map<string, Array<Deferred.Deferred<void>>>();
         const settledListeners = new Set<(job: Job) => void>();
         const changeListeners = new Set<(jobs: ReadonlyArray<Job>) => void>();

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
            const limit = HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs;
            const retained = pruneTerminalJobsForRetention(Array.from(jobs.values()), Date.now(), limit - 1);
            if (retained.length === jobs.size) return;

            const retainedIds = new Set(retained.map((job) => job.id));
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

         const register = Effect.fn("JobRegistry.register")(function* (jobInit) {
            prune();
            const limit = HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs;
            if (jobs.size >= limit) {
               return yield* new CapacityError({
                  message: `Job registry full. Maximum tracked jobs cap (${limit}) reached.`,
                  limit
               });
            }

            if (jobs.has(jobInit.id)) {
               return yield* new DuplicateJobError({
                  message: `Job ${jobInit.id} already exists in the registry.`,
                  id: jobInit.id
               });
            }

            const newJob: Job = {
               ...jobInit,
               status: "pending",
               createdAt: Date.now(),
               waitInterest: 0,
               killInterest: 0
            };

            jobs.set(newJob.id, newJob);
            notifyChange();
            return newJob;
         });

         const get = Effect.fn("JobRegistry.get")(function* (id: string) {
            yield* Effect.void;
            return jobs.get(id);
         });

         const list = Effect.fn("JobRegistry.list")(function* (filter?: { kind?: JobKind; status?: JobStatus }) {
            yield* Effect.void;
            let result = Array.from(jobs.values());
            if (filter?.kind) {
               result = result.filter((j) => j.kind === filter.kind);
            }
            if (filter?.status) {
               result = result.filter((j) => j.status === filter.status);
            }
            return result;
         });

         const notifyWaiters = (id: string) => {
            const deferreds = waiters.get(id);
            if (deferreds && deferreds.length > 0) {
               for (const d of deferreds) {
                  Effect.runFork(Deferred.succeed(d, undefined));
               }
               waiters.delete(id);
            }
         };

         const updateStatus = Effect.fn("JobRegistry.updateStatus")(function* (
            id: string,
            status: JobStatus,
            patch?: Partial<Job>
         ) {
            yield* Effect.void;
            const existing = jobs.get(id);
            if (!existing) {
               throw new Error(`Job not found: ${id}`);
            }

            const now = Date.now();
            const updated: Job = {
               ...existing,
               ...patch,
               status,
               startedAt: status === "running" ? (existing.startedAt ?? now) : existing.startedAt,
               settledAt:
                  status === "completed" || status === "failed" || status === "cancelled"
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
               (status === "completed" || status === "failed" || status === "cancelled") &&
               existing.status !== "completed" &&
               existing.status !== "failed" &&
               existing.status !== "cancelled";
            if (becameSettled) {
               for (const listener of settledListeners) {
                  try {
                     listener({ ...updated });
                  } catch {
                     // A delivery listener cannot break registry settlement.
                  }
               }
               notifyWaiters(id);
            }

            return updated;
         });

         const onSettled = Effect.fn("JobRegistry.onSettled")(function* (listener: (job: Job) => void) {
            yield* Effect.sync(() => settledListeners.add(listener));
            return () => settledListeners.delete(listener);
         });

         const onChange = Effect.fn("JobRegistry.onChange")(function* (listener: (jobs: ReadonlyArray<Job>) => void) {
            yield* Effect.sync(() => changeListeners.add(listener));
            return () => changeListeners.delete(listener);
         });

         const restore = Effect.fn("JobRegistry.restore")(function* (job: Job) {
            if (jobs.has(job.id)) {
               return jobs.get(job.id)!;
            }
            const limit = HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs;
            if (jobs.size >= limit) {
               return yield* new CapacityError({
                  message: `Job registry full. Maximum tracked jobs cap (${limit}) reached.`,
                  limit
               });
            }
            jobs.set(job.id, job);
            notifyChange();
            return job;
         });

         const releaseAllWaiters = () => {
            for (const [, deferreds] of waiters) {
               for (const d of deferreds) {
                  Effect.runFork(Deferred.succeed(d, undefined));
               }
            }
            waiters.clear();
         };

         const clear = Effect.fn("JobRegistry.clear")(() =>
            Effect.sync(() => {
               releaseAllWaiters();
               jobs.clear();
            })
         );

         const replaceAll = Effect.fn("JobRegistry.replaceAll")(function* (newJobs: ReadonlyArray<Job>) {
            const limit = HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs;
            if (newJobs.length > limit) {
               return yield* new CapacityError({
                  message: `Job registry full. Maximum tracked jobs cap (${limit}) reached.`,
                  limit
               });
            }

            releaseAllWaiters();
            jobs.clear();
            for (const job of newJobs) {
               jobs.set(job.id, job);
            }
            return yield* Effect.void;
         });

         const incrementWaitInterest = Effect.fn("JobRegistry.incrementWaitInterest")(function* (
            ids: ReadonlyArray<string>
         ) {
            yield* Effect.void;
            for (const id of ids) {
               const j = jobs.get(id);
               if (j) j.waitInterest++;
            }
         });

         const decrementWaitInterest = Effect.fn("JobRegistry.decrementWaitInterest")(function* (
            ids: ReadonlyArray<string>
         ) {
            yield* Effect.void;
            for (const id of ids) {
               const j = jobs.get(id);
               if (j && j.waitInterest > 0) j.waitInterest--;
            }
         });

         const incrementKillInterest = Effect.fn("JobRegistry.incrementKillInterest")(function* (
            ids: ReadonlyArray<string>
         ) {
            yield* Effect.void;
            for (const id of ids) {
               const j = jobs.get(id);
               if (j) j.killInterest++;
            }
         });

         const decrementKillInterest = Effect.fn("JobRegistry.decrementKillInterest")(function* (
            ids: ReadonlyArray<string>
         ) {
            yield* Effect.void;
            for (const id of ids) {
               const j = jobs.get(id);
               if (j && j.killInterest > 0) j.killInterest--;
            }
         });

         const isSettled = (job: Job) =>
            job.status === "completed" || job.status === "failed" || job.status === "cancelled";

         const awaitSettlement = Effect.fn("JobRegistry.awaitSettlement")(function* (
            ids: ReadonlyArray<string>,
            timeoutMs?: number
         ) {
            yield* incrementWaitInterest(ids);
            return yield* Effect.gen(function* () {
               let watched = ids.map((id) => jobs.get(id)).filter((j): j is Job => j !== undefined);
               if (watched.every(isSettled)) {
                  return watched;
               }

               const deferreds: Deferred.Deferred<void>[] = [];
               for (const id of ids) {
                  const j = jobs.get(id);
                  if (j && !isSettled(j)) {
                     const d = yield* Deferred.make<void>();
                     let waiterList = waiters.get(id);
                     if (!waiterList) {
                        waiterList = [];
                        waiters.set(id, waiterList);
                     }
                     waiterList.push(d);
                     deferreds.push(d);
                  }
               }

               watched = ids.map((id) => jobs.get(id)).filter((j): j is Job => j !== undefined);
               if (watched.every(isSettled)) {
                  return watched;
               }

               const awaitAll = Effect.all(
                  deferreds.map((d) => Deferred.await(d)),
                  { concurrency: "unbounded" }
               );

               if (timeoutMs !== undefined && timeoutMs > 0) {
                  yield* awaitAll.pipe(Effect.timeout(`${timeoutMs} millis`), Effect.ignore);
               } else {
                  yield* awaitAll;
               }

               return ids.map((id) => jobs.get(id)).filter((j): j is Job => j !== undefined);
            }).pipe(Effect.ensuring(decrementWaitInterest(ids)));
         });

         return JobRegistry.of({
            register,
            get,
            list,
            updateStatus,
            onSettled,
            onChange,
            restore,
            replaceAll,
            clear,
            incrementWaitInterest,
            decrementWaitInterest,
            incrementKillInterest,
            decrementKillInterest,
            awaitSettlement
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: JobRegistryShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | JobRegistry> {
      return Effect.gen(function* () {
         const svc = yield* JobRegistry;
         return yield* fn(svc);
      });
   }
}
