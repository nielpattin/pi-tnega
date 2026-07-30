import { Context, Effect, Layer, Option, Predicate } from "effect";
import {
   CapacityError,
   ConcurrencyLimitError,
   AgentNotFoundError,
   ControlError,
   SchemaConversionError,
   DuplicateJobError,
   ParentSessionActivationError,
   formatJobId,
   resolveHarness,
   type Job,
   type TaskSpec,
   type ControlMode,
   type JobTranscriptEntry
} from "../domain.js";
import { JobRegistry } from "./JobRegistry.js";
import { ParentSessionGate } from "./ParentSessionGate.js";
import { AgentsStore } from "./AgentsStore.js";
import { SchemaValidator } from "./SchemaValidator.js";
import { AgyBackend, type AgyOneShotResult } from "../backends/agy.js";
import { PiBackend } from "../backends/pi.js";
import type { InheritedModelInfo, ModelRegistryLike } from "../backends/pi-model.js";
import { readAgyTranscriptRecords, type AcpDecodedEvent } from "../utils/acp-decoder.js";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_RUNNING_AGENTS = 4;

function completePiResult(
   submitted: unknown,
   transcript: ReadonlyArray<JobTranscriptEntry> | undefined,
   outputSchema: unknown
): unknown {
   if (outputSchema !== undefined) return submitted;
   let detailed: Extract<JobTranscriptEntry, { readonly type: "assistant" }> | undefined;
   if (transcript) {
      for (let index = transcript.length - 1; index >= 0; index--) {
         const entry = transcript[index];
         if (entry?.type === "assistant" && entry.text.trim().length > 0) {
            detailed = entry;
            break;
         }
      }
   }
   if (!detailed) return submitted;
   const fullText = detailed.text.trim();
   if (typeof submitted === "string") {
      const submittedText = submitted.trim();
      const refersElsewhere =
         /\b(above|previous (?:response|prose)|worker transcript|details? (?:above|earlier))\b/i.test(submittedText);
      if (refersElsewhere || (submittedText.length < 500 && fullText.length > submittedText.length * 2))
         return fullText;
      return submitted;
   }
   if (submitted === undefined || submitted === null) return fullText;
   if (Predicate.isObject(submitted) && !Array.isArray(submitted)) {
      const serialized = JSON.stringify(submitted);
      const hasDetail = "details" in submitted || "report" in submitted || "result" in submitted;
      if (!hasDetail && serialized.length < 500 && fullText.length > serialized.length * 2) {
         return { ...submitted, details: fullText };
      }
   }
   return submitted;
}

export interface TaskManagerSpawnOptions {
   ownerSessionId?: string;
   origin?: "standard" | "vibe" | "btw";
   skipAgentSlot?: boolean;
   modelRegistry?: ModelRegistryLike;
   inheritedModel?: InheritedModelInfo;
   parentSessionFile?: string;
}

export interface ActiveBackendSession {
   readonly abort: () => Effect.Effect<void, any>;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, any>;
}

