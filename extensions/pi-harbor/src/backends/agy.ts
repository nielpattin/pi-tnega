import { Context, Effect, Layer, Scope } from "effect";
import { ShellExecutor, type ShellExecutorShape } from "../services/ShellExecutor.js";
import { killTree } from "../utils/kill-tree.js";
import { pollAgyDb, type AcpRecord, type AcpDecodedEvent } from "../utils/acp-decoder.js";
import { CancelError, ControlError, type ControlMode } from "../domain.js";
import { spawn } from "node:child_process";
// Local alias — recent @types/node marks ChildProcess as a deprecated
// "error" type. Use the inferred spawn return type instead.
type ChildProcess = ReturnType<typeof spawn>;

export function buildAgyArgv(params: {
   agent?: string;
   model?: string;
   effort?: string;
   cwd?: string;
   conversationId?: string;
   logFilePath?: string;
   prompt: string;
}): string[] {
   const argv: string[] = [];
   if (params.agent && !params.conversationId) {
      argv.push("--agent", params.agent);
   }
   if (params.model) {
      argv.push("--model", params.model);
   }
   if (!params.model) {
      argv.push("--effort", params.effort ?? "medium");
   }
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
   agent?: string;
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

export interface CreateAgyFsmSessionOptions {
   id?: string;
   agent?: string;
   model?: string;
   effort?: string;
   cwd?: string;
   prompt: string;
   conversationId?: string;
   logFilePath?: string;
   readDb?: (conversationId: string, lastProcessedIndex: number) => Promise<AcpRecord[]>;
   onEvent?: (evt: AcpDecodedEvent) => void;
   onOutput?: (rawText: string) => void;
   /** Reads only log content appended since the previous call. */
   readLogChunk?: () => Promise<string>;
   logPollIntervalMs?: number;
   onSettled?: (result: AgyOneShotResult) => void;
   executor?: ShellExecutorShape;
   spawnProc?: (
      cmd: string,
      opts: { cwd?: string; env?: Record<string, string> },
      onClose: (code: number | null) => void,
      onData: (chunk: string) => void,
      onErrorData?: (chunk: string) => void
   ) => { pid?: number; kill: () => void };
}

export interface AgyFsmSession {
   readonly state: "idle" | "running" | "resumePending" | "chainingFollowUp" | "settled" | "cancelled";
   readonly conversationId?: string;
   readonly pendingFollowUps: ReadonlyArray<string>;
   readonly pendingSteerText?: string;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, ControlError>;
   readonly abort: () => Effect.Effect<void, CancelError>;
   readonly start: () => Effect.Effect<void>;
}

export function createAgyFsmSession(options: CreateAgyFsmSessionOptions): AgyFsmSession {
   let state: "idle" | "running" | "resumePending" | "chainingFollowUp" | "settled" | "cancelled" = "idle";
   let conversationId: string | undefined = options.conversationId;
   const pendingFollowUps: string[] = [];
   let pendingSteerText: string | undefined = undefined;
   let pendingSteerNoId: boolean = false;
   let activeProc: { pid?: number; kill: () => void } | null = null;
   let accumulatedStdout = "";
   let accumulatedStderr = "";
   let activeScope: Scope.Scope | null = null;
   let logPollTimer: ReturnType<typeof setInterval> | undefined;
   let processGeneration = 0;
   let actionChain: Promise<any> = Promise.resolve();

   const runSerial = <A>(fn: () => Promise<A> | A): Promise<A> => {
      const res = actionChain.then(fn, fn);
      actionChain = res.catch(() => {});
      return res;
   };

   const extractConversationId = (text: string): string | undefined => {
      const match = text.match(/Print mode: conversation=([a-zA-Z0-9_-]+)/);
      return match ? match[1] : undefined;
   };

   const stopLogPoller = () => {
      if (logPollTimer !== undefined) {
         clearInterval(logPollTimer);
         logPollTimer = undefined;
      }
   };

   const handleCompletedTurn = () => {
      if (state !== "running") return;
      stopLogPoller();
      const completedProc = activeProc;
      activeProc = null;

      const continuation = pendingSteerText ?? pendingFollowUps.shift();
      pendingSteerText = undefined;
      if (continuation && conversationId) {
         state = "chainingFollowUp";
         completedProc?.kill();
         void Effect.runPromise(Scope.make()).then((scope) => {
            activeScope = scope;
            state = "running";
            spawnStep(continuation, true);
         });
         return;
      }

      state = "settled";
      options.onSettled?.({
         status: "completed",
         finalText: accumulatedStdout.trim(),
         rawText: accumulatedStdout,
         exitCode: 0
      });
      completedProc?.kill();
   };

   const startLogPoller = () => {
      if (!options.readLogChunk || logPollTimer !== undefined) return;
      logPollTimer = setInterval(() => {
         void options.readLogChunk!()
            .then((text) => {
               if (!conversationId) {
                  const extracted = extractConversationId(text);
                  if (extracted) {
                     conversationId = extracted;
                     if (activeScope) startDbPoller(extracted, activeScope);
                  }
               }
               if (!conversationId) return;
               const completion = `Stream completed for ${conversationId}, clearing ResponsePending`;
               if (text.includes(completion)) void runSerial(handleCompletedTurn);
            })
            .catch(() => {});
      }, options.logPollIntervalMs ?? 200);
   };

   const acceptStdout = (chunk: string) => {
      accumulatedStdout += chunk;
      options.onOutput?.(accumulatedStdout);
   };

   const startDbPoller = (convId: string, scope: Scope.Scope) => {
      if (!options.readDb || !options.onEvent) return;
      Effect.runPromise(
         Scope.provide(
            pollAgyDb({
               conversationId: convId,
               readDb: options.readDb,
               onEvent: options.onEvent,
               intervalMs: 200
            }),
            scope
         )
      ).catch(() => {});
   };

   const spawnStep = (promptText: string, isContinuation: boolean) => {
      if (isContinuation) {
         accumulatedStdout = "";
         accumulatedStderr = "";
      }
      const generation = ++processGeneration;
      startLogPoller();
      const argv = buildAgyArgv({
         agent: options.agent,
         model: options.model,
         effort: options.effort,
         cwd: options.cwd,
         conversationId,
         logFilePath: options.logFilePath,
         prompt: promptText
      });
      const escapedArgv = argv.map((a) => (a.includes(" ") ? `"${a}"` : a));
      const commandString = `agy ${escapedArgv.join(" ")}`;

      if (options.spawnProc) {
         const proc = options.spawnProc(
            commandString,
            { cwd: options.cwd, env: { HARBOR_CHILD_SESSION: "1" } },
            (code) => {
               if (generation === processGeneration) void runSerial(() => handleProcessClose(code));
            },
            (chunk) => {
               acceptStdout(chunk);
               if (!conversationId) {
                  const extracted = extractConversationId(chunk);
                  if (extracted) {
                     conversationId = extracted;
                     startLogPoller();
                     if (activeScope) {
                        startDbPoller(extracted, activeScope);
                     }
                     if (pendingSteerNoId && state === "running") {
                        pendingSteerNoId = false;
                        state = "resumePending";
                        if (activeProc) {
                           activeProc.kill();
                        }
                     }
                  }
               }
            },
            (chunk) => {
               accumulatedStderr += chunk;
            }
         );
         activeProc = proc;
      } else if (options.executor) {
         const spawnEff = options.executor.spawnProcess("agy", {
            cwd: options.cwd,
            env: { HARBOR_CHILD_SESSION: "1" },
            args: argv
         });
         void Effect.runPromise(spawnEff).then(
            (child: ChildProcess) => {
               activeProc = {
                  pid: child.pid,
                  kill: () => {
                     killTree(child, "SIGTERM");
                  }
               };
               child.stdout?.on("data", (chunk: Buffer | string) => {
                  const str = chunk.toString("utf8");
                  acceptStdout(str);
                  if (!conversationId) {
                     const extracted = extractConversationId(str);
                     if (extracted) {
                        conversationId = extracted;
                        startLogPoller();
                        if (activeScope) {
                           startDbPoller(extracted, activeScope);
                        }
                        if (pendingSteerNoId && state === "running") {
                           pendingSteerNoId = false;
                           state = "resumePending";
                           if (activeProc) {
                              activeProc.kill();
                           }
                        }
                     }
                  }
               });
               child.stderr?.on("data", (chunk: Buffer | string) => {
                  accumulatedStderr += chunk.toString("utf8");
               });
               child.once("close", (code: number | null) => {
                  if (generation === processGeneration) void runSerial(() => handleProcessClose(code));
               });
            },
            () => {
               // Spawn failure
               void runSerial(() => {
                  state = "settled";
                  pendingFollowUps.length = 0;
                  pendingSteerText = undefined;
                  options.onSettled?.({
                     status: "failed",
                     errorText: "Failed to spawn agy process"
                  });
               });
            }
         );
      }
   };

   const handleProcessClose = (code: number | null) => {
      if (state === "cancelled" || state === "settled") return;
      stopLogPoller();

      if (activeScope) {
         void Effect.runPromise(Scope.close(activeScope, undefined as any)).catch(() => {});
         activeScope = null;
      }
      activeProc = null;

      if (state === "resumePending") {
         if (conversationId && pendingSteerText) {
            const steerPrompt = pendingSteerText;
            pendingSteerText = undefined;
            state = "running";
            void Effect.runPromise(Scope.make()).then((scope) => {
               activeScope = scope;
               spawnStep(steerPrompt, true);
            });
         } else if (!conversationId) {
            state = "settled";
            pendingFollowUps.length = 0;
            pendingSteerText = undefined;
            options.onSettled?.({
               status: "failed",
               errorText: "Steer failed because conversationId was never captured.",
               partialText: accumulatedStdout.trim()
            });
         }
         return;
      }

      if (code === 0) {
         if (pendingSteerText) {
            const steerPrompt = pendingSteerText;
            pendingSteerText = undefined;
            pendingFollowUps.length = 0;
            state = "running";
            void Effect.runPromise(Scope.make()).then((scope) => {
               activeScope = scope;
               spawnStep(steerPrompt, true);
            });
            return;
         }

         if (pendingFollowUps.length > 0) {
            const nextPrompt = pendingFollowUps.shift()!;
            state = "running";
            void Effect.runPromise(Scope.make()).then((scope) => {
               activeScope = scope;
               spawnStep(nextPrompt, true);
            });
            return;
         }

         state = "settled";
         options.onSettled?.({
            status: "completed",
            finalText: accumulatedStdout.trim(),
            rawText: accumulatedStdout,
            exitCode: 0
         });
      } else {
         pendingFollowUps.length = 0;
         pendingSteerText = undefined;
         state = "settled";
         options.onSettled?.({
            status: "failed",
            errorText: accumulatedStderr.trim() || `Process exited with code ${code}`,
            partialText: accumulatedStdout.trim(),
            rawText: accumulatedStdout,
            exitCode: code ?? undefined
         });
      }
   };

   const start = () =>
      Effect.promise(() =>
         runSerial(async () => {
            state = "running";
            activeScope = await Effect.runPromise(Scope.make());
            spawnStep(options.prompt, false);
         })
      ).pipe(Effect.asVoid);

   const control = (text: string, mode: ControlMode) =>
      Effect.gen(function* () {
         yield* Effect.void;
         return yield* Effect.promise(() =>
            runSerial(() => {
               if (state === "cancelled") {
                  throw new ControlError({ message: `Session is ${state}` });
               }

               if (state === "settled") {
                  if (!conversationId) {
                     throw new ControlError({ message: "Settled session has no conversation ID to resume" });
                  }
                  accumulatedStdout = "";
                  accumulatedStderr = "";
                  state = "running";
                  void Effect.runPromise(Scope.make()).then((scope) => {
                     activeScope = scope;
                     spawnStep(text, true);
                  });
                  return;
               }

               if (mode === "followUp") {
                  if (state === "running" || state === "resumePending" || state === "chainingFollowUp") {
                     pendingFollowUps.push(text);
                  }
               } else if (mode === "steer") {
                  stopLogPoller();
                  pendingFollowUps.length = 0; // Clear follow-ups per Rule 9 & 10
                  pendingSteerText = text;

                  if (state === "running") {
                     if (conversationId) {
                        state = "resumePending";
                        if (activeProc) {
                           activeProc.kill();
                        }
                     } else {
                        pendingSteerNoId = true;
                     }
                  } else if (state === "chainingFollowUp") {
                     state = "resumePending";
                  }
               }
            })
         );
      });

   const abort = () =>
      Effect.gen(function* () {
         yield* Effect.void;
         return yield* Effect.promise(() =>
            runSerial(() => {
               stopLogPoller();
               pendingFollowUps.length = 0;
               pendingSteerText = undefined;
               state = "cancelled";
               if (activeProc) {
                  activeProc.kill();
               }
               if (activeScope) {
                  void Effect.runPromise(Scope.close(activeScope, undefined as any)).catch(() => {});
                  activeScope = null;
               }
               options.onSettled?.({
                  status: "cancelled",
                  errorText: "Operation was cancelled by user"
               });
            })
         );
      });

   return {
      get state() {
         return state;
      },
      get conversationId() {
         return conversationId;
      },
      get pendingFollowUps() {
         return [...pendingFollowUps];
      },
      get pendingSteerText() {
         return pendingSteerText;
      },
      start,
      control,
      abort
   };
}

export interface AgyBackendShape {
   readonly runOneShot: (params: AgyOneShotParams) => Effect.Effect<AgyOneShotResult, Error>;
   readonly createFsmSession: (options: CreateAgyFsmSessionOptions) => AgyFsmSession;
}

export class AgyBackend extends Context.Service<AgyBackend, AgyBackendShape>()("harbor/AgyBackend") {
   static readonly layer = Layer.effect(
      AgyBackend,
      Effect.gen(function* () {
         const executor = yield* ShellExecutor;

         const runOneShot = Effect.fn("AgyBackend.runOneShot")(function* (params) {
            const argv = params.overrideCommand ? undefined : buildAgyArgv(params);
            let commandString: string;
            if (params.overrideCommand) {
               commandString = params.overrideCommand;
            } else {
               const escapedArgv = argv!.map((a) => (a.includes(" ") ? `"${a}"` : a));
               commandString = `agy ${escapedArgv.join(" ")}`;
            }

            const child = yield* executor.spawnProcess(params.overrideCommand ? commandString : "agy", {
               cwd: params.cwd,
               env: { HARBOR_CHILD_SESSION: "1" },
               ...(params.overrideCommand
                  ? { shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : undefined }
                  : { args: argv! })
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

         const createFsmSession = (options: CreateAgyFsmSessionOptions) =>
            createAgyFsmSession({ ...options, executor });

         return AgyBackend.of({
            runOneShot,
            createFsmSession
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
