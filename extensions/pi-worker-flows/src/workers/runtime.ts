import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { JobRegistry } from "./services/job-registry.js";
import { WorkerManager } from "./services/worker-manager.js";
import { ParentSessionGate } from "./services/workers-job-recovery.js";
import { WorkersJobPersistence } from "./services/workers-job-persistence.js";

// Shared base of stateful leaf services. provideMerge below feeds this same
// instance set into every dependent layer's construction context (not just
// its declared Layer.effect requirements) so that Effect.serviceOption calls
// inside WorkerManager resolve to the live singletons instead
// of silently seeing None — Layer.mergeAll alone builds sibling layers in
// isolation and does not share context between them.
const Base = Layer.mergeAll(JobRegistry.layer, ParentSessionGate.layer, WorkersJobPersistence.layer);

const WorkerManagerLive = WorkerManager.layer.pipe(Layer.provideMerge(Base));

const WithDependents = Layer.mergeAll(WorkerManagerLive, Base);

export const WorkersLive = WithDependents;

export function makeWorkersRuntime() {
   return ManagedRuntime.make(WorkersLive);
}

export async function runTool<A, E>(
   runtime: ReturnType<typeof makeWorkersRuntime>,
   effect: Effect.Effect<A, E, any>,
   options: { signal?: AbortSignal; interruptMessage?: string } = {}
) {
   const exit = await runtime.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined);
   if (Exit.isSuccess(exit)) return exit.value;
   if (Cause.hasInterruptsOnly(exit.cause)) {
      throw new Error(options.interruptMessage ?? "Operation was aborted.");
   }
   const [first] = Cause.prettyErrors(exit.cause);
   throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
