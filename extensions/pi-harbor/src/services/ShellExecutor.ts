import { createLocalBashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
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
         shell?: string;
         args?: readonly string[];
         stdin?: boolean;
      }
   ) => Effect.Effect<ChildProcess, Error>;

   readonly execSync: (
      command: string,
      options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }
   ) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, Error>;
}

export class ShellExecutor extends Context.Service<ShellExecutor, ShellExecutorShape>()("harbor/ShellExecutor") {
   static readonly layer = Layer.effect(
      ShellExecutor,
      Effect.sync(() => {
         const spawnProcess = Effect.fn("ShellExecutor.spawnProcess")(function* (command, options) {
            const directArgs = options?.args;
            const requestedShell = options?.shell;
            const shellConfig =
               directArgs === undefined
                  ? yield* Effect.try({
                       try: () =>
                          process.platform === "win32" &&
                          requestedShell !== undefined &&
                          /(?:^|[\\/])cmd(?:\.exe)?$/i.test(requestedShell)
                             ? { shell: requestedShell, args: ["/d", "/s", "/c"], commandTransport: "argv" as const }
                             : getShellConfig(requestedShell),
                       catch: (error) => (error instanceof Error ? error : new Error(String(error)))
                    })
                  : undefined;
            const env =
               directArgs === undefined
                  ? buildChildEnv({ ...process.env, ...options?.env }, shellConfig!.shell)
                  : { ...process.env, ...options?.env };
            const commandTransport = directArgs === undefined ? (shellConfig!.commandTransport ?? "argv") : "argv";
            const stdio: ("pipe" | "ignore")[] =
               commandTransport === "stdin" || options?.stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];

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
                  spawnedChild = spawn(
                     shellConfig?.shell ?? command,
                     directArgs ?? (commandTransport === "stdin" ? shellConfig!.args : [...shellConfig!.args, command]),
                     {
                        cwd: options?.cwd ?? process.cwd(),
                        env,
                        stdio,
                        windowsHide: true
                     }
                  );
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

            if (commandTransport === "stdin") {
               child.stdin?.end(command);
            }

            return child;
         });

         const bashOperations = createLocalBashOperations();
         const execSync = Effect.fn("ShellExecutor.execSync")(function* (command, options) {
            const cwd = options?.cwd ?? process.cwd();
            const timeout =
               options?.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs / 1000 : undefined;
            const env = options?.env ? { ...process.env, ...options.env } : undefined;

            return yield* Effect.callback<{ stdout: string; stderr: string; exitCode: number }, Error>((resume) => {
               const controller = new AbortController();
               const chunks: Buffer[] = [];
               let cleanedUp = false;
               const cleanup = () => {
                  if (cleanedUp) return;
                  cleanedUp = true;
                  options?.signal?.removeEventListener("abort", abortCaller);
               };
               const abortCaller = () => controller.abort();
               if (options?.signal) {
                  options.signal.addEventListener("abort", abortCaller, { once: true });
                  if (options.signal.aborted) abortCaller();
               }

               void bashOperations
                  .exec(command, cwd, {
                     onData: (data) => chunks.push(data),
                     signal: controller.signal,
                     timeout,
                     env
                  })
                  .then(
                     (result) => {
                        cleanup();
                        resume(
                           Effect.succeed({
                              stdout: Buffer.concat(chunks).toString("utf8"),
                              stderr: "",
                              exitCode: result.exitCode ?? 1
                           })
                        );
                     },
                     (error: unknown) => {
                        cleanup();
                        resume(Effect.fail(error instanceof Error ? error : new Error(String(error))));
                     }
                  );

               return Effect.sync(() => {
                  cleanup();
                  controller.abort();
               });
            });
         });

         return ShellExecutor.of({
            spawnProcess,
            execSync
         });
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
