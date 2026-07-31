import { Context, Deferred, Effect, Layer } from "effect";
import { ParentSessionActivationError } from "../domain.js";

export type ParentSessionGateState = "idle" | "activating" | "ready" | "failed";

export interface ParentSessionGateShape {
   /** Mark the gate busy for a specific parent session. Idempotent if already activating or ready for the same parent; resets to allow retry after a failure. */
   readonly markBusy: (parentSessionFile?: string | null) => Effect.Effect<void>;
   /** Mark the gate ready for the current parent after all activation steps succeed. */
   readonly markReady: () => Effect.Effect<void>;
   /** Mark the gate failed for the current parent and unblock any waiting callers with an actionable error. */
   readonly markFailed: (error: unknown, parentSessionFile?: string | null) => Effect.Effect<void>;
   /** Block until recovery for the requested parent session has completed, or fail if activation failed for that parent. */
   readonly awaitReady: (parentSessionFile?: string | null) => Effect.Effect<void, ParentSessionActivationError>;
   /** Return the gate state for the requested parent session. */
   readonly stateFor: (parentSessionFile?: string | null) => Effect.Effect<ParentSessionGateState>;
   /** Serialize an activation effect so only one runs at a time. */
   readonly runExclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class ParentSessionGate extends Context.Service<ParentSessionGate, ParentSessionGateShape>()(
   "harbor/ParentSessionGate"
) {
   static readonly layer = Layer.effect(
      ParentSessionGate,
      Effect.sync(() => {
         let currentParent: string | undefined;
         let state:
            | { readonly status: "ready" }
            | {
                 readonly status: "activating";
                 readonly deferred: Deferred.Deferred<void, ParentSessionActivationError>;
              }
            | { readonly status: "failed"; readonly error: ParentSessionActivationError } = { status: "ready" };

         const normalize = (parentSessionFile: string | null | undefined): string | undefined =>
            parentSessionFile || undefined;

         const makeFailure = (error: unknown, parentSessionFile?: string | null): ParentSessionActivationError => {
            if (error instanceof ParentSessionActivationError) return error;
            const message =
               typeof error === "string"
                  ? error
                  : error instanceof Error
                    ? error.message
                    : "Harbor parent session activation failed";
            return new ParentSessionActivationError({
               message,
               parentSessionFile: normalize(parentSessionFile) ?? currentParent,
               cause: error
            });
         };

         const markBusy = Effect.fn("ParentSessionGate.markBusy")(function* (parentSessionFile) {
            const target = normalize(parentSessionFile);
            if (target === currentParent && (state.status === "activating" || state.status === "ready")) {
               return;
            }
            currentParent = target;
            const deferred = yield* Deferred.make<void, ParentSessionActivationError>();
            state = { status: "activating", deferred };
         });

         const markReady = Effect.fn("ParentSessionGate.markReady")(function* () {
            if (state.status === "activating") {
               yield* Deferred.succeed(state.deferred, undefined);
            }
            state = { status: "ready" };
         });

         const markFailed = Effect.fn("ParentSessionGate.markFailed")(function* (error, parentSessionFile) {
            const failure = makeFailure(error, parentSessionFile);
            if (state.status === "activating") {
               yield* Deferred.fail(state.deferred, failure);
            }
            state = { status: "failed", error: failure };
         });

         const awaitReady = Effect.fn("ParentSessionGate.awaitReady")(function* (parentSessionFile) {
            // When no target is supplied, wait for whatever parent is currently active.
            const target = normalize(parentSessionFile) ?? currentParent;
            if (target !== currentParent) {
               return yield* Effect.fail(
                  new ParentSessionActivationError({
                     message: "Harbor parent session mismatch: recovery target changed during activation.",
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
               if (target !== currentParent) return "idle" as const;
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

            return yield* effect.pipe(
               Effect.ensuring(
                  Effect.sync(() => {
                     release();
                  })
               )
            );
         });

         return ParentSessionGate.of({ markBusy, markReady, markFailed, awaitReady, stateFor, runExclusive });
      })
   );
}
