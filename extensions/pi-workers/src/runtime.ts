import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { JobRegistry } from "./services/JobRegistry.js";
import { ShellExecutor } from "./services/ShellExecutor.js";
import { ProcessSupervisor } from "./services/ProcessSupervisor.js";
import { WorkerManager } from "./services/WorkerManager.js";
import { SchemaValidator } from "./services/SchemaValidator.js";
import { AgentsStore } from "./services/AgentsStore.js";
import { ParentSessionGate } from "./services/ParentSessionGate.js";
import { AgyBackend } from "./backends/agy.js";
import { PiBackend } from "./backends/pi.js";
import { WorkersJobPersistence } from "./services/WorkersJobPersistence.js";

// Shared base of stateful leaf services. provideMerge below feeds this same
// instance set into every dependent layer's construction context (not just
// its declared Layer.effect requirements) so that Effect.serviceOption calls
// inside WorkerManager/AgyBackend/etc. resolve to the live singletons instead
// of silently seeing None — Layer.mergeAll alone builds sibling layers in
// isolation and does not share context between them.
const Base = Layer.mergeAll(
   JobRegistry.layer,
   ShellExecutor.layer,
   SchemaValidator.layer,
   AgentsStore.layer,
   ParentSessionGate.layer,
   WorkersJobPersistence.layer
);

const AgyLive = AgyBackend.layer.pipe(Layer.provideMerge(Base));
const PiLive = PiBackend.layer.pipe(Layer.provideMerge(Base));

// WorkerManager discovers backends during layer construction. Supply both in
// that construction context so recorded harness provenance always matches the
// backend that actually executes the job.
const WorkerManagerLive = WorkerManager.layer.pipe(Layer.provideMerge(Layer.mergeAll(Base, AgyLive, PiLive)));

const WithDependents = Layer.mergeAll(
   WorkerManagerLive,
   ProcessSupervisor.layer.pipe(Layer.provideMerge(Base)),
   PiLive,
   AgyLive,
   Base
);

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
