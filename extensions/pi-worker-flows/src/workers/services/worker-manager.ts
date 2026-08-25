import { Context, Effect, Layer, Option } from "effect";
import {
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   SettingsManager,
   type AgentSession
} from "@earendil-works/pi-coding-agent";
import {
   CapacityError,
   ConcurrencyLimitError,
   AgentNotFoundError,
   ControlError,
   DuplicateJobError,
   ParentSessionActivationError,
   formatJobId,
   type Job,
   type WorkerSpec,
   type ControlMode
} from "../domain.js";
import { JobRegistry } from "./job-registry.js";
import { ParentSessionGate } from "./workers-job-recovery.js";
import { createChildResources } from "../../shared/child-session.js";
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
} from "../../shared/agent-runner.ts";
import { resolveAgentProfile, type AgentProfile } from "../../services/agent-profiles.ts";
import type { InheritedModelIdentity, ProfileModelRegistry } from "../../services/model-resolution.ts";

export const MAX_RUNNING_AGENTS = 4;

export interface WorkerManagerSpawnOptions {
   ownerSessionId?: string;
   batchId?: string;
   batchSize?: number;
   modelRegistry?: ProfileModelRegistry<any>;
   inheritedModel?: InheritedModelIdentity;
   parentSessionFile?: string;
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
   onSettled?: (status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string) => void;
   onOutput?: (text: string) => void;
   onSessionReady?: (metadata: AgentSessionMetadata) => Promise<void> | void;
   createSessionFn?: typeof createAgentSession;
   resourceLoader?: DefaultResourceLoader;
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

   const notifySettled = (outcome: AgentOutcome) => {
      if (!activeSession) return;
      const status = outcome.aborted ? "cancelled" : outcome.ok ? "completed" : "failed";
      const data = outcome.structured ?? (outcome.output.length > 0 ? outcome.output : undefined);
      try {
         options.onSettled?.(status, data, outcome.error);
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
      createSessionFn: options.createSessionFn,
      onSession: (session) => {
         activeSession = session;
         resolveSession?.(session);
      },
      onSessionReady: options.onSessionReady,
      onProgress: (progress) => {
         if (progress.preview.length > 0) options.onOutput?.(progress.preview);
      }
   })
      .then((outcome) => {
         notifySettled(outcome);
         return outcome;
      })
      .catch((error) => {
         const outcome = workerOutcomeError(error);
         notifySettled(outcome);
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
      abort: () => Effect.sync(() => controller.abort()),
      control: (text: string, mode: ControlMode) => routeWorkerControl(session, text, mode)
   };
}

export interface WorkerManagerShape {
   readonly spawnBatch: (
      specs: ReadonlyArray<WorkerSpec>,
      options?: WorkerManagerSpawnOptions
   ) => Effect.Effect<
      ReadonlyArray<Job>,
      CapacityError | ConcurrencyLimitError | AgentNotFoundError | DuplicateJobError | ParentSessionActivationError
   >;

