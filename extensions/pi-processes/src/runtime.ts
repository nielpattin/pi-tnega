import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ProcessSupervisor } from "./services/ProcessSupervisor.ts";
import { ShellExecutor } from "./services/ShellExecutor.ts";

/** Runtime layer containing process supervision services. */
export const ProcessesLive = ProcessSupervisor.layer.pipe(Layer.provideMerge(ShellExecutor.layer));

/** Create one managed process runtime for an extension registration. */
export function makeProcessesRuntime() {
   return ManagedRuntime.make(ProcessesLive);
}

/**
 * Run a process effect and translate Effect causes at the extension boundary.
 *
 * @param runtime - The managed process runtime.
 * @param effect - The process operation to execute.
 * @param options - Optional abort message.
 * @returns The successful operation value.
 */
export async function runProcessTool<A, E>(
   runtime: ReturnType<typeof makeProcessesRuntime>,
   effect: Effect.Effect<A, E, ProcessSupervisor | ShellExecutor>,
   options: { readonly signal?: AbortSignal; readonly interruptMessage?: string } = {}
): Promise<A> {
   const exit = await runtime.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined);
   if (Exit.isSuccess(exit)) return exit.value;
   if (Cause.hasInterruptsOnly(exit.cause)) {
      throw new Error(options.interruptMessage ?? "Operation was aborted.");
   }
   const [first] = Cause.prettyErrors(exit.cause);
   throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
