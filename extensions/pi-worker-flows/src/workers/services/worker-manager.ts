import { Context, Effect, Layer, Option } from "effect";
import {
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   SessionManager,
   SettingsManager,
   type AgentSession
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { existsSync } from "node:fs";
import {
   CapacityError,
   ConcurrencyLimitError,
   DuplicateTaskError,
   WorkerProfileNotFoundError,
   ParentSessionActivationError,
   ControlError,
   formatTaskId,
   canRecoverTask,
   type Task,
   type WorkerSpec,
   type ControlMode
} from "../domain.js";
import { TaskRegistry } from "./task-registry.js";
import { ParentSessionGate } from "./workers-task-recovery.js";
import { createChildResources, getChildExtensionPathsForTools } from "../../shared/child-session.js";
import { ensureAutoCompactionEnabled } from "../../shared/compaction.ts";
import { buildWorkflowAgentPrompt, STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION } from "../../core/prompt.ts";
import { emptyUsage } from "../../core/model.ts";
import {
   DEFAULT_WORKFLOW_OUTPUT_SCHEMA,
   runAgent,
   type AgentOutcome,
   type AgentRunnerProfile,
   type AgentSessionMetadata,
   type WorkflowModel
} from "../../shared/worker-runner.ts";
import { resolveAgentProfile, type AgentProfile } from "../../services/worker-profiles.ts";
import type { InheritedModelIdentity, ProfileModelRegistry } from "../../services/model-resolution.ts";

export const MAX_RUNNING_AGENTS = 4;

export interface WorkerManagerSpawnOptions {
   ownerSessionId?: string;
   batchId?: string;
   batchSize?: number;
   modelRegistry?: ProfileModelRegistry<any>;
   inheritedModel?: InheritedModelIdentity;
   parentSessionFile?: string;
   background?: boolean;
}

export interface ActiveWorkerSession {
   readonly abort: () => Effect.Effect<void, any>;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, any>;
}

interface WorkerSessionControlTarget {
   readonly isStreaming: boolean;
   readonly steer: (text: string) => Promise<void> | void;
   readonly followUp: (text: string) => Promise<void> | void;
   readonly prompt: (text: string) => Promise<void> | void;
}

const routeWorkerControl = Effect.fn("WorkerManager.routeControl")(function* (
   session: WorkerSessionControlTarget,
   text: string,
   mode: ControlMode
) {
   return yield* Effect.tryPromise({
      try: async () => {
         if (session.isStreaming) {
            if (mode === "steer") await session.steer(text);
            else await session.followUp(text);
         } else {
            await session.prompt(text);
         }
      },
      catch: (error) =>
         new ControlError({
            message: error instanceof Error ? error.message : String(error)
         })
   });
});

interface SpawnWorkerSessionOptions {
   sessionName?: string;
   prompt: string;
   cwd?: string;
   signal?: AbortSignal;
   parentSessionFile?: string;
   agentDef?: Pick<AgentProfile, "name" | "systemPrompt" | "body" | "model" | "thinking" | "tools">;
   specThinking?: string;
   specTools?: readonly string[];
   modelRegistry?: ProfileModelRegistry<any>;
   inheritedModel?: InheritedModelIdentity;
   onSettled?: (
      status: "completed" | "failed" | "cancelled",
      data?: unknown,
      errorText?: string
   ) => void | Promise<void>;
   onOutput?: (text: string) => void;
   onSessionReady?: (metadata: AgentSessionMetadata) => Promise<void> | void;
   createSessionFn?: typeof createAgentSession;
   resourceLoader?: DefaultResourceLoader;
   /** Resume an existing persisted worker session instead of starting a new one. */
   resumeSessionFile?: string;
}

function profileForWorker(options: SpawnWorkerSessionOptions): AgentRunnerProfile | undefined {
   const agent = options.agentDef;
   if (!agent) return undefined;
   return {
      name: agent.name,
      tools: options.specTools ?? agent.tools,
      model: agent.model,
      thinking: (options.specThinking ?? agent.thinking) as AgentRunnerProfile["thinking"]
   };
}

function workerOutcomeError(error: unknown): AgentOutcome {
   return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
      aborted: false,
      usage: emptyUsage(),
      transcript: []
   };
}