   readonly cancelJob: (id: string) => Effect.Effect<Job | undefined>;
   readonly controlJob: (id: string, text: string, mode: ControlMode) => Effect.Effect<void, ControlError>;
   readonly reserveWorkerSeq: (maxRecoveredSeq: number) => Effect.Effect<void>;
   readonly cancelActiveSessions: Effect.Effect<void>;
}

export class WorkerManager extends Context.Service<WorkerManager, WorkerManagerShape>()("workers/WorkerManager") {
   static readonly layer = Layer.effect(
      WorkerManager,
      Effect.gen(function* () {
         const registry = yield* JobRegistry;

         let reservedAgentSlots = 0;
         let workerSeq = 0;
         const activeSessions = new Map<string, ActiveWorkerSession>();
         const activeSessionOwners = new Map<string, string>();
         const pendingStartup = new Map<string, AbortController>();
         const clearActiveSession = (jobId: string, ownerSessionId?: string) => {
            if (ownerSessionId !== undefined && activeSessionOwners.get(jobId) !== ownerSessionId) return;
            activeSessions.delete(jobId);
            activeSessionOwners.delete(jobId);
         };

         const isTerminalStatus = (status: Job["status"]) =>
            status === "completed" || status === "failed" || status === "cancelled";
         const updateRunningIfActive = (jobId: string, patch: Partial<Job>, ownerSessionId?: string) =>
            Effect.gen(function* () {
               const current = yield* registry.get(jobId);
               if (
                  !current ||
                  (ownerSessionId !== undefined && current.ownerSessionId !== ownerSessionId) ||
                  isTerminalStatus(current.status)
               )
                  return current;
               return yield* registry.updateStatus(jobId, "running", patch);
            });
         const updateSettledIfActive = (
            jobId: string,
            status: "completed" | "failed" | "cancelled",
            patch?: Partial<Job>,
            ownerSessionId?: string
         ) =>
            Effect.gen(function* () {
               const current = yield* registry.get(jobId);
               if (
                  !current ||
                  (ownerSessionId !== undefined && current.ownerSessionId !== ownerSessionId) ||
                  (isTerminalStatus(current.status) && current.status !== status)
               )
                  return current;
               return yield* registry.updateStatus(jobId, status, patch);
            });

         // Keep only transient live output. Pi takeover output comes directly
         // from the worker's persisted JSONL session; Pi uses this only as a
         // completion fallback when structured output refers to earlier output.
         const liveOutputState = new Map<string, { text?: string }>();
         const onLiveOutput = (jobId: string) => (text: string) => {
            liveOutputState.set(jobId, { text });
         };
         const takeLiveOutput = (jobId: string) => {
            const entry = liveOutputState.get(jobId);
            liveOutputState.delete(jobId);
            return { text: entry?.text };
         };
         const clearLiveOutput = (jobId: string) => {
            takeLiveOutput(jobId);
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
               const targetAgent = spec.agent.trim();
               if (targetAgent.length === 0) {
                  return yield* new AgentNotFoundError({
                     message: "An agent profile is required for every worker.",
                     agent: "<missing>"
                  });
               }
               const agentDef = resolveAgentProfile(targetAgent, spec.cwd ?? process.cwd());
               if (!agentDef) {
                  return yield* new AgentNotFoundError({
                     message: `Agent "${targetAgent}" is not enabled. Select an enabled profile from /agents.`,
                     agent: targetAgent
                  });
               }
            }

            const runningJobs = yield* registry.list({ status: "running" });
            const runningCount = runningJobs.length;

            if (runningCount + reservedAgentSlots + incomingCount > MAX_RUNNING_AGENTS) {
               return yield* new ConcurrencyLimitError({
                  message: `Concurrency limit exceeded. Maximum ${MAX_RUNNING_AGENTS} concurrent agent jobs allowed.`,
                  limit: MAX_RUNNING_AGENTS
               });
            }

            reservedAgentSlots += incomingCount;

            return yield* Effect.gen(function* () {
               const registeredJobs: Job[] = [];
               for (const spec of specs) {
                  workerSeq++;
                  const jobId = formatJobId(workerSeq);

                  const targetAgent = spec.agent.trim();
                  let agentDef = resolveAgentProfile(targetAgent, spec.cwd ?? process.cwd());
                  if (!agentDef) {
                     return yield* new AgentNotFoundError({
                        message: `Agent "${targetAgent}" is not enabled. Select an enabled profile from /agents.`,
                        agent: targetAgent
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
                  const job = yield* registry.register({
                     id: jobId,
                     ownerSessionId,
                     name: spec.name ?? jobId,
                     agent: targetAgent,
                     model: resolvedModel,
                     thinking: resolvedThinking,
                     cwd: spec.cwd ?? process.cwd(),
                     context: spec.context,
                     batchId: options?.batchId,
                     batchSize: options?.batchSize,
                     promptOrCommand: taskPrompt
                  });

                  const runningJob = yield* registry.updateStatus(job.id, "running");
                  registeredJobs.push(runningJob);

                  // Spawn the Pi child session.

                  const startupController = new AbortController();
                  pendingStartup.set(jobId, startupController);
                  const piSession = yield* Effect.onInterrupt(
                     Effect.promise(() =>
                        spawnWorkerSession({
                           sessionName: `worker: ${spec.name ?? jobId} ${jobId}`,
                           prompt: spec.task,
                           cwd: spec.cwd ?? process.cwd(),
                           parentSessionFile: options?.parentSessionFile,
                           agentDef,
                           specThinking: spec.thinking,
                           specTools: spec.tools,
                           modelRegistry: options?.modelRegistry,
                           inheritedModel: options?.inheritedModel,
                           signal: startupController.signal,
                           onOutput: onLiveOutput(jobId),
                           onSessionReady: (metadata) =>
                              Effect.runPromise(
                                 updateRunningIfActive(
                                    jobId,
                                    {
                                       ...metadata,
                                       sessionFile: metadata.sessionFile,
                                       sessionId: metadata.sessionId
                                    },
                                    ownerSessionId
                                 )
                              ).then(() => undefined),
                           onSettled: (resStatus, data, errorText) => {
                              clearActiveSession(jobId, ownerSessionId);
                              takeLiveOutput(jobId);
                              if (resStatus === "completed") {
                                 Effect.runPromise(
                                    updateSettledIfActive(jobId, "completed", { resultData: data }, ownerSessionId)
                                 ).catch(() => {});
                              } else if (resStatus === "failed") {
                                 Effect.runPromise(
                                    updateSettledIfActive(
                                       jobId,
                                       "failed",
                                       { errorText: errorText ?? "Job failed" },
                                       ownerSessionId
                                    )
                                 ).catch(() => {});
                              } else if (resStatus === "cancelled") {
                                 Effect.runPromise(
                                    updateSettledIfActive(jobId, "cancelled", undefined, ownerSessionId)
                                 ).catch(() => {});
                              }
                           }
                        }).catch((err) => {
                           clearActiveSession(jobId, ownerSessionId);
                           clearLiveOutput(jobId);
                           if (!startupController.signal.aborted) {
                              Effect.runPromise(
                                 updateSettledIfActive(
                                    jobId,
                                    "failed",
                                    { errorText: err instanceof Error ? err.message : String(err) },
                                    ownerSessionId
                                 )
                              ).catch(() => {});
                           }
                           return {
                              abort: () => Effect.void,
                              control: () => Effect.fail(new ControlError({ message: "Session failed to initialize" }))
                           };
                        })
                     ),
                     () =>
                        Effect.gen(function* () {
                           startupController.abort();
                           yield* updateSettledIfActive(jobId, "cancelled", undefined, ownerSessionId).pipe(
                              Effect.ignore
                           );
                        })
                  ).pipe(Effect.ensuring(Effect.sync(() => pendingStartup.delete(jobId))));

                  if (startupController.signal.aborted) {
                     yield* piSession.abort().pipe(Effect.ignore);
                     continue;
                  }

                  activeSessions.set(jobId, {
                     abort: () => piSession.abort(),
                     control: (text, mode) => piSession.control(text, mode)
                  });
                  activeSessionOwners.set(jobId, ownerSessionId);
               }
               return registeredJobs;
            }).pipe(
               Effect.ensuring(
                  Effect.sync(() => {
                     reservedAgentSlots = Math.max(0, reservedAgentSlots - incomingCount);
                  })
               )
            );
         });

         const cancelJob = Effect.fn("WorkerManager.cancelJob")(function* (id: string) {
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

         const controlJob = Effect.fn("WorkerManager.controlJob")(function* (
            id: string,
            text: string,
            mode: ControlMode
         ) {
            const active = activeSessions.get(id);
            if (!active) {
               return yield* new ControlError({ message: `Job ${id} has no active worker session` });
            }

            const job = yield* registry.get(id);
            if (job?.status === "completed") {
               yield* registry.updateStatus(id, "running", {
                  resultData: undefined,
                  errorText: undefined
               });
               return yield* active.control(text, mode).pipe(
                  Effect.catch((error) =>
                     registry
                        .updateStatus(id, "completed", {
                           resultData: job.resultData,
                           errorText: job.errorText
                        })
                        .pipe(Effect.flatMap(() => Effect.fail(error)))
                  )
               );
            }

            return yield* active.control(text, mode);
         });

         const reserveWorkerSeq = Effect.fn("WorkerManager.reserveWorkerSeq")((maxRecoveredSeq: number) =>
            Effect.sync(() => {
               if (maxRecoveredSeq > workerSeq) {
                  workerSeq = maxRecoveredSeq;
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
               const job = yield* registry.get(id);
               yield* session.abort().pipe(Effect.ignore);
               if (job?.status !== "completed" && job?.status !== "failed" && job?.status !== "cancelled") {
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
            cancelJob,
            controlJob,
            reserveWorkerSeq,
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
