import { Context, Effect, Layer, Option } from "effect";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
   CapacityError,
   ConcurrencyLimitError,
   DuplicateTaskError,
   AgentProfileNotFoundError,
   ParentSessionActivationError,
   ControlError,
   formatTaskId,
   type Task,
   type AgentSpec,
   type ControlMode
} from "../domain.js";
import { TaskRegistry } from "./task-registry.js";
import { ParentSessionGate } from "./task-session.js";
import { getChildExtensionPathsForTools } from "../shared/child-session.ts";
import { formatUnknownAgentProfileError, resolveAgentProfile, type AgentProfile } from "./agent-profiles.js";
import type { InheritedModelIdentity, ProfileModelRegistry } from "./model-resolution.ts";
import {
   createAgentSessionFile,
   defaultAgentHerdrOps,
   launchExternalAgent,
   type ExternalAgentHandle,
   type ExternalAgentOutcome,
   type AgentHerdrOps,
   type AgentHerdrTab,
   type AgentSplitDirection
} from "../shared/agent-process.ts";
import { createAgentActivityState, getAgentActivityFile } from "../shared/agent-activity.ts";
import { RESTART_INTERRUPTED_ERROR } from "./task-persistence.js";
export const MAX_RUNNING_AGENTS = 4;

export interface AgentManagerSpawnOptions {
   ownerSessionId?: string;
   batchId?: string;
   batchSize?: number;
   modelRegistry?: ProfileModelRegistry<any>;
   inheritedModel?: InheritedModelIdentity;
   parentSessionFile?: string;
   useHerdr?: boolean;
   herdrOps?: AgentHerdrOps;
   resumeTasks?: ReadonlyArray<Task>;
   forceNewTab?: boolean;
}

export interface ActiveAgentSession {
   readonly abort: () => Effect.Effect<void, any>;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, any>;
   readonly stopWatching: Effect.Effect<void>;
}

interface SpawnAgentOptions {
   readonly taskId: string;
   readonly displayName: string;
   readonly prompt?: string;
   readonly preserveSessionModel?: boolean;
   readonly cwd: string;
   readonly agentDef: Pick<AgentProfile, "name" | "systemPrompt" | "body" | "model" | "thinking" | "tools">;
   readonly specThinking?: string;
   readonly specTools?: readonly string[];
   readonly inheritedModel?: InheritedModelIdentity;
   readonly useHerdr?: boolean;
   readonly herdrOps?: AgentHerdrOps;
   readonly existingPaneId?: string;
   readonly splitFromPaneId?: string;
   readonly splitDirection?: AgentSplitDirection;
   readonly sessionFile: string;
   readonly onActivity: (activity: ReturnType<typeof createAgentActivityState>) => void;
   readonly onRecoverableError: (message: string) => void;
}

function modelArgument(
   agentDef: Pick<AgentProfile, "model">,
   inheritedModel?: InheritedModelIdentity
): string | undefined {
   if (agentDef.model) return agentDef.model;
   return inheritedModel ? `${inheritedModel.provider}/${inheritedModel.id}` : undefined;
}

function profileSystemPrompt(agentDef: Pick<AgentProfile, "systemPrompt" | "body">): string | undefined {
   const prompt = agentDef.systemPrompt ?? agentDef.body;
   return typeof prompt === "string" && prompt.trim().length > 0 ? prompt : undefined;
}

function outcomeError(error: unknown): ExternalAgentOutcome {
   return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
      aborted: false,
      sessionFile: "",
      activityFile: "",
      stats: { cost: 0, toolCalls: 0, contextTokens: 0 }
   };
}

const RESUME_CONTINUE_PROMPT = "Continue the work pls";
function statusForOutcome(outcome: ExternalAgentOutcome): "completed" | "failed" | "cancelled" {
   if (outcome.aborted) return "cancelled";
   return outcome.ok ? "completed" : "failed";
}

