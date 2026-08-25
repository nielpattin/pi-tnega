import { Effect } from "effect";
import { Type, type Static, type TSchema } from "typebox";
import { JobRegistry } from "../services/job-registry.js";
import { WorkerManager } from "../services/worker-manager.js";
import {
   normalizeWorkerSpecs,
   prependContext,
   type Job,
   type JobStatus,
   type JobTranscriptEntry,
   type WorkerSpec
} from "../domain.js";
import type { AgentProfile } from "../../services/agent-profiles.ts";
import type { InheritedModelIdentity, ProfileModelRegistry } from "../../services/model-resolution.ts";

// -----------------------------------------------------------------------------
// Tool input
// -----------------------------------------------------------------------------

const JobIdSchema = Type.String({
   minLength: 1,
   description: "Run ID returned by worker_spawn."
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
   agent: Type.String({
      minLength: 1,
      description: "Required enabled agent profile name listed in the current worker_spawn tool metadata."
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
      })
   });
}

/** Schema for the batch input accepted by the worker tool. */
export const WorkerSpawnToolParamsSchema = createBatchParamsSchema(WorkerSpecSchema);

/** Typed input accepted by the worker tool. */
export type WorkerSpawnToolParams = Static<typeof WorkerSpawnToolParamsSchema>;

export const WorkerListToolParamsSchema = Type.Object({}, { description: "List worker runs." });
export type WorkerListToolParams = Static<typeof WorkerListToolParamsSchema>;

export const WorkerCancelToolParamsSchema = Type.Object(
   {
      id: JobIdSchema
   },
   { description: "Cancel a worker by run ID." }
);
export type WorkerCancelToolParams = Static<typeof WorkerCancelToolParamsSchema>;

function createAgentProfileSchema(agentProfileNames: readonly string[]) {
   const choices = agentProfileNames.map((name) => Type.Literal(name));
   if (choices.length === 0) {
      return Type.Never({ description: "No agent profiles are available." });
   }
   if (choices.length === 1) {
      return choices[0];
   }
   return Type.Union(choices, {
      description: `Enabled agent profiles: ${agentProfileNames.join(", ")}.`
   });
}

function createWorkerSpecSchema(agentProfileNames: readonly string[]) {
   return Type.Object({
      ...WorkerSpecSchema.properties,
      agent: createAgentProfileSchema(agentProfileNames)
   });
}

/**
 * Create the provider-facing worker schema with the enabled agent profiles as
 * the allowed values for each worker's `agent` field.
 */
export function createWorkerSpawnToolParamsSchema(agentProfileNames: readonly string[]) {
   return createBatchParamsSchema(createWorkerSpecSchema(agentProfileNames));
}

// -----------------------------------------------------------------------------
// Tool metadata
// -----------------------------------------------------------------------------

/** Description sent to the model with the worker spawn tool definition. */
export const WORKER_SPAWN_TOOL_BASE_DESCRIPTION = [
   "Spawn one or more workers.",
   'Use this input: { workers: [{ task: "prompt", name: "short-title", agent, ... }], context? }.',
   "The workers array must contain 1 to 4 worker specifications.",
   "The parent session receives a spawned acknowledgement immediately.",
   "Each worker runs independently and returns a worker result when it completes.",
   "Parent delivery presents worker results to the parent session automatically.",
   "The worker name is a display label. The returned id is the worker identity.",
   "Each worker's agent field selects an enabled agent profile."
].join(" ");

/** Short description shown in the available-tools section. */
export const WORKER_SPAWN_TOOL_BASE_PROMPT_SNIPPET =
   "Spawn 1 to 4 workers with { workers: [{ task, name, agent, ... }], context? }.";

/** Static worker tool definition for callers that do not need dynamic profile names. */
export const workerSpawnToolDefinition = {
   name: "worker_spawn",
   description: WORKER_SPAWN_TOOL_BASE_DESCRIPTION,
   parameters: WorkerSpawnToolParamsSchema
};

export const workerListToolDefinition = {
   name: "worker_list",
   label: "Worker List",
   description: "List worker runs.",
   parameters: WorkerListToolParamsSchema
};

export const workerCancelToolDefinition = {
   name: "worker_cancel",
   label: "Worker Cancel",
   description: "Cancel a worker by run ID.",
   parameters: WorkerCancelToolParamsSchema
};

// -----------------------------------------------------------------------------
// Agent-profile metadata
// -----------------------------------------------------------------------------

/** Metadata added to the worker tool for enabled agent profiles. */
export interface WorkerToolMetadataAugmentation {
   /** Names allowed in each worker's `agent` field. */
   readonly agentNames: ReadonlyArray<string>;
   /** Profile list appended to the tool description. */
   readonly descriptionAppendix: string;
}

/** Optional filter for the agent profiles advertised by the worker tool. */
export interface WorkerToolMetadataOptions {
   readonly allowedAgentNames?: ReadonlyArray<string>;
}

type WorkerAgentProfile = Pick<AgentProfile, "name" | "description" | "enabled">;

