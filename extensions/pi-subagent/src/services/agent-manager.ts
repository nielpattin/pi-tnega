import { Context, Effect, Layer, Option } from "effect";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

export const MAX_RUNNING_AGENTS = 4;

export interface AgentManagerSpawnOptions {
   ownerSessionId?: string;
   batchId?: string;
   batchSize?: number;
   modelRegistry?: ProfileModelRegistry<any>;
   inheritedModel?: InheritedModelIdentity;
   parentSessionFile?: string;
   background?: boolean;
   useHerdr?: boolean;
   herdrOps?: AgentHerdrOps;
}

export interface ActiveAgentSession {
   readonly abort: () => Effect.Effect<void, any>;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, any>;
}

interface SpawnAgentOptions {
   readonly taskId: string;
   readonly displayName: string;
   readonly prompt: string;
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
         })
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
      model: modelArgument(options.agentDef, options.inheritedModel),
      thinking: options.specThinking ?? options.agentDef.thinking,
      additionalExtensionPaths: getChildExtensionPathsForTools(tools, getAgentDir()),
      useHerdr: options.useHerdr,
      herdrOps: options.herdrOps,
      existingPaneId: options.existingPaneId,
      splitFromPaneId: options.splitFromPaneId,
      splitDirection: options.splitDirection,
      onActivity: options.onActivity
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
                           usage: outcome.stats
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
                        usage: outcome.stats
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
               incomingCount > 1 || (incomingCount === 1 && ops.currentTabPaneCount !== undefined);
            const herdrUsable = shouldManageHerdrLayout && options?.useHerdr !== false && ops.available();
            if (incomingCount > 1 && herdrUsable) {
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
                  const taskId = formatTaskId();
                  const targetProfile = spec.profile.trim();
                  let agentDef = resolveAgentProfile(targetProfile, spec.cwd ?? process.cwd());
                  if (!agentDef) {
                     return yield* new AgentProfileNotFoundError({
                        message: formatUnknownAgentProfileError(targetProfile, spec.cwd ?? process.cwd()),
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

                  const sessionFile = createAgentSessionFile({
                     id: taskId,
                     parentSessionFile: options?.parentSessionFile,
                     agentDir: getAgentDir()
                  });
                  const task = yield* registry.register({
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
                     background: options?.background === true,
                     sessionFile,
                     activity: createAgentActivityState(taskId),
                     runtimeOwned: true
                  });
                  const runningTask = yield* registry.updateStatus(task.id, "running");
                  registeredTasks.push(runningTask);
                  spawnedTaskIds.push(taskId);

                  const startupController = new AbortController();
                  pendingStartup.set(taskId, startupController);
                  const launched = yield* Effect.promise(async () => {
                     try {
                        const handle = await launchAgent({
                           taskId,
                           displayName: spec.name ?? taskId,
                           prompt: spec.task,
                           cwd: spec.cwd ?? process.cwd(),
                           agentDef,
                           specThinking: spec.thinking,
                           specTools: spec.tools,
                           inheritedModel: options?.inheritedModel,
                           useHerdr: options?.useHerdr,
                           herdrOps: ops,
                           existingPaneId: index === 0 ? prevTabPaneId : undefined,
                           splitFromPaneId: index === 0 ? undefined : prevTabPaneId,
                           splitDirection: "right",
                           sessionFile,
                           onActivity: (activity) => {
                              void Effect.runPromise(updateRunningIfActive(taskId, { activity }, ownerSessionId)).catch(
                                 () => {}
                              );
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

               if (options?.background !== true) {
                  yield* Effect.promise(() => Promise.all(settlements)).pipe(Effect.ignore);
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
            return yield* registry.updateStatus(id, "cancelled", { paneId: undefined });
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
               yield* registry.updateStatus(id, current.status, { resultDelivered: true });
               marked.push(id);
            }
            return marked;
         });
         const cancelActiveSessions = Effect.gen(function* () {
            for (const [id, startup] of Array.from(pendingStartup.entries())) {
               startup.abort();
               pendingStartup.delete(id);
               yield* updateSettledIfActive(id, "cancelled").pipe(Effect.ignore);
            }
            for (const [id, session] of Array.from(activeSessions.entries())) {
               yield* session.abort().pipe(Effect.ignore);
               yield* updateSettledIfActive(id, "cancelled").pipe(Effect.ignore);
               clearActiveSession(id);
            }
            activeSessions.clear();
            activeSessionOwners.clear();
         });

         return AgentManager.of({
            spawnBatch,
            cancelTask,
            pruneClosedPanes,
            closeSettledPanes,
            markResultsDelivered,
            cancelActiveSessions
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
