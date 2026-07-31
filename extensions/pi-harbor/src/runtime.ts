import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { JobRegistry } from "./services/JobRegistry.js";
import { ShellExecutor } from "./services/ShellExecutor.js";
import { ProcessSupervisor } from "./services/ProcessSupervisor.js";
import { TaskManager } from "./services/TaskManager.js";
import { SchemaValidator } from "./services/SchemaValidator.js";
import { AgentsStore } from "./services/AgentsStore.js";
import { MailBus } from "./services/MailBus.js";
import { VibeState } from "./services/VibeState.js";
import { ParentSessionGate } from "./services/ParentSessionGate.js";
import { AgyBackend } from "./backends/agy.js";
import { PiBackend } from "./backends/pi.js";
import { HarborJobPersistence } from "./services/HarborJobPersistence.js";

// Shared base of stateful leaf services. provideMerge below feeds this same
// instance set into every dependent layer's construction context (not just
// its declared Layer.effect requirements) so that Effect.serviceOption calls
// inside TaskManager/AgyBackend/etc. resolve to the live singletons instead
// of silently seeing None — Layer.mergeAll alone builds sibling layers in
// isolation and does not share context between them.
const Base = Layer.mergeAll(
   JobRegistry.layer,
   ShellExecutor.layer,
   SchemaValidator.layer,
   AgentsStore.layer,
   MailBus.layer,
   VibeState.layer,
   ParentSessionGate.layer,
   HarborJobPersistence.layer
);

const AgyLive = AgyBackend.layer.pipe(Layer.provideMerge(Base));
const PiLive = PiBackend.layer.pipe(Layer.provideMerge(Base));

// TaskManager discovers backends during layer construction. Supply both in
// that construction context so recorded harness provenance always matches the
// backend that actually executes the job.
const TaskManagerLive = TaskManager.layer.pipe(Layer.provideMerge(Layer.mergeAll(Base, AgyLive, PiLive)));

const WithDependents = Layer.mergeAll(
   TaskManagerLive,
   ProcessSupervisor.layer.pipe(Layer.provideMerge(Base)),
   PiLive,
   AgyLive,
   Base
);

export const HarborLive = WithDependents;

export function makeHarborRuntime() {
   return ManagedRuntime.make(HarborLive);
}

export async function runTool<A, E>(
   runtime: ReturnType<typeof makeHarborRuntime>,
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
