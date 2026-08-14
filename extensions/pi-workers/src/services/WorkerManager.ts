import { Context, Effect, Layer, Option } from "effect";
import {
   CapacityError,
   ConcurrencyLimitError,
   AgentNotFoundError,
   ControlError,
   SchemaConversionError,
   DuplicateJobError,
   ParentSessionActivationError,
   formatJobId,
   mapAgyEffort,
   resolveHarness,
   type Job,
   type JobTranscriptEntry,
   type WorkerSpec,
   type ControlMode
} from "../domain.js";
import { JobRegistry } from "./JobRegistry.js";
import { ParentSessionGate } from "./ParentSessionGate.js";
import { AgentsStore } from "./AgentsStore.js";
import { SchemaValidator } from "./SchemaValidator.js";
import { AgyBackend, type AgyOneShotResult } from "../backends/agy.js";
import { PiBackend } from "../backends/pi.js";
import type { InheritedModelInfo, ModelRegistryLike } from "../backends/pi-model.js";
import { acpEventToTranscriptEntry, readAgyTranscriptRecords, type AcpDecodedEvent } from "../utils/acp-decoder.js";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgyAgentLink } from "../utils/agy-agent-link.js";

export const MAX_RUNNING_AGENTS = 4;

export interface WorkerManagerSpawnOptions {
   ownerSessionId?: string;
   origin?: "standard" | "btw";
   skipAgentSlot?: boolean;
   batchId?: string;
   batchSize?: number;
   modelRegistry?: ModelRegistryLike;
   inheritedModel?: InheritedModelInfo;
   parentSessionFile?: string;
}

export interface ActiveBackendSession {
   readonly abort: () => Effect.Effect<void, any>;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, any>;
}

export interface WorkerManagerShape {
   readonly spawnWorker: (
      spec: WorkerSpec,
      options?: WorkerManagerSpawnOptions
   ) => Effect.Effect<
      Job,
      | CapacityError
      | ConcurrencyLimitError
      | AgentNotFoundError
      | SchemaConversionError
      | DuplicateJobError
      | ParentSessionActivationError
   >;

   readonly spawnBatch: (
      specs: ReadonlyArray<WorkerSpec>,
      options?: WorkerManagerSpawnOptions
   ) => Effect.Effect<
      ReadonlyArray<Job>,
      | CapacityError
      | ConcurrencyLimitError
      | AgentNotFoundError
      | SchemaConversionError
      | DuplicateJobError
      | ParentSessionActivationError
   >;

   readonly cancelJob: (id: string) => Effect.Effect<Job | undefined>;
   readonly controlJob: (id: string, text: string, mode: ControlMode) => Effect.Effect<void, ControlError>;
   readonly reserveWorkerSeq: (maxRecoveredSeq: number) => Effect.Effect<void>;
   readonly disposeAll: Effect.Effect<void>;
   readonly disposeAllSessions: Effect.Effect<void>;
}

