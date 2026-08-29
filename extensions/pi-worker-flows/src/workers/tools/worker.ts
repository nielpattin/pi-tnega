import { Effect } from "effect";
import { Type, type Static, type TSchema } from "typebox";
import { TaskRegistry } from "../services/task-registry.js";
import { WorkerManager } from "../services/worker-manager.js";
import {
   normalizeWorkerSpecs,
   prependContext,
   type Task,
   type TaskStatus,
   type TaskTranscriptEntry,
   type WorkerSpec
} from "../domain.js";
import type { AgentProfile } from "../../services/worker-profiles.ts";
import type { InheritedModelIdentity, ProfileModelRegistry } from "../../services/model-resolution.ts";

// -----------------------------------------------------------------------------
// Tool input
// -----------------------------------------------------------------------------

const TaskIdSchema = Type.String({
   minLength: 1,
   description: "Task ID returned by worker_spawn (for example task-1)."
});

/** Schema for one worker delegated by the parent session. */
export const WorkerSpecSchema = Type.Object({
   task: Type.String({
      description: [
         "Detailed task instruction prompt for the worker.",
         "State the expected outcome, scope, edit permission, and stop condition."
      ].join(" ")
   }),
   name: Type.String({
      description: "Required short worker name, for example investigate-copy-all."
   }),
   worker: Type.String({
      minLength: 1,
      description: "Required enabled worker profile name listed in the current worker_spawn tool metadata."
   })
});

const batchContextSchema = Type.Optional(
   Type.String({ description: "Context prepended to every worker prompt in the batch." })
);

function createBatchParamsSchema<const WorkerSchema extends TSchema>(workerSchema: WorkerSchema) {
   return Type.Object({
      context: batchContextSchema,
      workers: Type.Array(workerSchema, {
         minItems: 1,
         maxItems: 4,
         description: "One to four worker specifications."
      }),
      background: Type.Optional(
         Type.Boolean({
            description: "Return immediately while workers continue independently. Defaults to false."
         })
      )
   });
}

/** Schema for the batch input accepted by the worker tool. */
export const WorkerSpawnToolParamsSchema = createBatchParamsSchema(WorkerSpecSchema);

/** Typed input accepted by the worker tool. */
export type WorkerSpawnToolParams = Static<typeof WorkerSpawnToolParamsSchema>;

export function resolveWorkerBackground(background?: boolean): boolean {
   return background === true;
}

export const WorkerListToolParamsSchema = Type.Object({}, { description: "List worker tasks." });
export type WorkerListToolParams = Static<typeof WorkerListToolParamsSchema>;

export const WorkerCancelToolParamsSchema = Type.Object(
   {
      id: TaskIdSchema
   },
   { description: "Cancel a worker task by its task id." }
);
export type WorkerCancelToolParams = Static<typeof WorkerCancelToolParamsSchema>;

function createAgentProfileSchema(workerNames: readonly string[]) {
   const choices = workerNames.map((name) => Type.Literal(name));
   if (choices.length === 0) {
      return Type.Never({ description: "No worker profiles are available." });
   }
   if (choices.length === 1) {
      return choices[0];
   }
   return Type.Union(choices, {
      description: `Enabled worker profiles: ${workerNames.join(", ")}.`
   });
}

function createWorkerSpecSchema(workerNames: readonly string[]) {
   return Type.Object({
      ...WorkerSpecSchema.properties,
      worker: createAgentProfileSchema(workerNames)
   });
}

/**
 * Create the provider-facing worker schema with the enabled worker profiles as
 * the allowed values for each worker's `worker` field.
 */
export function createWorkerSpawnToolParamsSchema(workerNames: readonly string[]) {
   return createBatchParamsSchema(createWorkerSpecSchema(workerNames));
}

// -----------------------------------------------------------------------------
// Tool metadata
// -----------------------------------------------------------------------------

/** Description sent to the model with the worker spawn tool definition. */
export const WORKER_SPAWN_TOOL_BASE_DESCRIPTION = [
   "Spawn one or more workers.",
   'Use this input: { workers: [{ task: "prompt", name: "short-title", worker, ... }], context?, background? }.',
   "The workers array must contain 1 to 4 worker specifications.",
   "By default, the tool waits for all workers and returns their final results.",
   "Set background to true to return a spawned acknowledgement immediately while workers continue independently.",
   "Background worker results are delivered to the parent session automatically.",
   "The worker name is a display label. The returned task id is the worker identity.",
   "Each worker's `worker` field selects an enabled worker profile.",
   "When a worker fails, use worker_list to see its status and session file, then worker_recover to resume it in place; never re-spawn the same prompt."
].join(" ");

/** Short description shown in the available-tools section. */
export const WORKER_SPAWN_TOOL_BASE_PROMPT_SNIPPET =
   "Spawn 1 to 4 workers with { workers: [{ task, name, worker, ... }], context?, background? }.";

