import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { TaskRegistry } from "./services/task-registry.js";
import { AgentManager } from "./services/agent-manager.js";
import { ParentSessionGate } from "./services/task-session.js";
import { AgentsTaskPersistence } from "./services/task-persistence.js";

// Shared base of stateful leaf services. provideMerge below feeds this same
// instance set into every dependent layer's construction context (not just
// its declared Layer.effect requirements) so that Effect.serviceOption calls
// inside AgentManager resolve to the live singletons instead
// of silently seeing None — Layer.mergeAll alone builds sibling layers in
// isolation and does not share context between them.
const Base = Layer.mergeAll(TaskRegistry.layer, ParentSessionGate.layer, AgentsTaskPersistence.layer);

const AgentManagerLive = AgentManager.layer.pipe(Layer.provideMerge(Base));

const WithDependents = Layer.mergeAll(AgentManagerLive, Base);

export const AgentsLive = WithDependents;

export function makeAgentsRuntime() {
   return ManagedRuntime.make(AgentsLive);
}

export async function runTool<A, E>(
   runtime: ReturnType<typeof makeAgentsRuntime>,
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
