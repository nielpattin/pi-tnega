import { Context, Effect, Layer } from "effect";
import { spawn, exec, type ChildProcess } from "node:child_process";
import { buildChildEnv } from "../utils/shell-env.js";

export interface ShellExecutorShape {
   readonly spawnProcess: (
      command: string,
      options?: { cwd?: string; env?: Record<string, string>; shell?: string }
   ) => Effect.Effect<ChildProcess>;

   readonly execSync: (
      command: string,
      options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
   ) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }>;
}

export class ShellExecutor extends Context.Service<ShellExecutor, ShellExecutorShape>()("harbor/ShellExecutor") {
   static readonly layer = Layer.effect(
      ShellExecutor,
      Effect.sync(() => {
         const spawnProcess = Effect.fn("ShellExecutor.spawnProcess")(function* (command, options) {
            const shell = options?.shell ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
            const env = buildChildEnv({ ...process.env, ...options?.env }, shell);

            const child = yield* Effect.sync(() => {
               if (process.platform === "win32") {
                  return spawn("cmd.exe", ["/d", "/s", "/c", command], {
                     cwd: options?.cwd ?? process.cwd(),
                     env,
                     stdio: ["ignore", "pipe", "pipe"],
                     windowsHide: true
                  });
               }
               return spawn("/bin/sh", ["-c", command], {
                  cwd: options?.cwd ?? process.cwd(),
                  env,
                  stdio: ["ignore", "pipe", "pipe"]
               });
            });

            return child;
         });

         const execSync = Effect.fn("ShellExecutor.execSync")(function* (command, options) {
            const env = buildChildEnv(
               { ...process.env, ...options?.env },
               process.platform === "win32" ? "cmd.exe" : "/bin/sh"
            );

            return yield* Effect.callback<{ stdout: string; stderr: string; exitCode: number }>((resume) => {
               const proc = exec(
                  command,
                  {
                     cwd: options?.cwd ?? process.cwd(),
                     env,
                     timeout: options?.timeoutMs ?? 60000
                  },
                  (error, stdout, stderr) => {
                     const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
                     resume(Effect.succeed({ stdout: String(stdout), stderr: String(stderr), exitCode }));
                  }
               );
               return Effect.sync(() => {
                  try {
                     proc.kill();
                  } catch {
                     // ignore
                  }
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