function formatAgentProfile(agent: WorkerAgentProfile): string {
   const description = agent.description.trim();
   return description.length === 0 ? `  - ${agent.name}` : `  - ${agent.name}: ${description}`;
}

/**
 * Build the worker-tool metadata for enabled agent profiles.
 *
 * Worker bodies and disabled profiles are not exposed to the parent session.
 */
export function augmentWorkerToolMetadata(
   agents: ReadonlyArray<WorkerAgentProfile>,
   options?: WorkerToolMetadataOptions
): WorkerToolMetadataAugmentation {
   const allowedNames = options?.allowedAgentNames;
   const allowed = allowedNames === undefined ? undefined : new Set(allowedNames);
   const enabledAgents = agents
      .filter((agent) => agent.enabled && (allowed === undefined || allowed.has(agent.name)))
      .toSorted((left, right) => left.name.localeCompare(right.name));

   if (enabledAgents.length === 0) {
      return {
         agentNames: [],
         descriptionAppendix: ""
      };
   }

   return {
      agentNames: enabledAgents.map((agent) => agent.name),
      descriptionAppendix: [
         "Enabled agent profiles for the current workspace:",
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

type WorkerAcknowledgementStatus = JobStatus | "spawned";

type WorkerJobSummary = {
   readonly id: string;
   readonly name: string;
   readonly agent: string | undefined;
   readonly status: WorkerAcknowledgementStatus;
   readonly transcript?: ReadonlyArray<JobTranscriptEntry>;
};

type WorkerToolResult =
   | {
        readonly ok: false;
        readonly error: string;
     }
   | {
        readonly ok: true;
        readonly count: number;
        readonly jobs: ReadonlyArray<WorkerJobSummary>;
        readonly message: string;
     };

function workerJobView(job: Job): Record<string, unknown> {
   return {
      id: job.id,
      name: job.name ?? job.id,
      kind: "worker",
      status: job.status,
      agent: job.agent,
      model: job.model,
      cwd: job.cwd,
      context: job.context,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      settledAt: job.settledAt,
      errorText: job.errorText ? job.errorText.slice(0, 1000) : undefined
   };
}

function summarizeJob(job: Job): WorkerJobSummary {
   const status: WorkerAcknowledgementStatus =
      job.status === "pending" || job.status === "running" ? "spawned" : job.status;
   const summary: WorkerJobSummary = {
      id: job.id,
      name: job.name ?? job.id,
      agent: job.agent,
      status
   };

   return job.transcript === undefined || job.transcript.length === 0
      ? summary
      : { ...summary, transcript: job.transcript };
}

function summarizeSpawnedWorkers(jobs: ReadonlyArray<Job>): WorkerToolResult {
   const summaries = jobs.map(summarizeJob);
   const workerWord = summaries.length === 1 ? "worker" : "workers";

   return {
      ok: true,
      count: summaries.length,
      jobs: summaries,
      message: `${summaries.length} ${workerWord} spawned. Results will be delivered automatically.`
   };
}

/** Spawn a batch of workers and return an immediate acknowledgement. */
export const handleWorkerSpawn = Effect.fn("worker.handleSpawn")(function* (
   params: WorkerSpawnToolParams,
   options?: HandleWorkerSpawnOptions
) {
   const workerManager = yield* WorkerManager;
   const registry = yield* JobRegistry;
   const workers = prepareWorkerSpecs(params, options?.cwd);

   if (workers.length === 0) {
      return { ok: false, error: 'worker_spawn requires a non-empty "workers" array.' } satisfies WorkerToolResult;
   }

   const spawnedJobs = yield* workerManager.spawnBatch(workers, {
      ownerSessionId: options?.ownerSessionId,
      modelRegistry: options?.modelRegistry,
      inheritedModel: options?.inheritedModel,
      parentSessionFile: options?.parentSessionFile,
      batchId: createWorkerBatchId(),
      batchSize: workers.length
   });

   const currentJobs: Job[] = [];
   for (const spawnedJob of spawnedJobs) {
      const currentJob = yield* registry.get(spawnedJob.id);
      currentJobs.push(currentJob ?? spawnedJob);
   }

   return summarizeSpawnedWorkers(currentJobs);
});

export const handleWorkerList = Effect.fn("worker.handleList")(function* (_params: WorkerListToolParams) {
   const registry = yield* JobRegistry;
   const workers = yield* registry.list();

   return {
      ok: true,
      jobs: workers.map(workerJobView)
   };
});

export const handleWorkerCancel = Effect.fn("worker.handleCancel")(function* (params: WorkerCancelToolParams) {
   const registry = yield* JobRegistry;
   const workerManager = yield* WorkerManager;

   const worker = yield* registry.get(params.id);
   if (worker) {
      const cancelled = yield* workerManager.cancelJob(params.id);
      return {
         ok: true,
         action: "cancelled" as const,
         id: params.id,
         job: cancelled ? workerJobView(cancelled) : undefined
      };
   }

   return { ok: false, error: `Worker run "${params.id}" not found.` };
});