export class WorkerManager extends Context.Service<WorkerManager, WorkerManagerShape>()("workers/WorkerManager") {
   static readonly layer = Layer.effect(
      WorkerManager,
      Effect.gen(function* () {
         const registry = yield* JobRegistry;
         const agentsStoreOpt = yield* Effect.serviceOption(AgentsStore);
         const schemaValidatorOpt = yield* Effect.serviceOption(SchemaValidator);
         const agyBackendOpt = yield* Effect.serviceOption(AgyBackend);
         const piBackendOpt = yield* Effect.serviceOption(PiBackend);
         const workerContext = yield* Effect.context();

         let reservedAgentSlots = 0;
         let workerSeq = 0;
         const activeSessions = new Map<string, ActiveBackendSession>();
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

         const agyTranscripts = new Map<string, JobTranscriptEntry[]>();
         const agyTranscriptWrites = new Map<string, Promise<void>>();
         const MAX_AGY_TRANSCRIPT_ENTRIES = 512;

         const mergeAgyTranscriptEntry = (
            entries: ReadonlyArray<JobTranscriptEntry>,
            entry: JobTranscriptEntry
         ): ReadonlyArray<JobTranscriptEntry> => {
            if (entry.type === "tool-call") {
               if (
                  entries.some(
                     (candidate) => candidate.type === "tool-call" && candidate.toolCallId === entry.toolCallId
                  )
               ) {
                  return entries;
               }
            }

            if (entry.type === "tool-result") {
               const existingIndex = entries.findIndex(
                  (candidate) => candidate.type === "tool-result" && candidate.toolCallId === entry.toolCallId
               );
               if (existingIndex >= 0) {
                  const replaced = [...entries];
                  replaced[existingIndex] = entry;
                  return replaced;
               }
            }

            if (entry.type === "assistant") {
               const previous = entries.at(-1);
               if (previous?.type === "assistant") {
                  return [...entries.slice(0, -1), { ...previous, text: `${previous.text}${entry.text}` }];
               }
            }

            const next = [...entries, entry];
            if (next.length <= MAX_AGY_TRANSCRIPT_ENTRIES) return next;
            const first = next[0]?.type === "user" ? [next[0]] : [];
            return [...first, ...next.slice(-(MAX_AGY_TRANSCRIPT_ENTRIES - first.length))];
         };

         const recordAgyEvent = (jobId: string, event: AcpDecodedEvent) => {
            const previousWrite = agyTranscriptWrites.get(jobId) ?? Promise.resolve();
            const nextWrite = previousWrite
               .then(async () => {
                  const entry = acpEventToTranscriptEntry(event);
                  const liveJob = await Effect.runPromise(registry.get(jobId));
                  if (
                     !liveJob ||
                     liveJob.status === "completed" ||
                     liveJob.status === "failed" ||
                     liveJob.status === "cancelled"
                  )
                     return;
                  const current = agyTranscripts.get(jobId) ?? [];
                  const next = mergeAgyTranscriptEntry(current, entry);
                  if (next === current || JSON.stringify(next) === JSON.stringify(current)) return;
                  agyTranscripts.set(jobId, [...next]);
                  await Effect.runPromise(updateRunningIfActive(jobId, { transcript: next }, liveJob.ownerSessionId));
               })
               .catch(() => {});
            agyTranscriptWrites.set(jobId, nextWrite);
         };

         const flushAgyTranscript = async (jobId: string) => {
            await (agyTranscriptWrites.get(jobId) ?? Promise.resolve());
            return agyTranscripts.get(jobId);
         };

         const clearAgyTranscript = (jobId: string) => {
            agyTranscripts.delete(jobId);
            agyTranscriptWrites.delete(jobId);
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
            const skipSlot = options?.skipAgentSlot ?? false;
            const origin = options?.origin ?? "standard";
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
               if (Option.isSome(agentsStoreOpt)) {
                  const agentDef = yield* agentsStoreOpt.value.getAgent(targetAgent);
                  if (!agentDef) {
                     return yield* new AgentNotFoundError({
                        message: `Agent "${targetAgent}" was not found. Select an agent from /agents.`,
                        agent: targetAgent
                     });
                  }
               }
            }

            if (!skipSlot) {
               const runningJobs = yield* registry.list({ status: "running" });
               const runningCount = runningJobs.length;

               if (runningCount + reservedAgentSlots + incomingCount > MAX_RUNNING_AGENTS) {
                  return yield* new ConcurrencyLimitError({
                     message: `Concurrency limit exceeded. Maximum ${MAX_RUNNING_AGENTS} concurrent agent jobs allowed.`,
                     limit: MAX_RUNNING_AGENTS
                  });
               }

               reservedAgentSlots += incomingCount;
            }

            return yield* Effect.gen(function* () {
               const registeredJobs: Job[] = [];
               for (const spec of specs) {
                  workerSeq++;
                  const jobId = formatJobId(workerSeq);

                  const targetAgent = spec.agent.trim();
                  let agentDef: any;
                  if (Option.isSome(agentsStoreOpt)) {
                     agentDef = yield* agentsStoreOpt.value.getAgent(targetAgent);
                     if (!agentDef) {
                        return yield* new AgentNotFoundError({
                           message: `Agent "${targetAgent}" was not found. Select an agent from /agents.`,
                           agent: targetAgent
                        });
                     }
                  }

                  const harness = resolveHarness(spec.harness, agentDef?.harness);
                  if (spec.systemPrompt !== undefined) {
                     agentDef = {
                        ...agentDef,
                        body: spec.systemPrompt,
                        harness,
                        thinking: spec.thinking ?? agentDef?.thinking,
                        tools: spec.tools ?? agentDef?.tools
                     };
                  }

                  const resolvedModel = agentDef?.model;
                  const resolvedThinking = spec.thinking ?? agentDef?.thinking;
                  const agyAgentName =
                     harness === "agy" && typeof agentDef?.filePath === "string"
                        ? ensureAgyAgentLink(agentDef.name, agentDef.filePath).agentName
                        : undefined;
                  const taskPrompt = spec.task;
                  const job = yield* registry.register({
                     id: jobId,
                     ownerSessionId,
                     name: spec.name ?? jobId,
                     kind: "agent",
                     agent: targetAgent,
                     model: resolvedModel,
                     thinking: resolvedThinking,
                     cwd: spec.cwd ?? process.cwd(),
                     context: spec.context,
                     origin,
                     batchId: options?.batchId,
                     batchSize: options?.batchSize,
                     promptOrCommand: taskPrompt,
                     harness,
                     transcript: harness === "agy" ? [{ type: "user", text: taskPrompt }] : undefined
                  });

                  const runningJob = yield* registry.updateStatus(job.id, "running");
                  registeredJobs.push(runningJob);

                  // Spawn child backend run
                  if (harness === "agy") {
                     if (Option.isNone(agyBackendOpt)) {
                        yield* registry.updateStatus(jobId, "failed", {
                           errorText: "Agy backend is unavailable. The worker was not started."
                        });
                        continue;
                     }
                     const agyBackend = agyBackendOpt.value;
                     const logFilePath = join(tmpdir(), `workers-agy-${process.pid}-${jobId}.log`);
                     let logOffset = 0;
                     const readLogChunk = async () => {
                        const text = await readFile(logFilePath, "utf8").catch(() => "");
                        const chunk = text.slice(logOffset);
                        logOffset = text.length;
                        return chunk;
                     };
                     const onAgyOutput = onLiveOutput(jobId);
                     agyTranscripts.set(jobId, [{ type: "user", text: spec.task }]);
                     const fsmSession = agyBackend.createFsmSession({
                        prompt: spec.task,
                        logFilePath,
                        readLogChunk,
                        readDb: readAgyTranscriptRecords,
                        agent: agyAgentName,
                        model: resolvedModel,
                        effort: mapAgyEffort(resolvedThinking),
                        cwd: spec.cwd ?? process.cwd(),
                        onOutput: onAgyOutput,
                        onEvent: (event) => recordAgyEvent(jobId, event),
                        onSettled: (res: AgyOneShotResult) => {
                           void (async () => {
                              const transcript = await flushAgyTranscript(jobId);
                              takeLiveOutput(jobId);
                              if (res.status === "completed") {
                                 await Effect.runPromise(
                                    updateSettledIfActive(
                                       jobId,
                                       "completed",
                                       {
                                          resultData: { data: res.finalText },
                                          transcript
                                       },
                                       ownerSessionId
                                    )
                                 );
                              } else if (res.status === "failed") {
                                 clearActiveSession(jobId, ownerSessionId);
                                 await Effect.runPromise(
                                    updateSettledIfActive(
                                       jobId,
                                       "failed",
                                       {
                                          errorText: res.errorText,
                                          transcript
                                       },
                                       ownerSessionId
                                    )
                                 );
                              } else if (res.status === "cancelled") {
                                 clearActiveSession(jobId, ownerSessionId);
                                 await Effect.runPromise(
                                    updateSettledIfActive(jobId, "cancelled", { transcript }, ownerSessionId)
                                 );
                              }
                              clearAgyTranscript(jobId);
                           })().catch(() => {});
                        }
                     });

                     activeSessions.set(jobId, {
                        abort: () => fsmSession.abort(),
                        control: (text, mode) => fsmSession.control(text, mode)
                     });
                     activeSessionOwners.set(jobId, ownerSessionId);

                     Effect.runPromise(fsmSession.start()).catch((error) => {
                        clearActiveSession(jobId, ownerSessionId);
                        Effect.runPromise(
                           updateSettledIfActive(
                              jobId,
                              "failed",
                              {
                                 errorText: error instanceof Error ? error.message : String(error)
                              },
                              ownerSessionId
                           )
                        ).catch(() => {});
                     });
                  } else {
                     if (Option.isNone(piBackendOpt)) {
                        yield* registry.updateStatus(jobId, "failed", {
                           errorText: "Pi backend is unavailable. The worker was not started."
                        });
                        continue;
                     }
                     const startupController = new AbortController();
                     pendingStartup.set(jobId, startupController);
                     const piSession = yield* Effect.onInterrupt(
                        Effect.promise(() =>
                           piBackendOpt.value
                              .spawnSession({
                                 jobId,
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
                                 runEffect: (eff) =>
                                    Effect.runPromise(Effect.provide(eff as Effect.Effect<any, any>, workerContext)),
                                 onOutput: onLiveOutput(jobId),
                                 onSystemPrompt: (systemPrompt) =>
                                    Effect.runPromise(
                                       updateRunningIfActive(jobId, { systemPrompt }, ownerSessionId)
                                    ).then(() => undefined),
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
                                          updateSettledIfActive(
                                             jobId,
                                             "completed",
                                             { resultData: data },
                                             ownerSessionId
                                          )
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
                              })
                              .catch((err) => {
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
                                    control: () =>
                                       Effect.fail(new ControlError({ message: "Session failed to initialize" }))
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
               }
               return registeredJobs;
            }).pipe(
               Effect.ensuring(
                  Effect.sync(() => {
                     if (!skipSlot) {
                        reservedAgentSlots = Math.max(0, reservedAgentSlots - incomingCount);
                     }
                  })
               )
            );
         });

         const spawnWorker = Effect.fn("WorkerManager.spawnWorker")(function* (
            spec: WorkerSpec,
            options?: WorkerManagerSpawnOptions
         ) {
            const batch = yield* spawnBatch([spec], options);
            return batch[0];
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
               return yield* new ControlError({ message: `Job ${id} has no active backend session` });
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

         const disposeSessions = (preserveCompleted: boolean) =>
            Effect.gen(function* () {
               for (const [id, startup] of Array.from(pendingStartup.entries())) {
                  startup.abort();
                  pendingStartup.delete(id);
                  yield* updateSettledIfActive(id, "cancelled").pipe(Effect.ignore);
               }
               for (const [id, session] of Array.from(activeSessions.entries())) {
                  const job = yield* registry.get(id);
                  if (
                     preserveCompleted &&
                     (job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled")
                  ) {
                     clearActiveSession(id);
                     clearLiveOutput(id);
                     continue;
                  }
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

         const disposeAll = disposeSessions(true);
         const disposeAllSessions = disposeSessions(false);

         return WorkerManager.of({
            spawnWorker,
            spawnBatch,
            cancelJob,
            controlJob,
            reserveWorkerSeq,
            disposeAll,
            disposeAllSessions
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