export interface TaskManagerShape {
   readonly spawnTask: (
      spec: TaskSpec,
      options?: TaskManagerSpawnOptions
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
      specs: ReadonlyArray<TaskSpec>,
      options?: TaskManagerSpawnOptions
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
   readonly reserveTaskSeq: (maxRecoveredSeq: number) => Effect.Effect<void>;
   readonly disposeAll: Effect.Effect<void>;
}

export class TaskManager extends Context.Service<TaskManager, TaskManagerShape>()("harbor/TaskManager") {
   static readonly layer = Layer.effect(
      TaskManager,
      Effect.gen(function* () {
         const registry = yield* JobRegistry;
         const agentsStoreOpt = yield* Effect.serviceOption(AgentsStore);
         const schemaValidatorOpt = yield* Effect.serviceOption(SchemaValidator);
         const agyBackendOpt = yield* Effect.serviceOption(AgyBackend);
         const piBackendOpt = yield* Effect.serviceOption(PiBackend);
         const workerContext = yield* Effect.context();

         let reservedAgentSlots = 0;
         let taskSeq = 0;
         const activeSessions = new Map<string, ActiveBackendSession>();

         // Throttled live-output writer. Persists the child's accumulated output
         // into Job.rawText while the job is still running so /tasks and the
         // takeover view can show progress before settlement. The status check
         // guards against a late chunk resurrecting an already-settled job.
         const LIVE_OUTPUT_INTERVAL_MS = 250;
         const liveOutputState = new Map<
            string,
            {
               lastWrite: number;
               timer?: ReturnType<typeof setTimeout>;
               rawText?: string;
               transcript?: ReadonlyArray<JobTranscriptEntry>;
            }
         >();
         const writeLiveOutput = (
            jobId: string,
            patch: { rawText?: string; transcript?: ReadonlyArray<JobTranscriptEntry> }
         ) => {
            Effect.runPromise(
               Effect.gen(function* () {
                  const job = yield* registry.get(jobId);
                  if (job?.status === "running") {
                     yield* registry.updateStatus(jobId, "running", patch);
                  }
               })
            ).catch(() => {});
         };
         const scheduleLiveOutput = (
            jobId: string,
            patch: { rawText?: string; transcript?: ReadonlyArray<JobTranscriptEntry> }
         ) => {
            const now = Date.now();
            let entry = liveOutputState.get(jobId);
            if (!entry) {
               entry = { lastWrite: 0 };
               liveOutputState.set(jobId, entry);
            }
            Object.assign(entry, patch);
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            const elapsed = now - entry.lastWrite;
            const writeLatest = () => {
               entry.lastWrite = Date.now();
               entry.timer = undefined;
               writeLiveOutput(jobId, { rawText: entry.rawText, transcript: entry.transcript });
            };
            if (elapsed >= LIVE_OUTPUT_INTERVAL_MS) {
               writeLatest();
            } else {
               entry.timer = setTimeout(writeLatest, LIVE_OUTPUT_INTERVAL_MS - elapsed);
            }
         };
         const onLiveOutput = (jobId: string) => (rawText: string) => scheduleLiveOutput(jobId, { rawText });
         const onLiveTranscript = (jobId: string) => (transcript: ReadonlyArray<JobTranscriptEntry>) =>
            scheduleLiveOutput(jobId, { transcript });
         const takeLiveOutput = (jobId: string) => {
            const entry = liveOutputState.get(jobId);
            if (entry?.timer !== undefined) clearTimeout(entry.timer);
            liveOutputState.delete(jobId);
            return { rawText: entry?.rawText, transcript: entry?.transcript };
         };
         const clearLiveOutput = (jobId: string) => {
            takeLiveOutput(jobId);
         };

         const spawnBatch = Effect.fn("TaskManager.spawnBatch")(function* (
            specs: ReadonlyArray<TaskSpec>,
            options?: TaskManagerSpawnOptions
         ) {
            const gateOpt = yield* Effect.serviceOption(ParentSessionGate);
            if (Option.isSome(gateOpt)) {
               yield* gateOpt.value.awaitReady();
            }

            const incomingCount = specs.length;
            const skipSlot = options?.skipAgentSlot ?? false;
            const origin = options?.origin ?? "standard";

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

            return yield* Effect.uninterruptible(
               Effect.gen(function* () {
                  const registeredJobs: Job[] = [];
                  for (const spec of specs) {
                     taskSeq++;
                     const jobId = formatJobId(taskSeq);

                     let agentDef: any;
                     if (Option.isSome(agentsStoreOpt)) {
                        const targetAgent = spec.agent ?? "task";
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
                           model: spec.model ?? agentDef?.model,
                           thinking: spec.thinking ?? agentDef?.thinking,
                           tools: spec.tools ?? agentDef?.tools
                        };
                     }

                     if (spec.outputSchema && Option.isSome(schemaValidatorOpt)) {
                        yield* schemaValidatorOpt.value.convertSchema(spec.outputSchema);
                     }

                     const job = yield* registry.register({
                        id: jobId,
                        ownerSessionId: options?.ownerSessionId ?? "parent",
                        name: spec.name ?? jobId,
                        kind: "agent",
                        agent: spec.agent ?? "task",
                        async: spec.async === true,
                        model: spec.model ?? agentDef?.model,
                        thinking: spec.thinking ?? agentDef?.thinking,
                        cwd: spec.cwd ?? process.cwd(),
                        origin,
                        promptOrCommand: spec.task,
                        harness
                     });

                     const runningJob = yield* registry.updateStatus(job.id, "running");
                     registeredJobs.push(runningJob);

                     // Spawn child backend run
                     if (harness === "agy") {
                        if (Option.isNone(agyBackendOpt)) {
                           yield* registry.updateStatus(jobId, "failed", {
                              errorText: "Agy backend is unavailable. The task was not started."
                           });
                           continue;
                        }
                        const agyBackend = agyBackendOpt.value;
                        const logFilePath = join(tmpdir(), `harbor-agy-${process.pid}-${jobId}.log`);
                        let logOffset = 0;
                        const readLogChunk = async () => {
                           const text = await readFile(logFilePath, "utf8").catch(() => "");
                           const chunk = text.slice(logOffset);
                           logOffset = text.length;
                           return chunk;
                        };
                        const agyTranscript: JobTranscriptEntry[] = [];
                        let agyAssistantIndex: number | undefined;
                        const emitAgyTranscript = () => onLiveTranscript(jobId)([...agyTranscript]);
                        const onAgyOutput = (rawText: string) => {
                           const assistant: JobTranscriptEntry = { type: "assistant", text: rawText };
                           if (agyAssistantIndex === undefined) {
                              agyAssistantIndex = agyTranscript.length;
                              agyTranscript.push(assistant);
                           } else {
                              agyTranscript[agyAssistantIndex] = assistant;
                           }
                           scheduleLiveOutput(jobId, { rawText, transcript: [...agyTranscript] });
                        };
                        const appendAgyUserPrompt = (text: string) => {
                           agyTranscript.push({ type: "user", text });
                           agyAssistantIndex = undefined;
                           emitAgyTranscript();
                        };
                        const parsePreview = (preview: string | undefined): unknown => {
                           if (preview === undefined) return undefined;
                           try {
                              return JSON.parse(preview);
                           } catch {
                              return preview;
                           }
                        };
                        const onAgyEvent = (event: AcpDecodedEvent) => {
                           if (event._tag === "ToolStart") {
                              agyTranscript.push({
                                 type: "tool-call",
                                 toolCallId: event.toolCallId,
                                 toolName: event.toolName,
                                 arguments: parsePreview(event.argsPreview),
                                 timestamp: event.timestamp
                              });
                           } else if (event._tag === "ToolEnd") {
                              agyTranscript.push({
                                 type: "tool-result",
                                 toolCallId: event.toolCallId,
                                 toolName: event.toolName,
                                 content:
                                    event.resultPreview === undefined
                                       ? []
                                       : [{ type: "text", text: event.resultPreview }],
                                 isError: event.isError === true,
                                 timestamp: event.timestamp
                              });
                           } else {
                              return;
                           }
                           emitAgyTranscript();
                        };
                        const fsmSession = agyBackend.createFsmSession({
                           prompt: spec.task,
                           logFilePath,
                           readLogChunk,
                           readDb: readAgyTranscriptRecords,
                           onEvent: onAgyEvent,
                           model: spec.model ?? agentDef?.model,
                           effort: agentDef?.thinking,
                           cwd: spec.cwd ?? process.cwd(),
                           onOutput: onAgyOutput,
                           onSettled: (res: AgyOneShotResult) => {
                              const live = takeLiveOutput(jobId);
                              if (res.status === "completed") {
                                 Effect.runPromise(
                                    registry.updateStatus(jobId, "completed", {
                                       resultData: { data: res.finalText },
                                       rawText: res.rawText,
                                       transcript: live.transcript ?? [...agyTranscript]
                                    })
                                 ).catch(() => {});
                              } else if (res.status === "failed") {
                                 activeSessions.delete(jobId);
                                 Effect.runPromise(
                                    registry.updateStatus(jobId, "failed", {
                                       errorText: res.errorText,
                                       rawText: res.rawText,
                                       transcript: live.transcript ?? [...agyTranscript]
                                    })
                                 ).catch(() => {});
                              } else if (res.status === "cancelled") {
                                 activeSessions.delete(jobId);
                                 Effect.runPromise(registry.updateStatus(jobId, "cancelled")).catch(() => {});
                              }
                           }
                        });

                        activeSessions.set(jobId, {
                           abort: () => fsmSession.abort(),
                           control: (text, mode) => {
                              appendAgyUserPrompt(text);
                              return fsmSession.control(text, mode);
                           }
                        });

                        Effect.runPromise(fsmSession.start()).catch(() => {});
                     } else {
                        if (Option.isNone(piBackendOpt)) {
                           yield* registry.updateStatus(jobId, "failed", {
                              errorText: "Pi backend is unavailable. The task was not started."
                           });
                           continue;
                        }
                        const piSession = yield* Effect.promise(() =>
                           piBackendOpt.value
                              .spawnSession({
                                 jobId,
                                 sessionName: `task: ${spec.name ?? jobId} ${jobId}`,
                                 prompt: spec.task,
                                 cwd: spec.cwd ?? process.cwd(),
                                 parentSessionFile: options?.parentSessionFile,
                                 agentDef,
                                 specModel: spec.model,
                                 specThinking: spec.thinking,
                                 specTools: spec.tools,
                                 modelRegistry: options?.modelRegistry,
                                 inheritedModel: options?.inheritedModel,
                                 outputSchema: spec.outputSchema,
                                 runEffect: (eff) =>
                                    Effect.runPromise(Effect.provide(eff as Effect.Effect<any, any>, workerContext)),
                                 onOutput: onLiveOutput(jobId),
                                 onTranscript: onLiveTranscript(jobId),
                                 onSessionReady: (metadata) =>
                                    Effect.runPromise(
                                       registry.updateStatus(jobId, "running", {
                                          ...metadata,
                                          sessionFile: metadata.sessionFile,
                                          sessionId: metadata.sessionId
                                       })
                                    ).then(() => undefined),
                                 onSettled: (resStatus, data, errorText) => {
                                    activeSessions.delete(jobId);
                                    const live = takeLiveOutput(jobId);
                                    if (resStatus === "completed") {
                                       Effect.runPromise(
                                          registry.updateStatus(jobId, "completed", {
                                             resultData: completePiResult(data, live.transcript, spec.outputSchema),
                                             rawText: live.rawText,
                                             transcript: live.transcript
                                          })
                                       ).catch(() => {});
                                    } else if (resStatus === "failed") {
                                       Effect.runPromise(
                                          registry.updateStatus(jobId, "failed", {
                                             errorText: errorText ?? "Job failed",
                                             rawText: live.rawText,
                                             transcript: live.transcript
                                          })
                                       ).catch(() => {});
                                    } else if (resStatus === "cancelled") {
                                       Effect.runPromise(registry.updateStatus(jobId, "cancelled")).catch(() => {});
                                    }
                                 }
                              })
                              .catch((err) => {
                                 activeSessions.delete(jobId);
                                 clearLiveOutput(jobId);
                                 Effect.runPromise(
                                    registry.updateStatus(jobId, "failed", {
                                       errorText: err instanceof Error ? err.message : String(err)
                                    })
                                 ).catch(() => {});
                                 return {
                                    abort: () => Effect.void,
                                    control: () =>
                                       Effect.fail(new ControlError({ message: "Session failed to initialize" }))
                                 };
                              })
                        );

                        activeSessions.set(jobId, {
                           abort: () => piSession.abort(),
                           control: (text, mode) => piSession.control(text, mode)
                        });
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
               )
            );
         });

         const spawnTask = Effect.fn("TaskManager.spawnTask")(function* (
            spec: TaskSpec,
            options?: TaskManagerSpawnOptions
         ) {
            const batch = yield* spawnBatch([spec], options);
            return batch[0];
         });

         const cancelJob = Effect.fn("TaskManager.cancelJob")(function* (id: string) {
            const active = activeSessions.get(id);
            if (active) {
               yield* active.abort().pipe(Effect.ignore);
               activeSessions.delete(id);
            }
            clearLiveOutput(id);
            return yield* registry.updateStatus(id, "cancelled");
         });

         const controlJob = Effect.fn("TaskManager.controlJob")(function* (
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
                  errorText: undefined,
                  rawText: job.rawText
               });
               return yield* active.control(text, mode).pipe(
                  Effect.catch((error) =>
                     registry
                        .updateStatus(id, "completed", {
                           resultData: job.resultData,
                           errorText: job.errorText,
                           rawText: job.rawText
                        })
                        .pipe(Effect.flatMap(() => Effect.fail(error)))
                  )
               );
            }

            return yield* active.control(text, mode);
         });

         const reserveTaskSeq = Effect.fn("TaskManager.reserveTaskSeq")((maxRecoveredSeq: number) =>
            Effect.sync(() => {
               if (maxRecoveredSeq > taskSeq) {
                  taskSeq = maxRecoveredSeq;
               }
            })
         );

         const disposeAll = Effect.gen(function* () {
            for (const [id, session] of Array.from(activeSessions.entries())) {
               yield* session.abort().pipe(Effect.ignore);
               yield* registry.updateStatus(id, "cancelled").pipe(Effect.ignore);
               clearLiveOutput(id);
            }
            activeSessions.clear();
         });

         return TaskManager.of({
            spawnTask,
            spawnBatch,
            cancelJob,
            controlJob,
            reserveTaskSeq,
            disposeAll
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: TaskManagerShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | TaskManager> {
      return Effect.gen(function* () {
         const svc = yield* TaskManager;
         return yield* fn(svc);
      });
   }
}
