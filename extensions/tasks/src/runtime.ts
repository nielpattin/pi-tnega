/**
 * Layer composition and the async entry-point boundary.
 *
 * Everything inside the extension is Effect generators; this module is where
 * tool handlers (plain async functions) run those effects against one shared
 * ManagedRuntime.
 */

import { Cause, Exit, Layer, ManagedRuntime, type Effect } from "effect";
import { BackendRegistry, type TaskBackend } from "./backend.ts";
import { agyBackend } from "./backends/agy.ts";
import { piBackend } from "./backends/pi.ts";
import type { BackendName } from "./domain.ts";

const BackendRegistryLive = Layer.sync(BackendRegistry, () => {
   const backends: TaskBackend[] = [piBackend, agyBackend];
   return new Map<BackendName, TaskBackend>(backends.map((backend) => [backend.name, backend]));
});

import { TaskManagerLive } from "./manager.ts";

const AppLayer = TaskManagerLive.pipe(Layer.provide(BackendRegistryLive));

export function createTaskRuntime() {
   return ManagedRuntime.make(AppLayer);
}

export type TaskRuntime = ReturnType<typeof createTaskRuntime>;

/**
 * Run an effect from an async tool handler. Typed failures and defects are
 * converted to thrown Errors (what pi's tool contract expects); interruption
 * (tool AbortSignal) throws `interruptMessage`.
 */
export async function runTool<A, E>(
   runtime: TaskRuntime,
   effect: Effect.Effect<A, E>,
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
