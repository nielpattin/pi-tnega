import { Effect, Option } from "effect";
import { deriveChildSessionDirectory } from "../utils/child-session-dir.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { WorkerManager } from "../services/WorkerManager.js";
import { ProcessSupervisor } from "../services/ProcessSupervisor.js";
import { ParentSessionGate } from "../services/ParentSessionGate.js";
import { ParentSessionActivationError } from "../domain.js";
import {
   WorkersJobPersistence,
   convertInterruptedJob,
   createRegistryChangeWriter,
   computeNextWorkerSeq
} from "../services/WorkersJobPersistence.js";
import type { Job } from "../domain.js";

/**
 * Serialized parent-session activation.
 *
 * This is the single place where Workers moves from one parent session to
 * another. It is responsible for:
 * - disabling/unsubscribing the previous persistence listener and flushing it
 * - clearing session-scoped extension state (handled by the caller)
 * - replacing the JobRegistry atomically with the recovered manifest
 * - reserving worker IDs from the validated full index
 * - persisting the recovered manifest once
 * - enabling exactly one change listener for the new session
 *
 * Concurrent calls are serialized through ParentSessionGate.runExclusive.
 */
export const activateParentSession = Effect.fn("activateParentSession")(function* (
   parentSessionFile: string | undefined | null
) {
   const persistence = yield* WorkersJobPersistence;
   const registry = yield* JobRegistry;
   const workerManager = yield* WorkerManager;
   const processSupervisorOpt = yield* Effect.serviceOption(ProcessSupervisor);
   const gate = yield* ParentSessionGate;

   return yield* gate.runExclusive(
      Effect.gen(function* () {
         const currentTarget = yield* persistence.currentTarget();
         const currentState = yield* gate.stateFor(parentSessionFile);
         const requestedTarget = parentSessionFile || undefined;
         if (currentState === "ready" && currentTarget === requestedTarget) {
            return;
         }

         yield* gate.markBusy(parentSessionFile);

         // 1. Disable/unsubscribe previous persistence listener.
         const previousUnsubscribe = yield* persistence.takeChangeListener();
         if (previousUnsubscribe) {
            yield* Effect.sync(() => previousUnsubscribe());
         }

         // 2. Flush any pending writes for the previous parent.
         if (Option.isSome(processSupervisorOpt)) {
            yield* processSupervisorOpt.value.disposeAll;
         }
         const previousWriter = yield* persistence.takeChangeWriter();
         if (previousWriter) {
            yield* Effect.promise(() => previousWriter.flush());
         }
         yield* flushPendingWrites();

         // Stop backend sessions and live-output state owned by the previous
         // parent before replacing the registry. Late callbacks must not update
         // the new or ephemeral parent registry.
         yield* workerManager.disposeAllSessions;

         // 3. Configure the new persistence target (explicitly clears when undefined).
         yield* persistence.configure(parentSessionFile);

         // 4. Load and validate the full index for the target session.
         const index = yield* persistence.load();

         // 5. Build the replacement registry contents in memory.
         const restored: Job[] = [];
         for (const stored of index.jobs) {
            // Older reloads could leave a completed Agy result marked cancelled:
            // session disposal aborted its still-retained continuation handle after the
            // result had already been persisted. A result without an error is the
            // durable evidence needed to repair that historical transition once.
            const repaired =
               stored.status === "cancelled" &&
               stored.harness === "agy" &&
               stored.errorText === undefined &&
               stored.resultData !== undefined
                  ? { ...stored, status: "completed" as const }
                  : stored;
            const isTerminal =
               repaired.status === "completed" || repaired.status === "failed" || repaired.status === "cancelled";

            const job: Job = isTerminal
               ? { ...repaired, waitInterest: 0, killInterest: 0 }
               : convertInterruptedJob(repaired);

            restored.push(job);
         }

         // 6. Atomic replace: no per-job onChange notifications, no partial persistence.
         yield* registry.replaceAll(restored);

         // 7. Reserve worker IDs from the validated full index.
         yield* workerManager.reserveWorkerSeq(index.reservedWorkerSeq ?? computeNextWorkerSeq(restored));

         // 8. Persist the recovered manifest once, but do not recreate a missing/corrupt file as empty.
         if (index.source !== "missing" || restored.length > 0) {
            yield* persistence.persist(restored);
         }

         // 9. Enable exactly one coalescing change listener for the new parent.
         const writer = createRegistryChangeWriter(persistence);
         const unsubscribeFromRegistry = yield* registry.onChange(writer.schedule);
         const unsubscribe = () => {
            unsubscribeFromRegistry();
            void writer.flush();
         };
         yield* persistence.setChangeListener(unsubscribe);
         yield* persistence.setChangeWriter(writer);

         yield* gate.markReady();
      }).pipe(
         Effect.matchEffect({
            onFailure: (error) =>
               Effect.gen(function* () {
                  // Disable any partially-configured target so a later retry starts clean
                  // rather than continuing to use the failed parent's jobs or persistence.
                  yield* Effect.ignore(persistence.configure(undefined));
                  yield* Effect.ignore(workerManager.disposeAllSessions);
                  yield* Effect.ignore(registry.clear());
                  yield* Effect.ignore(persistence.takeChangeListener());
                  yield* Effect.ignore(persistence.takeChangeWriter());

                  const failure =
                     error instanceof ParentSessionActivationError
                        ? error
                        : new ParentSessionActivationError({
                             message:
                                error instanceof Error
                                   ? error.message
                                   : typeof error === "string"
                                     ? error
                                     : "Workers parent session activation failed",
                             parentSessionFile: parentSessionFile || undefined,
                             cause: error
                          });

                  yield* gate.markFailed(failure, parentSessionFile);
                  return yield* Effect.fail(failure);
               }),
            onSuccess: () => Effect.void
         })
      )
   );
});