/** Static worker tool definition for callers that do not need dynamic profile names. */
export const workerSpawnToolDefinition = {
   name: "worker_spawn",
   description: WORKER_SPAWN_TOOL_BASE_DESCRIPTION,
   parameters: WorkerSpawnToolParamsSchema
};

/** Tool input for recovering one failed/stalled task in place. */
export const WorkerRecoverToolParamsSchema = Type.Object(
   {
      id: TaskIdSchema,
      note: Type.Optional(
         Type.String({
            description: "Optional instruction for the recovery turn, for example 'focus on the payment service first'."
         })
      )
   },
   { description: "Recover a failed worker by resuming its own session file." }
);
export type WorkerRecoverToolParams = Static<typeof WorkerRecoverToolParamsSchema>;

export const workerRecoverToolDefinition = {
   name: "worker_recover",
   label: "Worker Recover",
   description:
      "Resume a failed or stalled worker task in place. Reopens the worker's own persisted session (all reads and tool results are still there), sends one continuation turn, and waits for structured_output. Re-spawning is never needed.",
   parameters: WorkerRecoverToolParamsSchema
};

export const workerListToolDefinition = {
   name: "worker_list",
   label: "Worker List",
   description:
      "List worker tasks with status (running, completed, recoverable, failed, cancelled), error, and session file.",
   parameters: WorkerListToolParamsSchema
};

export const workerCancelToolDefinition = {
   name: "worker_cancel",
   label: "Worker Cancel",
   description: "Cancel a worker task by its task id.",
   parameters: WorkerCancelToolParamsSchema
};

// -----------------------------------------------------------------------------
// Worker-profile metadata
// -----------------------------------------------------------------------------

/** Metadata added to the worker tool for enabled worker profiles. */
export interface WorkerToolMetadataAugmentation {
   /** Names allowed in each worker's `worker` field. */
   readonly workerNames: ReadonlyArray<string>;
   /** Profile list appended to the tool description. */
   readonly descriptionAppendix: string;
}

/** Optional filter for the worker profiles advertised by the worker tool. */
export interface WorkerToolMetadataOptions {
   readonly allowedWorkerNames?: ReadonlyArray<string>;
}

type WorkerAgentProfile = Pick<AgentProfile, "name" | "description" | "enabled">;

function formatAgentProfile(agent: WorkerAgentProfile): string {
   const description = agent.description.trim();
   return description.length === 0 ? `  - ${agent.name}` : `  - ${agent.name}: ${description}`;
}

/**
 * Build the worker-tool metadata for enabled worker profiles.
 *
 * Worker bodies and disabled profiles are not exposed to the parent session.
 */
export function augmentWorkerToolMetadata(
   agents: ReadonlyArray<WorkerAgentProfile>,
   options?: WorkerToolMetadataOptions
): WorkerToolMetadataAugmentation {
   const allowedNames = options?.allowedWorkerNames;
   const allowed = allowedNames === undefined ? undefined : new Set(allowedNames);
   const enabledAgents = agents
      .filter((agent) => agent.enabled && (allowed === undefined || allowed.has(agent.name)))
      .toSorted((left, right) => left.name.localeCompare(right.name));

   if (enabledAgents.length === 0) {
      return {
         workerNames: [],
         descriptionAppendix: ""
      };
   }

   return {
      workerNames: enabledAgents.map((agent) => agent.name),
      descriptionAppendix: [
         "Enabled worker profiles for the current workspace:",
         ...enabledAgents.map(formatAgentProfile)
      ].join("\n")
   };
}

// -----------------------------------------------------------------------------
// Worker execution
// -----------------------------------------------------------------------------

/** Dependencies and parent-session information required to spawn workers. */
export interface HandleWorkerSpawnOptions {
   readonly ownerSessionId?: string;
   readonly modelRegistry?: ProfileModelRegistry<any>;
   readonly inheritedModel?: InheritedModelIdentity;
   readonly cwd?: string;
   readonly parentSessionFile?: string;
}

let workerBatchSequence = 0;

function createWorkerBatchId(): string {
   workerBatchSequence += 1;
   return `batch-${Date.now()}-${workerBatchSequence}`;
}

function prepareWorkerSpecs(input: WorkerSpawnToolParams, defaultCwd?: string): WorkerSpec[] {
   const workers = prependContext(normalizeWorkerSpecs(input), input.context).map((worker) => ({
      ...worker,
      context: input.context
   }));
   if (defaultCwd === undefined) {
      return workers;
   }

   return workers.map((worker) => (worker.cwd === undefined ? { ...worker, cwd: defaultCwd } : worker));
}

type WorkerAcknowledgementStatus = TaskStatus | "spawned";

type WorkerTaskSummary = {
   readonly id: string;
   readonly name: string;
   readonly worker: string | undefined;
   readonly status: WorkerAcknowledgementStatus;
   readonly result?: unknown;
   readonly errorText?: string;
   readonly sessionFile?: string;
};

