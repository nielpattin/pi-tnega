import { Context, Deferred, Effect, Layer } from "effect";
import { deriveChildSessionDirectory } from "../shared/child-session-dir.ts";
import { TaskRegistry } from "./task-registry.js";
import { AgentManager } from "./agent-manager.js";
import { ParentSessionActivationError } from "../domain.js";
import { AgentsTaskPersistence, markInterruptedTaskFailed, createRegistryChangeWriter } from "./task-persistence.js";
import type { Task } from "../domain.js";

export type ParentSessionGateState = "idle" | "activating" | "ready" | "failed";

export interface ParentSessionGateShape {
   readonly markBusy: (parentSessionFile?: string | null) => Effect.Effect<void>;
   readonly markReady: () => Effect.Effect<void>;
   readonly markFailed: (error: unknown, parentSessionFile?: string | null) => Effect.Effect<void>;
   readonly awaitReady: (parentSessionFile?: string | null) => Effect.Effect<void, ParentSessionActivationError>;
   readonly stateFor: (parentSessionFile?: string | null) => Effect.Effect<ParentSessionGateState>;
   readonly runExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class ParentSessionGate extends Context.Service<ParentSessionGate, ParentSessionGateShape>()(
   "agents/ParentSessionGate"
) {
   static readonly layer = Layer.effect(
      ParentSessionGate,
      Effect.sync(() => {
         let currentParent: string | undefined;
         let hasActivated = false;
         let state:
            | { readonly status: "ready" }
            | {
                 readonly status: "activating";
                 readonly deferred: Deferred.Deferred<void, ParentSessionActivationError>;
              }
            | { readonly status: "failed"; readonly error: ParentSessionActivationError } = { status: "ready" };

         const normalize = (parentSessionFile: string | null | undefined): string | undefined =>
            parentSessionFile || undefined;
         const makeFailure = (error: unknown, parentSessionFile?: string | null) => {
            if (error instanceof ParentSessionActivationError) return error;
            const message =
               typeof error === "string"
                  ? error
                  : error instanceof Error
                    ? error.message
                    : "Agents parent session activation failed";
            return new ParentSessionActivationError({
               message,
               parentSessionFile: normalize(parentSessionFile) ?? currentParent,
               cause: error
            });
         };

         const markBusy = Effect.fn("ParentSessionGate.markBusy")(function* (parentSessionFile) {
            const target = normalize(parentSessionFile);
            if (target === currentParent && (state.status === "activating" || state.status === "ready")) return;
            currentParent = target;
            const deferred = yield* Deferred.make<void, ParentSessionActivationError>();
            state = { status: "activating", deferred };
         });
         const markReady = Effect.fn("ParentSessionGate.markReady")(function* () {
            if (state.status === "activating") yield* Deferred.succeed(state.deferred, undefined);
            hasActivated = true;
            state = { status: "ready" };
         });
         const markFailed = Effect.fn("ParentSessionGate.markFailed")(function* (error, parentSessionFile) {
            const failure = makeFailure(error, parentSessionFile);
            if (state.status === "activating") yield* Deferred.fail(state.deferred, failure);
            state = { status: "failed", error: failure };
         });
         const awaitReady = Effect.fn("ParentSessionGate.awaitReady")(function* (parentSessionFile) {
            const target = normalize(parentSessionFile) ?? currentParent;
            if (target !== currentParent) {
               return yield* Effect.fail(
                  new ParentSessionActivationError({
                     message: "Agents parent session mismatch: target changed during activation.",
                     parentSessionFile: target
                  })
               );
            }
            if (state.status === "ready") return yield* Effect.void;
            if (state.status === "failed") return yield* Effect.fail(state.error);
            return yield* Deferred.await(state.deferred);
         });
         const stateFor = Effect.fn("ParentSessionGate.stateFor")((parentSessionFile) =>
            Effect.sync(() => {
               const target = normalize(parentSessionFile);
               if (target !== currentParent || !hasActivated) return "idle" as const;
               return state.status;
            })
         );

         let lock = Promise.resolve<void>(undefined);
         const runExclusive = Effect.fn("ParentSessionGate.runExclusive")(function* <A, E, R>(
            effect: Effect.Effect<A, E, R>
         ) {
            const previous = lock;
            let release!: () => void;
            lock = new Promise<void>((resolve) => {
               release = resolve;
            });
            yield* Effect.promise(() => previous).pipe(Effect.ignore);
            return yield* effect.pipe(Effect.ensuring(Effect.sync(() => release())));
         });

         return ParentSessionGate.of({ markBusy, markReady, markFailed, awaitReady, stateFor, runExclusive });
      })
   );
}

/**
 * Serialized parent-session activation.
 *
 * This is the single place where Agents moves from one parent session to
 * another. It is responsible for:
 * - disabling/unsubscribing the previous persistence listener and flushing it
 * - clearing session-scoped extension state (handled by the caller)
 * - replacing the TaskRegistry atomically with the loaded manifest
 * - persisting the loaded manifest once
 * - enabling exactly one change listener for the new session
 *
 * Concurrent calls are serialized through ParentSessionGate.runExclusive.
 */
export const activateParentSession = Effect.fn("activateParentSession")(function* (
   parentSessionFile: string | undefined | null
) {
   const persistence = yield* AgentsTaskPersistence;
   const registry = yield* TaskRegistry;
   const agentManager = yield* AgentManager;
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
         const previousWriter = yield* persistence.takeChangeWriter();
         if (previousWriter) {
            yield* Effect.promise(() => previousWriter.flush());
         }
         yield* flushPendingWrites();

         // Stop agent sessions and live-output state owned by the previous
         // parent before replacing the registry. Late callbacks must not update
         // the new or ephemeral parent registry.
         yield* agentManager.cancelActiveSessions;

         // 3. Configure the new persistence target (explicitly clears when undefined).
         yield* persistence.configure(parentSessionFile);

         // 4. Load and validate the full index for the target session.
         const index = yield* persistence.load();

         // 5. Build the replacement registry contents in memory.
         const restored: Task[] = [];
         for (const stored of index.jobs) {
            const isTerminal =
               stored.status === "completed" || stored.status === "failed" || stored.status === "cancelled";

            const task: Task = isTerminal ? stored : markInterruptedTaskFailed(stored);

            restored.push(task);
         }

         // 6. Atomic replace: no per-Task onChange notifications, no partial persistence.
         yield* registry.replaceAll(restored);
         // 8. Persist the loaded manifest once, but do not recreate a missing/corrupt file as empty.
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
                  yield* Effect.ignore(agentManager.cancelActiveSessions);
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
                                     : "Agents parent session activation failed",
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

/**
 * Safe first-agent/session-file readiness refresh.
 * Refreshes readiness when the parent session file has become available or
 * changed since the last activation. This covers Pi's lazy parent session file
 * (e.g. in-memory sessions or sessions not yet flushed) without ever leaving
 * the previous parent's persistence target active when the file is absent.
 */
export const ensureParentSessionReady = Effect.fn("ensureParentSessionReady")(function* (
   parentSessionFile: string | undefined | null
) {
   const persistence = yield* AgentsTaskPersistence;
   const gate = yield* ParentSessionGate;

   const currentTarget = yield* persistence.currentTarget();
   const gateState = yield* gate.stateFor(parentSessionFile);

   // Invalid and lazy parent paths intentionally use an ephemeral parent. Once
   // activation has established that disabled state, keep readiness stable so
   // agent jobs can both spawn without reactivating and clearing each
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
   const persistence = yield* AgentsTaskPersistence;
   const writer = yield* persistence.takeChangeWriter();
   if (writer) {
      yield* Effect.promise(() => writer.flush());
      yield* persistence.setChangeWriter(writer);
   }
   yield* persistence.flush().pipe(
      Effect.catch((error) =>
         Effect.sync(() => {
            try {
               console.error(`[agents] failed to flush pending writes: ${error.message}`);
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
export const startTaskPersistenceListener = Effect.fn("startTaskPersistenceListener")(function* () {
   const persistence = yield* AgentsTaskPersistence;
   const registry = yield* TaskRegistry;

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
