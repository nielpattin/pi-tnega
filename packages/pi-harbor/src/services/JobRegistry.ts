import { Context, Effect, Layer, Deferred } from "effect";
import { CapacityError, type Job, type JobKind, type JobStatus } from "../domain.js";

export const MAX_TRACKED_JOBS = 64;

export interface JobRegistryShape {
   readonly register: (
      job: Omit<Job, "status" | "createdAt" | "waitInterest" | "killInterest">
   ) => Effect.Effect<Job, CapacityError>;
   readonly get: (id: string) => Effect.Effect<Job | undefined>;
   readonly list: (filter?: { kind?: JobKind; status?: JobStatus }) => Effect.Effect<ReadonlyArray<Job>>;
   readonly updateStatus: (id: string, status: JobStatus, patch?: Partial<Job>) => Effect.Effect<Job>;
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

         const prune = () => {
            if (jobs.size < MAX_TRACKED_JOBS) return;

            const candidates: Job[] = [];
            for (const job of jobs.values()) {
               if (job.status !== "running" && job.waitInterest === 0 && job.killInterest === 0) {
                  candidates.push(job);
               }
            }

            candidates.sort((a, b) => {
               const aTime = a.settledAt ?? a.createdAt;
               const bTime = b.settledAt ?? b.createdAt;
               if (aTime !== bTime) return aTime - bTime;
               return a.createdAt - b.createdAt;
            });

            while (jobs.size >= MAX_TRACKED_JOBS && candidates.length > 0) {
               const victim = candidates.shift();
               if (victim) {
                  jobs.delete(victim.id);
               }
            }
         };

         const register = Effect.fn("JobRegistry.register")(function* (jobInit) {
            prune();
            if (jobs.size >= MAX_TRACKED_JOBS) {
               return yield* new CapacityError({
                  message: `Job registry full. Maximum tracked jobs cap (${MAX_TRACKED_JOBS}) reached.`,
                  limit: MAX_TRACKED_JOBS
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
                     ? (existing.settledAt ?? now)
                     : existing.settledAt
            };

            jobs.set(id, updated);

            if (status === "completed" || status === "failed" || status === "cancelled") {
               notifyWaiters(id);
            }

            return updated;
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