type WorkerToolResult =
   | {
        readonly ok: false;
        readonly error: string;
     }
   | {
        readonly ok: true;
        readonly count: number;
        readonly tasks: ReadonlyArray<WorkerTaskSummary>;
        readonly message: string;
     };

function workerTaskView(task: Task): Record<string, unknown> {
   return {
      id: task.id,
      name: task.name ?? task.id,
      kind: "worker",
      status: task.status,
      worker: task.worker,
      model: task.model,
      cwd: task.cwd,
      context: task.context,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      settledAt: task.settledAt,
      errorText: task.errorText ? task.errorText.slice(0, 1000) : undefined,
      ...(task.sessionFile === undefined ? {} : { sessionFile: task.sessionFile })
   };
}

function summarizeTask(task: Task): WorkerTaskSummary {
   const status: WorkerAcknowledgementStatus =
      task.status === "pending" || task.status === "running" ? "spawned" : task.status;
   return {
      id: task.id,
      name: task.name ?? task.id,
      worker: task.worker,
      status,
      ...(task.resultData === undefined ? {} : { result: task.resultData }),
      ...(task.errorText === undefined ? {} : { errorText: task.errorText }),
      ...(task.sessionFile === undefined ? {} : { sessionFile: task.sessionFile })
   };
}

function summarizeSpawnedWorkers(tasks: ReadonlyArray<Task>, background: boolean): WorkerToolResult {
   const summaries = tasks.map(summarizeTask);
   const workerWord = summaries.length === 1 ? "worker" : "workers";

   return {
      ok: true,
      count: summaries.length,
      tasks: summaries,
      message: background
         ? `${summaries.length} ${workerWord} spawned in background. Results will be delivered automatically.`
         : `${summaries.length} ${workerWord} finished.`
   };
}

/** Spawn a batch of workers, waiting unless background execution is requested. */
export const handleWorkerSpawn = Effect.fn("worker.handleSpawn")(function* (
   params: WorkerSpawnToolParams,
   options?: HandleWorkerSpawnOptions
) {
   const workerManager = yield* WorkerManager;
   const registry = yield* TaskRegistry;
   const workers = prepareWorkerSpecs(params, options?.cwd);

   if (workers.length === 0) {
      return { ok: false, error: 'worker_spawn requires a non-empty "workers" array.' } satisfies WorkerToolResult;
   }

   const background = resolveWorkerBackground(params.background);
   const spawnedTasks = yield* workerManager.spawnBatch(workers, {
      ownerSessionId: options?.ownerSessionId,
      modelRegistry: options?.modelRegistry,
      inheritedModel: options?.inheritedModel,
      parentSessionFile: options?.parentSessionFile,
      batchId: createWorkerBatchId(),
      batchSize: workers.length,
      background
   });

   const currentTasks: Task[] = [];
   for (const spawnedTask of spawnedTasks) {
      const currentTask = yield* registry.get(spawnedTask.id);
      currentTasks.push(currentTask ?? spawnedTask);
   }

   return summarizeSpawnedWorkers(currentTasks, background);
});

export const handleWorkerList = Effect.fn("worker.handleList")(function* (_params: WorkerListToolParams) {
   const registry = yield* TaskRegistry;
   const tasks = yield* registry.list();

   return {
      ok: true,
      tasks: tasks.map(workerTaskView)
   };
});

export const handleWorkerRecover = Effect.fn("worker.handleRecover")(function* (
   params: WorkerRecoverToolParams,
   options?: {
      ownerSessionId?: string;
      parentSessionFile?: string;
      modelRegistry?: any;
      inheritedModel?: any;
      note?: string;
   }
) {
   const registry = yield* TaskRegistry;
   const workerManager = yield* WorkerManager;

   const task = yield* registry.get(params.id);
   if (!task) {
      return { ok: false, error: `Worker task "${params.id}" not found.` };
   }

   const ownerSessionId = options?.ownerSessionId ?? task.ownerSessionId;
   const recovered = yield* workerManager.recoverTask(params.id, {
      ownerSessionId,
      parentSessionFile: options?.parentSessionFile,
      modelRegistry: options?.modelRegistry,
      inheritedModel: options?.inheritedModel,
      note: options?.note
   });

   return {
      ok: true,
      action: "recovered" as const,
      id: params.id,
      task: recovered ? workerTaskView(recovered) : undefined
   };
});

export const handleWorkerCancel = Effect.fn("worker.handleCancel")(function* (params: WorkerCancelToolParams) {
   const registry = yield* TaskRegistry;
   const workerManager = yield* WorkerManager;

   const task = yield* registry.get(params.id);
   if (task) {
      const cancelled = yield* workerManager.cancelTask(params.id);
      return {
         ok: true,
         action: "cancelled" as const,
         id: params.id,
         task: cancelled ? workerTaskView(cancelled) : undefined
      };
   }

   return { ok: false, error: `Worker task "${params.id}" not found.` };
});