function controlFor(handle: ExternalAgentHandle): ActiveAgentSession {
   return {
      abort: () => Effect.promise(() => handle.abort()),
      control: (text) =>
         Effect.tryPromise({
            try: () => handle.control(text),
            catch: (error) => new ControlError({ message: error instanceof Error ? error.message : String(error) })
         }),
      stopWatching: Effect.sync(handle.stopWatching)
   };
}

async function launchAgent(options: SpawnAgentOptions): Promise<ExternalAgentHandle> {
   const tools = options.specTools ?? options.agentDef.tools ?? [];
   return launchExternalAgent({
      id: options.taskId,
      name: options.displayName,
      prompt: options.prompt,
      cwd: options.cwd,
      sessionFile: options.sessionFile,
      activityFile: getAgentActivityFile(options.sessionFile),
      tools,
      systemPrompt: profileSystemPrompt(options.agentDef),
      model: options.preserveSessionModel ? undefined : modelArgument(options.agentDef, options.inheritedModel),
      thinking: options.preserveSessionModel ? undefined : (options.specThinking ?? options.agentDef.thinking),
      additionalExtensionPaths: getChildExtensionPathsForTools(tools, getAgentDir()),
      useHerdr: options.useHerdr,
      herdrOps: options.herdrOps,
      existingPaneId: options.existingPaneId,
      splitFromPaneId: options.splitFromPaneId,
      splitDirection: options.splitDirection,
      onActivity: options.onActivity,
      onRecoverableError: options.onRecoverableError
   });
}

export interface AgentManagerShape {
   readonly spawnBatch: (
      specs: ReadonlyArray<AgentSpec>,
      options?: AgentManagerSpawnOptions
   ) => Effect.Effect<
      ReadonlyArray<Task>,
      | CapacityError
      | ConcurrencyLimitError
      | AgentProfileNotFoundError
      | DuplicateTaskError
      | ParentSessionActivationError
   >;
   readonly cancelTask: (id: string) => Effect.Effect<Task | undefined>;
   /** Clear pane bindings whose Herdr pane no longer exists. Returns pruned tasks. */
   readonly pruneClosedPanes: () => Effect.Effect<number>;
   /** Close panes for this owner's terminal runtime-owned agent tasks. */
   readonly closeSettledPanes: (ownerSessionId: string) => Effect.Effect<number>;
   /** Record that the parent received these settled results. Returns newly marked ids. */
   readonly markResultsDelivered: (ids: Iterable<string>) => Effect.Effect<ReadonlyArray<string>>;
   readonly cancelActiveSessions: Effect.Effect<void>;
   readonly resumeInterruptedTasks: (ownerSessionId: string) => Effect.Effect<ReadonlyArray<Task>, any>;
}

