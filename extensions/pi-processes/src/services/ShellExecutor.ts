import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { spawn } from "node:child_process";
// Local alias — recent @types/node marks ChildProcess as a deprecated
// "error" type. Use the inferred spawn return type instead.
type ChildProcess = ReturnType<typeof spawn>;
import { buildChildEnv } from "../utils/shell-env.js";

export interface ShellExecutorShape {
   readonly spawnProcess: (
      command: string,
      options?: {
         cwd?: string;
         env?: Record<string, string>;
      }
   ) => Effect.Effect<ChildProcess, Error>;
}

export class ShellExecutor extends Context.Service<ShellExecutor, ShellExecutorShape>()("processes/ShellExecutor") {
   static readonly layer = Layer.effect(
      ShellExecutor,
      Effect.sync(() => {
         const spawnProcess = Effect.fn("ShellExecutor.spawnProcess")(function* (command, options) {
            const shellConfig = yield* Effect.try({
               try: () => getShellConfig(),
               catch: (error) => (error instanceof Error ? error : new Error(String(error)))
            });
            const env = buildChildEnv({ ...process.env, ...options?.env }, shellConfig.shell);
            const stdio: ("pipe" | "ignore")[] = ["ignore", "pipe", "pipe"];

            const child = yield* Effect.callback<ChildProcess, Error>((resume) => {
               let spawnedChild: ChildProcess | undefined;
               let settled = false;
               const cleanup = () => {
                  spawnedChild?.removeListener("spawn", onSpawn);
                  spawnedChild?.removeListener("error", onError);
               };
               const onSpawn = () => {
                  if (settled || !spawnedChild) return;
                  settled = true;
                  cleanup();
                  resume(Effect.succeed(spawnedChild));
               };
               const onError = (error: Error) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  resume(Effect.fail(error));
               };

               try {
                  spawnedChild = spawn(shellConfig.shell, [...shellConfig.args, command], {
                     cwd: options?.cwd ?? process.cwd(),
                     env,
                     stdio,
                     windowsHide: true
                  });
                  spawnedChild.once("spawn", onSpawn);
                  spawnedChild.once("error", onError);
               } catch (error) {
                  onError(error instanceof Error ? error : new Error(String(error)));
               }

               return Effect.sync(() => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  spawnedChild?.kill();
               });
            });

            return child;
         });

         return ShellExecutor.of({ spawnProcess });
      })
   );

   static override use<A, E, R>(
      fn: (svc: ShellExecutorShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | ShellExecutor> {
      return Effect.gen(function* () {
         const svc = yield* ShellExecutor;
         return yield* fn(svc);
      });
   }
}