async function awaitWorkerStartup<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
   if (!signal) return promise;
   if (signal.aborted) {
      promise.catch(() => {});
      throw new Error("Worker startup aborted");
   }

   return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
         if (settled) return;
         settled = true;
         cleanup();
         reject(new Error("Worker startup aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
         (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
         },
         (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
         }
      );
   });
}

async function spawnWorkerSession(options: SpawnWorkerSessionOptions) {
   const cwd = options.cwd ?? process.cwd();
   const agentDir = getAgentDir();
   const workerPrompt = options.agentDef?.systemPrompt || options.agentDef?.body;
   const appendSystemPrompt = [...(workerPrompt ? [workerPrompt] : []), STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION];
   const workerTools = options.specTools ?? options.agentDef?.tools ?? [];
   const additionalExtensionPaths = getChildExtensionPathsForTools(workerTools, agentDir);

   let loader: DefaultResourceLoader;
   let settingsManager: SettingsManager;
   if (options.resourceLoader) {
      loader = options.resourceLoader;
      settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      ensureAutoCompactionEnabled(settingsManager);
   } else {
      const resources = await awaitWorkerStartup(
         createChildResources({
            cwd,
            projectTrusted: true,
            agentDir,
            ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}),
            appendSystemPrompt
         }),
         options.signal
      );
      loader = resources.loader;
      settingsManager = resources.settingsManager;
   }

   const controller = new AbortController();
   const abortFromParent = () => controller.abort();
   if (options.signal?.aborted) controller.abort();
   else options.signal?.addEventListener("abort", abortFromParent, { once: true });

   const inheritedModel =
      options.modelRegistry && options.inheritedModel
         ? options.modelRegistry.find(options.inheritedModel.provider, options.inheritedModel.id)
         : undefined;
   let activeSession: AgentSession | undefined;
   let resolveSession: ((session: AgentSession) => void) | undefined;
   const sessionReady = new Promise<AgentSession>((resolve) => {
      resolveSession = resolve;
   });

   // Resume support: open the existing session file so the worker continues
   // with its full prior context instead of starting a fresh session.
   const createSessionFn =
      options.createSessionFn ??
      (options.resumeSessionFile
         ? (sessionOptions: Parameters<typeof createAgentSession>[0]) =>
              createAgentSession({
                 ...sessionOptions,
                 sessionManager: SessionManager.open(path.resolve(options.resumeSessionFile!))
              })
         : undefined);

   const notifySettled = async (outcome: AgentOutcome) => {
      if (!activeSession) return;
      const status = outcome.aborted ? "cancelled" : outcome.ok ? "completed" : "failed";
      const data = outcome.structured ?? (outcome.output.length > 0 ? outcome.output : undefined);
      try {
         await options.onSettled?.(status, data, outcome.error);
      } catch {
         // Job settlement must not turn a completed child session into a startup error.
      }
   };

   const completion = runAgent({
      prompt: buildWorkflowAgentPrompt(options.prompt, { requireStructuredOutput: true }),
      schema: DEFAULT_WORKFLOW_OUTPUT_SCHEMA,
      profile: profileForWorker(options),
      model: inheritedModel as WorkflowModel | undefined,
      cwd,
      parentSessionFile: options.parentSessionFile,
      loader,
      settingsManager,
      modelRegistry: options.modelRegistry as any,
      signal: controller.signal,
      sessionName: options.sessionName,
      createSessionFn,
      onSession: (session) => {
         activeSession = session;
         resolveSession?.(session);
      },
      onSessionReady: options.onSessionReady,
      onProgress: (progress) => {
         if (progress.preview.length > 0) options.onOutput?.(progress.preview);
      }
   })
      .then(async (outcome) => {
         await notifySettled(outcome);
         return outcome;
      })
      .catch(async (error) => {
         const outcome = workerOutcomeError(error);
         await notifySettled(outcome);
         return outcome;
      })
      .finally(() => {
         options.signal?.removeEventListener("abort", abortFromParent);
      });

   const startup = await Promise.race([
      sessionReady.then((session) => ({ session })),
      completion.then((outcome) => ({ outcome }))
   ]);

   if ("outcome" in startup) {
      throw new Error(startup.outcome.error ?? "Pi worker session failed to initialize");
   }

   const session = startup.session;
   return {
      session,
      completion,
      abort: () => Effect.sync(() => controller.abort()),
      control: (text: string, mode: ControlMode) => routeWorkerControl(session, text, mode)
   };
}