export class AgentManager extends Context.Service<AgentManager, AgentManagerShape>()("agents/AgentManager") {
   static readonly layer = Layer.effect(
      AgentManager,
      Effect.gen(function* () {
         const registry = yield* TaskRegistry;

         let reservedAgentSlots = 0;
         const activeSessions = new Map<string, ActiveAgentSession>();
         const activeSessionOwners = new Map<string, string>();
         const pendingStartup = new Map<string, AbortController>();
         let lastHerdrOps: AgentHerdrOps | undefined;
         const clearActiveSession = (taskId: string, ownerSessionId?: string) => {
            if (ownerSessionId !== undefined && activeSessionOwners.get(taskId) !== ownerSessionId) return;
            activeSessions.delete(taskId);
            activeSessionOwners.delete(taskId);
         };

         const isTerminalStatus = (status: Task["status"]) =>
            status === "completed" || status === "failed" || status === "cancelled";
         const isSettledStatus = (status: Task["status"]) => isTerminalStatus(status);

         const updateRunningIfActive = (taskId: string, patch: Partial<Task>, ownerSessionId?: string) =>
            Effect.gen(function* () {
               const current = yield* registry.get(taskId);
               const recovering =
                  current?.status === "failed" &&
                  (patch.activity?.phase === "starting" || patch.activity?.phase === "active");
               if (
                  !current ||
                  (ownerSessionId !== undefined && current.ownerSessionId !== ownerSessionId) ||
                  (isSettledStatus(current.status) && !recovering)
               )
                  return current;
               return yield* registry.updateStatus(
                  taskId,
                  "running",
                  recovering
                     ? { ...patch, resultData: undefined, errorText: undefined, recoveryPending: undefined }
                     : patch
               );
            });

         const updateSettledIfActive = (
            taskId: string,
            status: "completed" | "failed" | "cancelled",
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

         const settleExternalAgent = async (
            taskId: string,
            ownerSessionId: string,
            outcome: ExternalAgentOutcome
         ): Promise<void> => {
            await Effect.runPromise(
               Effect.gen(function* () {
                  const current = yield* registry.get(taskId);
                  if (!current || current.ownerSessionId !== ownerSessionId) return;
                  if (current.recoveryPending === true) {
                     clearActiveSession(taskId, ownerSessionId);
                     return;
                  }
                  clearActiveSession(taskId, ownerSessionId);
                  const resultStatus = statusForOutcome(outcome);
                  if (resultStatus === "completed") {
                     yield* updateSettledIfActive(
                        taskId,
                        "completed",
                        {
                           resultData: outcome.output.length > 0 ? outcome.output : undefined,
                           sessionFile: outcome.sessionFile || current.sessionFile,
                           sessionId: outcome.sessionId ?? current.sessionId,
                           usage: outcome.stats,
                           recoveryPending: undefined
                        },
                        ownerSessionId
                     );
                     return;
                  }
                  yield* updateSettledIfActive(
                     taskId,
                     resultStatus,
                     {
                        errorText: outcome.error,
                        sessionFile: outcome.sessionFile || current.sessionFile,
                        sessionId: outcome.sessionId ?? current.sessionId,
                        usage: outcome.stats,
                        recoveryPending: undefined
                     },
                     ownerSessionId
                  );
               })
            );
         };

         const attachCompletion = (taskId: string, ownerSessionId: string, handle: ExternalAgentHandle) =>
            handle.completion
               .then((outcome) => settleExternalAgent(taskId, ownerSessionId, outcome))
               .catch((error) =>
                  settleExternalAgent(taskId, ownerSessionId, {
                     ...outcomeError(error),
                     sessionFile: handle.metadata.sessionFile,
                     activityFile: handle.metadata.activityFile
                  })
               );

         const spawnBatch = Effect.fn("AgentManager.spawnBatch")(function* (
            specs: ReadonlyArray<AgentSpec>,
            options?: AgentManagerSpawnOptions
         ) {
            const gateOpt = yield* Effect.serviceOption(ParentSessionGate);
            if (Option.isSome(gateOpt)) yield* gateOpt.value.awaitReady();

            const incomingCount = specs.length;
            const ownerSessionId = options?.ownerSessionId ?? "parent";
            lastHerdrOps = options?.herdrOps ?? defaultAgentHerdrOps;
            for (const spec of specs) {
               const targetProfile = spec.profile.trim();
               if (!targetProfile) {
                  return yield* new AgentProfileNotFoundError({
                     message: formatUnknownAgentProfileError(targetProfile, spec.cwd ?? process.cwd()),
                     profile: "<missing>"
                  });
               }
               if (!resolveAgentProfile(targetProfile, spec.cwd ?? process.cwd())) {
                  return yield* new AgentProfileNotFoundError({
                     message: formatUnknownAgentProfileError(targetProfile, spec.cwd ?? process.cwd()),
                     profile: targetProfile
                  });
               }
            }

            const runningCount = (yield* registry.list({ status: "running" })).length;
            if (runningCount + reservedAgentSlots + incomingCount > MAX_RUNNING_AGENTS) {
               return yield* new ConcurrencyLimitError({
                  message: `Concurrency limit exceeded. Maximum ${MAX_RUNNING_AGENTS} concurrent agents allowed.`,
                  limit: MAX_RUNNING_AGENTS
               });
            }

            const spawnedTaskIds: string[] = [];
            const abortSpawnedSessions = Effect.gen(function* () {
               for (const taskId of spawnedTaskIds) {
                  const startup = pendingStartup.get(taskId);
                  if (startup) {
                     startup.abort();
                     pendingStartup.delete(taskId);
                  }
                  const active = activeSessions.get(taskId);
                  if (active) yield* active.abort().pipe(Effect.ignore);
                  clearActiveSession(taskId, ownerSessionId);
                  yield* updateSettledIfActive(taskId, "cancelled", undefined, ownerSessionId).pipe(Effect.ignore);
               }
            });
            reservedAgentSlots += incomingCount;
            const ops = options?.herdrOps ?? defaultAgentHerdrOps;
            let batchTab: AgentHerdrTab | undefined;
            let prevTabPaneId: string | undefined;
            const shouldManageHerdrLayout =
               options?.forceNewTab === true ||
               incomingCount > 1 ||
               (incomingCount === 1 && ops.currentTabPaneCount !== undefined);
            const herdrUsable = shouldManageHerdrLayout && options?.useHerdr !== false && ops.available();
            if ((incomingCount > 1 || options?.forceNewTab === true) && herdrUsable) {
               try {
                  batchTab = ops.createTab(`agents ${options?.batchId ?? "batch"}`, specs[0].cwd ?? process.cwd());
                  prevTabPaneId = batchTab.rootPaneId;
               } catch {
                  batchTab = undefined;
                  prevTabPaneId = undefined;
               }
            }
            if (incomingCount === 1 && herdrUsable && ops.currentTabPaneCount) {
               let paneCount: number | undefined;
               try {
                  paneCount = ops.currentTabPaneCount();
               } catch {
                  paneCount = undefined;
               }
               if (paneCount === undefined || paneCount > 1) {
                  try {
                     batchTab = ops.createTab(`agents ${options?.batchId ?? "batch"}`, specs[0].cwd ?? process.cwd());
                     prevTabPaneId = batchTab.rootPaneId;
                  } catch {
                     batchTab = undefined;
                     prevTabPaneId = undefined;
                  }
               }
            }
            return yield* Effect.gen(function* () {
               const settlements: Array<Promise<void>> = [];
               const registeredTasks: Task[] = [];
               for (const [index, spec] of specs.entries()) {
                  const resumedTask = options?.resumeTasks?.[index];
                  const taskId = resumedTask?.id ?? formatTaskId();
                  const targetProfile = spec.profile.trim();
                  let agentDef = resolveAgentProfile(targetProfile, spec.cwd ?? resumedTask?.cwd ?? process.cwd());
                  if (!agentDef) {
                     return yield* new AgentProfileNotFoundError({
                        message: formatUnknownAgentProfileError(
                           targetProfile,
                           spec.cwd ?? resumedTask?.cwd ?? process.cwd()
                        ),
                        profile: targetProfile
                     });
                  }
                  if (spec.systemPrompt !== undefined || spec.tools !== undefined || spec.thinking !== undefined) {
                     agentDef = {
                        ...agentDef,
                        ...(spec.systemPrompt === undefined ? {} : { systemPrompt: spec.systemPrompt }),
                        ...(spec.tools === undefined ? {} : { tools: spec.tools }),
                        ...(spec.thinking === undefined ? {} : { thinking: spec.thinking as AgentProfile["thinking"] })
                     };
                  }

                  const sessionFile =
                     resumedTask?.sessionFile ??
                     createAgentSessionFile({
                        id: taskId,
                        parentSessionFile: options?.parentSessionFile,
                        agentDir: getAgentDir()
                     });
                  const task =
                     resumedTask ??
                     (yield* registry.register({
                        id: taskId,
                        ownerSessionId,
                        name: spec.name ?? taskId,
                        profile: targetProfile,
                        model: agentDef.model,
                        thinking: spec.thinking ?? agentDef.thinking,
                        cwd: spec.cwd ?? process.cwd(),
                        context: spec.context,
                        batchId: options?.batchId,
                        batchSize: options?.batchSize,
                        promptOrCommand: spec.task,
                        sessionFile,
                        activity: createAgentActivityState(taskId),
                        runtimeOwned: true
                     }));
                  const runningTask = yield* registry.updateStatus(
                     task.id,
                     "running",
                     resumedTask
                        ? {
                             resultData: undefined,
                             errorText: undefined,
                             recoveryPending: undefined,
                             paneClosed: undefined,
                             startedAt: Date.now(),
                             settledAt: undefined,
                             runtimeOwned: true,
                             resumeWithPrompt: undefined
                          }
                        : undefined
                  );
                  registeredTasks.push(runningTask);
                  spawnedTaskIds.push(taskId);

                  const startupController = new AbortController();
                  let latestActivitySequence = -1;
                  let latestActivityCreatedAt: number | undefined;
                  let recoverableErrorSequence = -1;
                  let recoverableErrorCreatedAt: number | undefined;
                  pendingStartup.set(taskId, startupController);
                  const launched = yield* Effect.promise(async () => {
                     try {
                        const handle = await launchAgent({
                           taskId,
                           displayName: resumedTask?.name ?? spec.name ?? taskId,
                           prompt: resumedTask?.resumeWithPrompt
                              ? RESUME_CONTINUE_PROMPT
                              : resumedTask
                                ? undefined
                                : spec.task,
                           cwd: resumedTask?.cwd ?? spec.cwd ?? process.cwd(),
                           agentDef,
                           specThinking: spec.thinking,
                           specTools: spec.tools,
                           preserveSessionModel: resumedTask !== undefined,
                           inheritedModel: options?.inheritedModel,
                           useHerdr: options?.useHerdr,
                           herdrOps: ops,
                           existingPaneId: index === 0 ? prevTabPaneId : undefined,
                           splitFromPaneId: index === 0 ? undefined : prevTabPaneId,
                           splitDirection: "right",
                           sessionFile,
                           onActivity: (activity) => {
                              const generationChanged =
                                 latestActivityCreatedAt !== undefined &&
                                 activity.createdAt !== latestActivityCreatedAt;
                              if (generationChanged) {
                                 latestActivitySequence = -1;
                                 recoverableErrorSequence = -1;
                                 recoverableErrorCreatedAt = undefined;
                              }
                              latestActivityCreatedAt = activity.createdAt;
                              latestActivitySequence = Math.max(latestActivitySequence, activity.sequence);
                              if (
                                 recoverableErrorCreatedAt === activity.createdAt &&
                                 activity.sequence <= recoverableErrorSequence
                              )
                                 return;
                              void Effect.runPromise(updateRunningIfActive(taskId, { activity }, ownerSessionId)).catch(
                                 () => {}
                              );
                           },
                           onRecoverableError: (error) => {
                              recoverableErrorSequence = latestActivitySequence;
                              recoverableErrorCreatedAt = latestActivityCreatedAt;
                              void Effect.runPromise(
                                 updateSettledIfActive(taskId, "failed", { errorText: error }, ownerSessionId)
                              ).catch(() => {});
                           }
                        });
                        return { handle } as const;
                     } catch (error) {
                        return { error: error instanceof Error ? error.message : String(error) } as const;
                     }
                  });
                  pendingStartup.delete(taskId);

                  if ("error" in launched) {
                     yield* updateSettledIfActive(taskId, "failed", { errorText: launched.error }, ownerSessionId).pipe(
                        Effect.ignore
                     );
                     continue;
                  }
                  if (startupController.signal.aborted) {
                     yield* Effect.promise(() => launched.handle.abort()).pipe(Effect.ignore);
                     yield* updateSettledIfActive(taskId, "cancelled", undefined, ownerSessionId).pipe(Effect.ignore);
                     continue;
                  }

                  const handle = launched.handle;
                  if (batchTab && handle.metadata.paneId) prevTabPaneId = handle.metadata.paneId;
                  activeSessions.set(taskId, controlFor(handle));
                  activeSessionOwners.set(taskId, ownerSessionId);
                  settlements.push(attachCompletion(taskId, ownerSessionId, handle));
                  yield* updateRunningIfActive(
                     taskId,
                     {
                        sessionFile: handle.metadata.sessionFile,
                        model: handle.metadata.model ?? task.model,
                        thinking: handle.metadata.thinking ?? task.thinking,
                        systemPrompt: handle.metadata.systemPrompt,
                        paneId: handle.metadata.paneId
                     },
                     ownerSessionId
                  );
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

         const cancelTask = Effect.fn("AgentManager.cancelTask")(function* (id: string) {
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
            const current = yield* registry.get(id);
            if (current && isTerminalStatus(current.status)) return current;
            return yield* registry.updateStatus(id, "cancelled", { paneId: undefined, recoveryPending: undefined });
         });
         const pruneClosedPanes = Effect.fn("AgentManager.pruneClosedPanes")(function* () {
            const ops = lastHerdrOps;
            if (!ops) return 0;
            try {
               if (!ops.available()) return 0;
            } catch {
               return 0;
            }
            const tasks = yield* registry.list();
            const paneIds = new Set<string>();
            for (const task of tasks) {
               if (task.status !== "cancelled" && task.paneId) paneIds.add(task.paneId);
            }
            let pruned = 0;
            for (const paneId of paneIds) {
               const state = yield* Effect.promise(() => ops.inspectPane(paneId)).pipe(
                  Effect.catch(() => Effect.succeed("unavailable" as const))
               );
               if (state !== "missing") continue;
               for (const task of tasks) {
                  if (task.paneId !== paneId) continue;
                  const current = yield* registry.get(task.id);
                  if (!current || current.paneId !== paneId) continue;
                  yield* registry
                     .updateStatus(task.id, current.status, { paneId: undefined, paneClosed: true })
                     .pipe(Effect.ignore);
                  pruned += 1;
               }
            }
            return pruned;
         });

         const closeSettledPanes = Effect.fn("AgentManager.closeSettledPanes")(function* (ownerSessionId: string) {
            const ops = lastHerdrOps ?? defaultAgentHerdrOps;
            try {
               if (!ops.available()) return 0;
            } catch {
               return 0;
            }
            const parentPaneId = process.env.HERDR_PANE_ID;
            const tasks = yield* registry.list();
            let closed = 0;
            for (const task of tasks) {
               if (
                  task.ownerSessionId !== ownerSessionId ||
                  task.runtimeOwned !== true ||
                  !task.paneId ||
                  task.paneId === parentPaneId ||
                  !isTerminalStatus(task.status)
               )
                  continue;
               const didClose = yield* Effect.try({
                  try: () => {
                     ops.closePane(task.paneId!);
                     return true;
                  },
                  catch: (error) => error
               }).pipe(Effect.catch(() => Effect.succeed(false)));
               if (!didClose) continue;
               const current = yield* registry.get(task.id);
               if (!current || current.paneId !== task.paneId || !isTerminalStatus(current.status)) continue;
               yield* registry
                  .updateStatus(current.id, current.status, { paneId: undefined, paneClosed: true })
                  .pipe(Effect.ignore);
               closed += 1;
            }
            return closed;
         });

         const markResultsDelivered = Effect.fn("AgentManager.markResultsDelivered")(function* (ids: Iterable<string>) {
            const marked: string[] = [];
            for (const id of ids) {
               const current = yield* registry.get(id);
               if (
                  !current ||
                  current.status === "cancelled" ||
                  !isTerminalStatus(current.status) ||
                  current.resultDelivered === true
               )
                  continue;
               const active = activeSessions.get(id);
               if (current.status === "failed" && active) {
                  yield* active.stopWatching.pipe(Effect.ignore);
                  clearActiveSession(id);
               }
               yield* registry.updateStatus(id, current.status, { resultDelivered: true, recoveryPending: undefined });
               marked.push(id);
            }
            return marked;
         });
         const cancelActiveSessions = Effect.gen(function* () {
            const tasks = yield* registry.list();
            for (const task of tasks) {
               if (task.status === "cancelled" || task.resultDelivered === true || task.recoveryPending === true)
                  continue;
               yield* registry.updateStatus(task.id, task.status, { recoveryPending: true }).pipe(Effect.ignore);
            }
            for (const [id, startup] of Array.from(pendingStartup.entries())) {
               startup.abort();
               pendingStartup.delete(id);
               yield* updateSettledIfActive(id, "failed", {
                  errorText: RESTART_INTERRUPTED_ERROR,
                  recoveryPending: true
               }).pipe(Effect.ignore);
            }
            for (const [id, session] of Array.from(activeSessions.entries())) {
               const current = yield* registry.get(id);
               if (current?.status === "pending" || current?.status === "running") {
                  yield* registry.updateStatus(id, "failed", {
                     errorText: RESTART_INTERRUPTED_ERROR,
                     recoveryPending: true,
                     resumeWithPrompt: current.status === "running" ? true : undefined
                  });
               } else if (current?.status === "failed") {
                  yield* registry.updateStatus(id, "failed", { recoveryPending: true });
               }
               yield* session.abort().pipe(Effect.ignore);
               clearActiveSession(id);
            }
            activeSessions.clear();
            activeSessionOwners.clear();
         });
         const resumeInterruptedTasks = Effect.fn("AgentManager.resumeInterruptedTasks")(function* (
            ownerSessionId: string
         ) {
            const tasks = yield* registry.list();
            const resumable = tasks.filter(
               (task) =>
                  task.ownerSessionId === ownerSessionId &&
                  task.status === "failed" &&
                  (task.recoveryPending === true ||
                     task.resumeWithPrompt === true ||
                     task.errorText === RESTART_INTERRUPTED_ERROR)
            );
            const resumed: Task[] = [];
            const restartGroups = new Map<string, Task[]>();
            for (const task of resumable) {
               const active = activeSessions.get(task.id);
               if (active) {
                  const ops = lastHerdrOps ?? defaultAgentHerdrOps;
                  if (task.paneId && ops.movePaneToNewTab) {
                     try {
                        if (ops.available()) ops.movePaneToNewTab(task.paneId, task.name ?? task.id);
                     } catch {
                        // Keep the live session usable when Herdr cannot move its pane.
                     }
                  }
                  if (task.resumeWithPrompt === true) {
                     yield* active.control(RESUME_CONTINUE_PROMPT, "steer");
                     resumed.push(
                        yield* registry.updateStatus(task.id, "running", {
                           errorText: undefined,
                           resultData: undefined,
                           recoveryPending: undefined,
                           resumeWithPrompt: undefined,
                           paneClosed: undefined,
                           runtimeOwned: true
                        })
                     );
                  } else {
                     resumed.push(
                        yield* registry.updateStatus(task.id, task.status, {
                           paneClosed: undefined,
                           runtimeOwned: true
                        })
                     );
                  }
                  continue;
               }
               if (!task.sessionFile || !existsSync(task.sessionFile)) continue;
               const key = task.batchId ?? task.id;
               const group = restartGroups.get(key) ?? [];
               group.push(task);
               restartGroups.set(key, group);
            }
            for (const group of restartGroups.values()) {
               const batchId = group[0]?.batchId;
               const spawned = yield* spawnBatch(
                  group.map((task) => ({
                     task: task.promptOrCommand,
                     name: task.name ?? task.id,
                     profile: task.profile ?? "worker",
                     thinking: task.thinking,
                     cwd: task.cwd
                  })),
                  {
                     ownerSessionId,
                     batchId,
                     batchSize: group[0]?.batchSize ?? group.length,
                     resumeTasks: group,
                     herdrOps: lastHerdrOps,
                     forceNewTab: true
                  }
               );
               resumed.push(...spawned);
            }
            return resumed;
         });

         return AgentManager.of({
            spawnBatch,
            cancelTask,
            pruneClosedPanes,
            closeSettledPanes,
            markResultsDelivered,
            cancelActiveSessions,
            resumeInterruptedTasks
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: AgentManagerShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | AgentManager> {
      return Effect.gen(function* () {
         const svc = yield* AgentManager;
         return yield* fn(svc);
      });
   }
}