export const configureAndRecoverJobs = activateParentSession;

/**
 * Safe first-worker/session-file readiness refresh.
 *
 * Re-activates recovery when the parent session file has become available or
 * changed since the last activation. This covers Pi's lazy parent session file
 * (e.g. in-memory sessions or sessions not yet flushed) without ever leaving
 * the previous parent's persistence target active when the file is absent.
 */
export const ensureParentSessionRecovery = Effect.fn("ensureParentSessionRecovery")(function* (
   parentSessionFile: string | undefined | null
) {
   const persistence = yield* WorkersJobPersistence;
   const gate = yield* ParentSessionGate;

   const currentTarget = yield* persistence.currentTarget();
   const gateState = yield* gate.stateFor(parentSessionFile);

   // Invalid and lazy parent paths intentionally use an ephemeral parent. Once
   // activation has established that disabled state, keep readiness stable so
   // worker and btw can both spawn without reactivating and clearing each
   // other's in-memory jobs. A transition from a valid target still activates
   // because stateFor will report idle for the new parent.
   const disabledParent = deriveChildSessionDirectory(parentSessionFile) === undefined;
   if (
      (parentSessionFile === currentTarget || (disabledParent && currentTarget === undefined)) &&
      gateState === "ready"
   )
      return;
   if (gateState === "activating") {
      yield* gate.awaitReady(parentSessionFile);
      return;
   }

   yield* activateParentSession(parentSessionFile);
   yield* gate.awaitReady(parentSessionFile);
});

export const flushPendingWrites = Effect.fn("flushPendingWrites")(function* () {
   const persistence = yield* WorkersJobPersistence;
   const writer = yield* persistence.takeChangeWriter();
   if (writer) {
      yield* Effect.promise(() => writer.flush());
      yield* persistence.setChangeWriter(writer);
   }
   yield* persistence.flush().pipe(
      Effect.catch((error) =>
         Effect.sync(() => {
            try {
               console.error(`[workers] failed to flush pending writes: ${error.message}`);
            } catch {
               // ignore logging failure
            }
         })
      )
   );
});

/**
 * Standalone listener registration kept for callers that set up persistence
 * outside of activateParentSession. It ensures at most one listener is active
 * by storing/unsubscribing the previous one in the persistence service.
 */
export const startJobPersistenceListener = Effect.fn("startJobPersistenceListener")(function* () {
   const persistence = yield* WorkersJobPersistence;
   const registry = yield* JobRegistry;

   const previousUnsubscribe = yield* persistence.takeChangeListener();
   if (previousUnsubscribe) {
      yield* Effect.sync(() => previousUnsubscribe());
   }

   const previousWriter = yield* persistence.takeChangeWriter();
   if (previousWriter) {
      yield* Effect.promise(() => previousWriter.flush());
   }

   const writer = createRegistryChangeWriter(persistence);
   const unsubscribeFromRegistry = yield* registry.onChange(writer.schedule);
   const unsubscribe = () => {
      unsubscribeFromRegistry();
      void writer.flush();
   };
   yield* persistence.setChangeListener(unsubscribe);
   yield* persistence.setChangeWriter(writer);
});