export interface WorkerManagerShape {
   readonly spawnBatch: (
      specs: ReadonlyArray<WorkerSpec>,
      options?: WorkerManagerSpawnOptions
   ) => Effect.Effect<
      ReadonlyArray<Task>,
      | CapacityError
      | ConcurrencyLimitError
      | WorkerProfileNotFoundError
      | DuplicateTaskError
      | ParentSessionActivationError
   >;

   readonly recoverTask: (
      id: string,
      options?: {
         ownerSessionId?: string;
         parentSessionFile?: string;
         modelRegistry?: ProfileModelRegistry<any>;
         inheritedModel?: InheritedModelIdentity;
         note?: string;
      }
   ) => Effect.Effect<Task | undefined, WorkerProfileNotFoundError | ControlError | ParentSessionActivationError>;
   readonly cancelTask: (id: string) => Effect.Effect<Task | undefined>;
   readonly reserveTaskSeq: (maxRecoveredSeq: number) => Effect.Effect<void>;
   readonly cancelActiveSessions: Effect.Effect<void>;
}

export class WorkerManager extends Context.Service<WorkerManager, WorkerManagerShape>()("workers/WorkerManager") {
   static readonly layer = Layer.effect(
      WorkerManager,
      Effect.gen(function* () {
         const registry = yield* TaskRegistry;

         let reservedAgentSlots = 0;
         let taskSeq = 0;
         const activeSessions = new Map<string, ActiveWorkerSession>();
         const activeSessionOwners = new Map<string, string>();
         const pendingStartup = new Map<string, AbortController>();
         const clearActiveSession = (taskId: string, ownerSessionId?: string) => {
            if (ownerSessionId !== undefined && activeSessionOwners.get(taskId) !== ownerSessionId) return;
            activeSessions.delete(taskId);
            activeSessionOwners.delete(taskId);
         };

         const isTerminalStatus = (status: Task["status"]) =>
            status === "completed" || status === "failed" || status === "cancelled";
         const isSettledStatus = (status: Task["status"]) => isTerminalStatus(status) || status === "recoverable";
         const updateRunningIfActive = (taskId: string, patch: Partial<Task>, ownerSessionId?: string) =>
            Effect.gen(function* () {
               const current = yield* registry.get(taskId);
               if (
                  !current ||
                  (ownerSessionId !== undefined && current.ownerSessionId !== ownerSessionId) ||
                  isSettledStatus(current.status)
               )
                  return current;
               return yield* registry.updateStatus(taskId, "running", patch);
            });
         const updateSettledIfActive = (
            taskId: string,
            status: "completed" | "failed" | "cancelled" | "recoverable",
            patch?: Partial<Task>,
            ownerSessionId?: string
         ) =>
            Effect.gen(function* () {
               const current = yield* registry.get(taskId);
               if (
                  !current ||
                  (ownerSessionId !== undefined && current.ownerSessionId !== ownerSessionId) ||
                  (isSettledStatus(current.status) && current.status !== status)
               )
                  return current;
               return yield* registry.updateStatus(taskId, status, patch);
            });

         // Keep only transient live output. Pi takeover output comes directly
         // from the worker's persisted JSONL session; Pi uses this only as a
         // completion fallback when structured output refers to earlier output.
         const liveOutputState = new Map<string, { text?: string }>();
         const onLiveOutput = (taskId: string) => (text: string) => {
            liveOutputState.set(taskId, { text });
         };
         const takeLiveOutput = (taskId: string) => {
            const entry = liveOutputState.get(taskId);
            liveOutputState.delete(taskId);
            return { text: entry?.text };
         };
         const clearLiveOutput = (taskId: string) => {
            takeLiveOutput(taskId);
         };

         const spawnBatch = Effect.fn("WorkerManager.spawnBatch")(function* (
            specs: ReadonlyArray<WorkerSpec>,
            options?: WorkerManagerSpawnOptions
         ) {
            const gateOpt = yield* Effect.serviceOption(ParentSessionGate);
            if (Option.isSome(gateOpt)) {
               yield* gateOpt.value.awaitReady();
            }

            const incomingCount = specs.length;
            const ownerSessionId = options?.ownerSessionId ?? "parent";

            // Validate the complete batch before reserving capacity, registering, or starting any job.
            for (const spec of specs) {
               const targetWorker = spec.worker.trim();
               if (targetWorker.length === 0) {
                  return yield* new WorkerProfileNotFoundError({
                     message: "A worker profile is required for every worker.",
                     worker: "<missing>"
                  });
               }
               const agentDef = resolveAgentProfile(targetWorker, spec.cwd ?? process.cwd());
               if (!agentDef) {
                  return yield* new WorkerProfileNotFoundError({
                     message: `Worker profile "${targetWorker}" is not enabled. Select an enabled profile from /wr-profile.`,
                     worker: targetWorker
                  });
               }
            }

            const runningTasks = yield* registry.list({ status: "running" });
            const runningCount = runningTasks.length;

            if (runningCount + reservedAgentSlots + incomingCount > MAX_RUNNING_AGENTS) {
               return yield* new ConcurrencyLimitError({
                  message: `Concurrency limit exceeded. Maximum ${MAX_RUNNING_AGENTS} concurrent workers allowed.`,
                  limit: MAX_RUNNING_AGENTS
               });
            }

            reservedAgentSlots += incomingCount;
            const spawnedSessions: Array<{
               taskId: string;
               abort: () => Effect.Effect<void, any>;
               completion: Promise<AgentOutcome>;
            }> = [];
            const abortSpawnedSessions = Effect.gen(function* () {
               for (const spawned of spawnedSessions) {
                  yield* spawned.abort().pipe(Effect.ignore);
                  yield* updateSettledIfActive(spawned.taskId, "cancelled", undefined, ownerSessionId).pipe(
                     Effect.ignore
                  );
                  clearActiveSession(spawned.taskId, ownerSessionId);
               }
            });

            return yield* Effect.gen(function* () {
               const registeredTasks: Task[] = [];
               const completions: Array<Promise<AgentOutcome>> = [];
               for (const spec of specs) {
                  taskSeq++;
                  const taskId = formatTaskId(taskSeq);

                  const targetWorker = spec.worker.trim();
                  let agentDef = resolveAgentProfile(targetWorker, spec.cwd ?? process.cwd());
                  if (!agentDef) {
                     return yield* new WorkerProfileNotFoundError({
                        message: `Worker profile "${targetWorker}" is not enabled. Select an enabled profile from /wr-profile.`,
                        worker: targetWorker
                     });
                  }

                  if (spec.systemPrompt !== undefined) {
                     agentDef = {
                        ...agentDef,
                        systemPrompt: spec.systemPrompt,
                        thinking: (spec.thinking ?? agentDef.thinking) as AgentProfile["thinking"],
                        tools: spec.tools ?? agentDef.tools
                     };
                  }

                  const resolvedModel = agentDef?.model;
                  const resolvedThinking = spec.thinking ?? agentDef?.thinking;
                  const taskPrompt = spec.task;
                  const task = yield* registry.register({
                     id: taskId,
                     ownerSessionId,
                     name: spec.name ?? taskId,
                     worker: targetWorker,
                     model: resolvedModel,
                     thinking: resolvedThinking,
                     cwd: spec.cwd ?? process.cwd(),
                     context: spec.context,
                     batchId: options?.batchId,
                     batchSize: options?.batchSize,
                     promptOrCommand: taskPrompt,
                     background: options?.background === true
                  });

                  const runningTask = yield* registry.updateStatus(task.id, "running");
                  registeredTasks.push(runningTask);

                  // Spawn the Pi child session.

                  const startupController = new AbortController();
                  pendingStartup.set(taskId, startupController);
                  const piSession = yield* Effect.onInterrupt(
                     Effect.promise(() =>
                        spawnWorkerSession({
                           sessionName: `worker: ${spec.name ?? taskId} ${taskId}`,
                           prompt: spec.task,
                           cwd: spec.cwd ?? process.cwd(),
                           parentSessionFile: options?.parentSessionFile,
                           agentDef,
                           specThinking: spec.thinking,
                           specTools: spec.tools,
                           modelRegistry: options?.modelRegistry,
                           inheritedModel: options?.inheritedModel,
                           signal: startupController.signal,
                           onOutput: onLiveOutput(taskId),
                           onSessionReady: (metadata) =>
                              Effect.runPromise(
                                 updateRunningIfActive(
                                    taskId,
                                    {
                                       ...metadata,
                                       sessionFile: metadata.sessionFile,
                                       sessionId: metadata.sessionId
                                    },
                                    ownerSessionId
                                 )
                              ).then(() => undefined),
                           onSettled: (resStatus, data, errorText) => {
                              return Effect.runPromise(
                                 Effect.gen(function* () {
                                    const current = yield* registry.get(taskId);
                                    // A recoverable worker keeps its session file so the main
                                    // session can resume it. Mark exactly once.
                                    if (
                                       resStatus === "failed" &&
                                       current?.status !== "recoverable" &&
                                       typeof current?.sessionFile === "string" &&
                                       current.sessionFile.length > 0
                                    ) {
                                       yield* updateSettledIfActive(
                                          taskId,
                                          "recoverable",
                                          { errorText: errorText ?? "Task failed" },
                                          ownerSessionId
                                       );
                                       return;
                                    }
                                    clearActiveSession(taskId, ownerSessionId);
                                    takeLiveOutput(taskId);
                                    if (resStatus === "completed") {
                                       yield* updateSettledIfActive(
                                          taskId,
                                          "completed",
                                          { resultData: data },
                                          ownerSessionId
                                       );
                                    } else if (resStatus === "failed") {
                                       yield* updateSettledIfActive(
                                          taskId,
                                          "failed",
                                          { errorText: errorText ?? "Task failed" },
                                          ownerSessionId
                                       );
                                    } else {
                                       yield* updateSettledIfActive(taskId, "cancelled", undefined, ownerSessionId);
                                    }
                                 })
                              ).then(() => undefined);
                           }
                        }).catch(async (err) => {
                           clearActiveSession(taskId, ownerSessionId);
                           clearLiveOutput(taskId);
                           if (!startupController.signal.aborted) {
                              await Effect.runPromise(
                                 updateSettledIfActive(
                                    taskId,
                                    "failed",
                                    { errorText: err instanceof Error ? err.message : String(err) },
                                    ownerSessionId
                                 )
                              ).catch(() => {});
                           }
                           return {
                              completion: Promise.resolve(workerOutcomeError(err)),
                              abort: () => Effect.void,
                              control: () => Effect.fail(new ControlError({ message: "Session failed to initialize" }))
                           };
                        })
                     ),
                     () =>
                        Effect.gen(function* () {
                           startupController.abort();
                           yield* updateSettledIfActive(taskId, "cancelled", undefined, ownerSessionId).pipe(
                              Effect.ignore
                           );
                        })
                  ).pipe(Effect.ensuring(Effect.sync(() => pendingStartup.delete(taskId))));

                  if (startupController.signal.aborted) {
                     yield* piSession.abort().pipe(Effect.ignore);
                     continue;
                  }

                  activeSessions.set(taskId, {
                     abort: () => piSession.abort(),
                     control: (text, mode) => piSession.control(text, mode)
                  });
                  activeSessionOwners.set(taskId, ownerSessionId);
                  spawnedSessions.push({ taskId, abort: piSession.abort, completion: piSession.completion });
                  completions.push(piSession.completion);
               }
               if (options?.background !== true) {
                  yield* Effect.promise(() => Promise.all(completions).then(() => undefined));
               }
               return registeredTasks;
            }).pipe(
               Effect.onInterrupt(() => abortSpawnedSessions),
               Effect.ensuring(
                  Effect.sync(() => {
                     reservedAgentSlots = Math.max(0, reservedAgentSlots - incomingCount);
                  })
               )
            );
         });

         /**
          * Resume a failed/stalled task inside its own persisted session.
          *
          * The original prompt is not re-sent: the session already contains every
          * message and tool result produced before the failure. One continuation
          * turn asks the worker to finish and call structured_output.
          */
         const recoverTask = Effect.fn("WorkerManager.recoverTask")(function* (
            id: string,
            options?: {
               ownerSessionId?: string;
               parentSessionFile?: string;
               modelRegistry?: ProfileModelRegistry<any>;
               inheritedModel?: InheritedModelIdentity;
               note?: string;
            }
         ) {
            const current = yield* registry.get(id);
            if (!current) return undefined;
            if (!canRecoverTask(current)) {
               return yield* new ControlError({
                  message: `Task ${id} is not recoverable (requires status "recoverable" and a session file).`
               });
            }

            const sessionFile = current.sessionFile!;
            const ownerSessionId = options?.ownerSessionId ?? current.ownerSessionId;
            if (!existsSync(sessionFile)) {
               yield* updateSettledIfActive(
                  id,
                  "failed",
                  { errorText: `Session file for ${id} no longer exists: ${sessionFile}` },
                  ownerSessionId
               );
               return yield* registry.get(id);
            }
            const targetWorker = current.worker ?? "worker";
            const agentDef = resolveAgentProfile(targetWorker, current.cwd ?? process.cwd());
            if (!agentDef) {
               return yield* new WorkerProfileNotFoundError({
                  message: `Worker profile "${targetWorker}" is not enabled for recover of ${id}.`,
                  worker: targetWorker
               });
            }

            const activeSession = activeSessions.get(id);
            if (activeSession) {
               return yield* new ControlError({
                  message: `Task ${id} is already running; wait for it to settle before recovering.`
               });
            }

            const recoveredTask = yield* registry.updateStatus(id, "running", {
               errorText: undefined,
               resultData: undefined,
               sessionFile
            });
            yield* Effect.void;

            const startupController = new AbortController();
            pendingStartup.set(id, startupController);

            const recoverPrompt =
               options?.note && options.note.trim().length > 0
                  ? `Continue the unfinished task from this session. Do not restart: every read, tool result and note is already here. The main session requested: ${options.note.trim()} Finish the assignment, then call structured_output exactly once as your final action.`
                  : "Continue the unfinished task from this session. Do not restart: every read, tool result and note is already here. Finish the assignment, then call structured_output exactly once as your final action.";

            const recoverySession = yield* Effect.onInterrupt(
               Effect.promise(() =>
                  spawnWorkerSession({
                     sessionName: `worker-recover: ${current.name ?? id} ${id}`,
                     prompt: recoverPrompt,
                     cwd: current.cwd ?? process.cwd(),
                     parentSessionFile: options?.parentSessionFile,
                     agentDef,
                     specThinking: current.thinking,
                     specTools: agentDef.tools,
                     modelRegistry: options?.modelRegistry,
                     inheritedModel: options?.inheritedModel,
                     signal: startupController.signal,
                     resumeSessionFile: sessionFile,
                     onOutput: onLiveOutput(id),
                     onSessionReady: (metadata) =>
                        Effect.runPromise(
                           updateRunningIfActive(
                              id,
                              {
                                 ...metadata,
                                 sessionFile: metadata.sessionFile ?? sessionFile,
                                 sessionId: metadata.sessionId
                              },
                              ownerSessionId
                           )
                        ).then(() => undefined),
                     onSettled: (resStatus, data, errorText) => {
                        return Effect.runPromise(
                           Effect.gen(function* () {
                              clearActiveSession(id, ownerSessionId);
                              takeLiveOutput(id);
                              if (resStatus === "completed") {
                                 yield* updateSettledIfActive(id, "completed", { resultData: data }, ownerSessionId);
                              } else if (resStatus === "failed") {
                                 yield* updateSettledIfActive(
                                    id,
                                    "recoverable",
                                    { errorText: errorText ?? "Recover attempt failed" },
                                    ownerSessionId
                                 );
                              } else {
                                 yield* updateSettledIfActive(id, "cancelled", undefined, ownerSessionId);
                              }
                           })
                        ).then(() => undefined);
                     }
                  }).catch(async (err) => {
                     clearActiveSession(id, ownerSessionId);
                     clearLiveOutput(id);
                     await Effect.runPromise(
                        updateSettledIfActive(
                           id,
                           "recoverable",
                           { errorText: err instanceof Error ? err.message : String(err) },
                           ownerSessionId
                        )
                     ).catch(() => {});
                     return {
                        completion: Promise.resolve(workerOutcomeError(err)),
                        abort: () => Effect.void,
                        control: () => Effect.fail(new ControlError({ message: "Session failed to initialize" }))
                     };
                  })
               ),
               () =>
                  Effect.gen(function* () {
                     startupController.abort();
                     yield* updateSettledIfActive(id, "recoverable", undefined, ownerSessionId).pipe(Effect.ignore);
                  })
            ).pipe(Effect.ensuring(Effect.sync(() => pendingStartup.delete(id))));

            if (startupController.signal.aborted) {
               yield* recoverySession.abort().pipe(Effect.ignore);
               return yield* registry.get(id);
            }

            activeSessions.set(id, {
               abort: () => recoverySession.abort(),
               control: (text, mode) => recoverySession.control(text, mode)
            });
            activeSessionOwners.set(id, ownerSessionId);

            return yield* registry.get(id);
         });

         const cancelTask = Effect.fn("WorkerManager.cancelTask")(function* (id: string) {
            const active = activeSessions.get(id);
            if (active) {
               yield* active.abort().pipe(Effect.ignore);
               clearActiveSession(id);
            } else {
               const startup = pendingStartup.get(id);
               if (startup) {
                  startup.abort();
                  pendingStartup.delete(id);
               }
            }
            clearLiveOutput(id);
            return yield* registry.updateStatus(id, "cancelled");
         });

         const reserveTaskSeq = Effect.fn("WorkerManager.reserveTaskSeq")((maxRecoveredSeq: number) =>
            Effect.sync(() => {
               if (maxRecoveredSeq > taskSeq) {
                  taskSeq = maxRecoveredSeq;
               }
            })
         );

         const cancelActiveSessions = Effect.gen(function* () {
            for (const [id, startup] of Array.from(pendingStartup.entries())) {
               startup.abort();
               pendingStartup.delete(id);
               yield* updateSettledIfActive(id, "cancelled").pipe(Effect.ignore);
            }
            for (const [id, session] of Array.from(activeSessions.entries())) {
               const task = yield* registry.get(id);
               yield* session.abort().pipe(Effect.ignore);
               if (task?.status !== "completed" && task?.status !== "failed" && task?.status !== "cancelled") {
                  yield* updateSettledIfActive(id, "cancelled").pipe(Effect.ignore);
               }
               clearActiveSession(id);
               clearLiveOutput(id);
            }
            activeSessions.clear();
            activeSessionOwners.clear();
         });

         return WorkerManager.of({
            spawnBatch,
            recoverTask,
            cancelTask,
            reserveTaskSeq,
            cancelActiveSessions
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: WorkerManagerShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | WorkerManager> {
      return Effect.gen(function* () {
         const svc = yield* WorkerManager;
         return yield* fn(svc);
      });
   }
}
