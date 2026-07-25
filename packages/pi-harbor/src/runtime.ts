import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { JobRegistry } from "./services/JobRegistry.js";
import { ShellExecutor } from "./services/ShellExecutor.js";
import { ProcessSupervisor } from "./services/ProcessSupervisor.js";
import { TaskManager } from "./services/TaskManager.js";
import { SchemaValidator } from "./services/SchemaValidator.js";
import { AgentsStore } from "./services/AgentsStore.js";
import { MailBus } from "./services/MailBus.js";
import { VibeState } from "./services/VibeState.js";
import { AgyBackend } from "./backends/agy.js";
import { PiBackend } from "./backends/pi.js";

const ProcessSupervisorLive = ProcessSupervisor.layer.pipe(Layer.provide(ShellExecutor.layer));
const TaskManagerLive = TaskManager.layer.pipe(Layer.provide(JobRegistry.layer));
const AgyBackendLive = AgyBackend.layer.pipe(Layer.provide(ShellExecutor.layer));

export const HarborLive = Layer.mergeAll(
   JobRegistry.layer,
   ShellExecutor.layer,
   SchemaValidator.layer,
   AgentsStore.layer,
   ProcessSupervisorLive,
   TaskManagerLive,
   AgyBackendLive,
   PiBackend.layer,
   MailBus.layer,
   VibeState.layer
);

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
