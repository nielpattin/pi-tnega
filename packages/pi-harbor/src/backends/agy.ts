import { Context, Effect, Layer } from "effect";
import { ShellExecutor } from "../services/ShellExecutor.js";
import { killTree } from "../utils/kill-tree.js";

export function buildAgyArgv(params: {
   model?: string;
   effort?: string;
   cwd?: string;
   conversationId?: string;
   logFilePath?: string;
   prompt: string;
}): string[] {
   const argv: string[] = [];
   if (params.model) {
      argv.push("--model", params.model);
   }
   argv.push("--effort", params.effort ?? "medium");
   argv.push("--mode", "accept-edits");
   argv.push("--dangerously-skip-permissions");
   if (params.cwd) {
      argv.push("--add-dir", params.cwd);
   }
   argv.push("--print-timeout", "15m");
   if (params.logFilePath) {
      argv.push("--log-file", params.logFilePath);
   }
   if (params.conversationId) {
      argv.push("--conversation", params.conversationId);
   }
   argv.push("--print", params.prompt);
   return argv;
}

export interface AgyOneShotParams {
   model?: string;
   effort?: string;
   cwd?: string;
   conversationId?: string;
   logFilePath?: string;
   prompt: string;
   overrideCommand?: string;
}

export interface AgyOneShotResult {
   status: "completed" | "failed" | "cancelled";
   finalText?: string;
   errorText?: string;
   partialText?: string;
   rawText?: string;
   exitCode?: number;
}

export interface AgyBackendShape {
   readonly runOneShot: (params: AgyOneShotParams) => Effect.Effect<AgyOneShotResult>;
}

export class AgyBackend extends Context.Service<AgyBackend, AgyBackendShape>()("harbor/AgyBackend") {
   static readonly layer = Layer.effect(
      AgyBackend,
      Effect.gen(function* () {
         const executor = yield* ShellExecutor;

         const runOneShot = Effect.fn("AgyBackend.runOneShot")(function* (params) {
            let commandString: string;
            if (params.overrideCommand) {
               commandString = params.overrideCommand;
            } else {
               const argv = buildAgyArgv(params);
               const escapedArgv = argv.map((a) => (a.includes(" ") ? `"${a}"` : a));
               commandString = `agy ${escapedArgv.join(" ")}`;
            }

            const child = yield* executor.spawnProcess(commandString, {
               cwd: params.cwd,
               env: { HARBOR_CHILD_SESSION: "1" }
            });

            let stdout = "";
            let stderr = "";

            child.stdout?.on("data", (chunk: Buffer | string) => {
               stdout += chunk.toString("utf8");
            });

            child.stderr?.on("data", (chunk: Buffer | string) => {
               stderr += chunk.toString("utf8");
            });

            return yield* Effect.callback<AgyOneShotResult>((resume) => {
               child.once("close", (code) => {
                  if (code === 0) {
                     resume(
                        Effect.succeed({
                           status: "completed",
                           finalText: stdout.trim(),
                           rawText: stdout,
                           exitCode: 0
                        })
                     );
                  } else {
                     resume(
                        Effect.succeed({
                           status: "failed",
                           errorText: stderr.trim() || `Process exited with code ${code}`,
                           partialText: stdout.trim(),
                           rawText: stdout,
                           exitCode: code ?? undefined
                        })
                     );
                  }
               });

               return Effect.sync(() => {
                  killTree(child, "SIGTERM");
               });
            });
         });

         return AgyBackend.of({
            runOneShot
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: AgyBackendShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | AgyBackend> {
      return Effect.gen(function* () {
         const svc = yield* AgyBackend;
         return yield* fn(svc);
      });
   }
}
