import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { TaskManager } from "../services/TaskManager.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { normalizeTaskSpecs, prependContext, type AgentDefinition, type Job } from "../domain.js";
import type { InheritedModelInfo, ModelRegistryLike } from "../backends/pi-model.js";

export const TaskSpecSchema = Type.Object({
   task: Type.String({
      description:
         "Detailed instruction prompt for the subagent. State the expected outcome, scope, whether edits are allowed, and any stop condition."
   }),
   name: Type.String({
      description:
         "Required AI-generated short human-readable task name describing the work, for example investigate-copy-all. This is separate from the generated task-N job ID and does not select an agent."
   }),
   agent: Type.Optional(
      Type.String({
         description:
            'Agent profile name resolved through /agents, for example "good". Use this when the user names an agent. Omitting agent selects the default "task" profile.'
      })
   ),
   model: Type.Optional(
      Type.String({
         description:
            "Optional model override for the selected agent. This does not select an agent. Omit it to inherit the selected agent or parent model."
      })
   ),
   outputSchema: Type.Optional(
      Type.Unknown({ description: "Raw JSON Schema document used to validate structured result data." })
   )
});

/**
 * Flat task parameters shared by both single and batch spawns. `tasks` selects
 * a batch, `task` selects a single job, `context` applies to batches only. A
 * single flat object is reliably serializable by small tool-calling models that
 * struggle with discriminated-union schemas; normalizeTaskSpecs resolves the
 * form at runtime.
 */
export const TaskToolParamsSchema = Type.Object(
   {
      context: Type.Optional(
         Type.String({ description: "Batch-only shared background context prepended to every task prompt." })
      ),
      tasks: Type.Optional(
         Type.Array(TaskSpecSchema, {
            minItems: 1,
            maxItems: 4,
            description: "Batch of 1 to 4 task specifications."
         })
      ),
      task: Type.Optional(Type.String({ description: "Detailed instruction prompt for the subagent." })),
      name: Type.Optional(
         Type.String({ description: "Short human-readable task name, for example investigate-copy-all." })
      ),
      agent: Type.Optional(
         Type.String({
            description:
               'Agent profile name resolved through /agents, for example "good". Use this when the user names an agent. Omitting agent selects the default "task" profile.'
         })
      ),
      model: Type.Optional(
         Type.String({
            description:
               "Optional model override for the selected agent. This does not select an agent. Omit it to inherit the selected agent or parent model."
         })
      ),
      outputSchema: Type.Optional(
         Type.Unknown({ description: "Raw JSON Schema document used to validate structured result data." })
      )
   },
   {
      description:
         "Task tool parameters. Provide either a single flat job (task, name, ...) or a batch (tasks array, optional context)."
   }
);

export type TaskToolParams = Static<typeof TaskToolParamsSchema>;

export interface TaskToolSchemaOptions {
   readonly requireAgent?: boolean;
}

function createAgentSchema(agentNames: readonly string[]) {
   const literals = agentNames.map((name) => Type.Literal(name));
   if (literals.length === 0) return Type.Never({ description: "No agent profiles are available." });
   if (literals.length === 1) return literals[0];
   return Type.Union(literals, {
      description: `Agent profile. Allowed values: ${agentNames.join(", ")}.`
   });
}

/** Build a task schema whose agent field is limited to the supplied profiles. */
export function createTaskToolParamsSchema(agentNames: readonly string[], options?: TaskToolSchemaOptions) {
   const baseProperties = TaskSpecSchema.properties;
   const taskSpecSchema = Type.Object({
      ...baseProperties,
      agent: options?.requireAgent ? createAgentSchema(agentNames) : Type.Optional(createAgentSchema(agentNames))
   });
   const flatAgent = options?.requireAgent
      ? createAgentSchema(agentNames)
      : Type.Optional(createAgentSchema(agentNames));
   return Type.Object(
      {
         context: Type.Optional(
            Type.String({ description: "Batch-only shared background context prepended to every task prompt." })
         ),
         tasks: Type.Optional(
            Type.Array(taskSpecSchema, {
               minItems: 1,
               maxItems: 4,
               description: "Batch of task specifications using only the supplied agent profiles."
            })
         ),
         task: Type.Optional(Type.String({ description: "Detailed instruction prompt for the subagent." })),
         name: Type.Optional(Type.String({ description: "Short human-readable task name." })),
         agent: flatAgent,
         model: Type.Optional(Type.String({ description: "Optional model override for the selected agent." })),
         outputSchema: Type.Optional(
            Type.Unknown({ description: "Raw JSON Schema document used to validate structured result data." })
         )
      },
      {
         description:
            "Task tool parameters. Provide either a single flat job (task, name, ...) or a batch (tasks array, optional context)."
      }
   );
}

export const TASK_TOOL_BASE_DESCRIPTION =
   'Spawn one or more subagent jobs. Flat: { task: "prompt", name: "short-title", agent?, model? } for a single job. Batch: { tasks: [{ task: "prompt", name: "short-title", ... }], context? } for 1 to 4 concurrent jobs. All tasks run in the background: they return a start acknowledgement immediately and deliver their completed result to the parent automatically. The parent is never blocked. The parent AI must generate name from the work; name is separate from agent and the returned task-N job ID. The agent field selects an /agents profile; model only overrides the selected agent model.';

export const TASK_TOOL_BASE_PROMPT_SNIPPET =
   "Spawn subagents with { task, name, agent? } or a batch { tasks: [{ task, name, ... }] }. All tasks are background tasks: they return immediately and deliver results automatically.";

export const TASK_TOOL_BASE_PROMPT_GUIDELINES = [
   'Use task_spawn agent: "fast" for quick research and focused implementation. task_spawn model is only a model override and never selects an agent.',
   'Use task_spawn agent: "good" for complex implementation and edge-case verification. task_spawn model is only a model override and never selects an agent.',
   "Always generate task name as a short human-readable description of the work. Never copy the agent name into task name. The returned task-N value is the separate job ID.",
   "Omit task model unless the user explicitly requests a model override; otherwise inherit the selected agent or parent model.",
   "Every task runs in the background and returns a start acknowledgement immediately; its result is steered to the parent when it settles. Do not call job_list after starting a task unless automatic delivery fails or the user asks for manual status.",
   "When the user explicitly asks to delegate to an agent, call task_spawn before reading, searching, or investigating the target yourself. Put the requested investigation in the task prompt instead.",
   'Use task_spawn with a flat { task: "prompt", ... } payload for one job or { tasks: [{ task, name, ... }], context? } for 1 to 4 concurrent jobs.'
];

export const taskSpawnToolDefinition = {
   name: "task_spawn",
   description: TASK_TOOL_BASE_DESCRIPTION,
   parameters: TaskToolParamsSchema
};

export interface TaskToolMetadataAugmentation {
   /** Text appended to the task tool description when agents are available. */
   readonly descriptionAppendix: string;
   /** Additional promptGuidelines bullets, one per enabled agent. */
   readonly additionalGuidelines: ReadonlyArray<string>;
}

/** Maximum enabled agents advertised in the task tool metadata. */
const MAX_TASK_METADATA_AGENT_COUNT = 16;
/** Maximum characters of a single agent description to expose to the provider. */
const MAX_TASK_METADATA_DESCRIPTION_LEN = 200;

function truncateMetadata(str: string, max: number): string {
   if (str.length <= max) return str;
   return `${str.slice(0, max)}…`;
}

/**
 * Build a concise provider-facing list of enabled agent profiles.
 * Uses only agent `name` and `description`; bodies and disabled agents are excluded.
 * Limits the number of agents and length of each description to avoid bloating
 * the provider tool definition / system prompt.
 */
export interface TaskToolMetadataOptions {
   readonly allowedAgentNames?: ReadonlyArray<string>;
}

export function augmentTaskToolMetadata(
   agents: ReadonlyArray<AgentDefinition>,
   options?: TaskToolMetadataOptions
): TaskToolMetadataAugmentation {
   const allowed = options?.allowedAgentNames ? new Set(options.allowedAgentNames) : undefined;
   const enabled = agents
      .filter((agent) => {
         if (allowed) return allowed.has(agent.name) && agent.enabled;
         return agent.enabled;
      })
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_TASK_METADATA_AGENT_COUNT);
   if (enabled.length === 0) {
      return { descriptionAppendix: "", additionalGuidelines: [] };
   }
   const descriptionAppendix = [
      "Enabled agent profiles for the current workspace:",
      ...enabled.map((a) => {
         const desc = truncateMetadata(a.description ?? "", MAX_TASK_METADATA_DESCRIPTION_LEN);
         return `  - ${a.name}${desc ? `: ${desc}` : ""}`;
      })
   ].join("\n");
   const additionalGuidelines = enabled.map(
      (a) =>
         `Use task_spawn agent: "${a.name}" when the work matches: ${truncateMetadata(a.description ?? "", MAX_TASK_METADATA_DESCRIPTION_LEN) || "this profile"}.`
   );
   return { descriptionAppendix, additionalGuidelines };
}

export interface HandleTaskOptions {
   ownerSessionId?: string;
   modelRegistry?: ModelRegistryLike;
   inheritedModel?: InheritedModelInfo;
   cwd?: string;
   parentSessionFile?: string;
}

function buildJobSummary(job: Job): Record<string, unknown> {
   const summary: Record<string, unknown> = {
      id: job.id,
      name: job.name ?? job.id,
      agent: job.agent ?? "task",
      // The task tool returns an acknowledgement, not a live lifecycle snapshot.
      // Keep the internal Job status unchanged while naming the acknowledgement explicitly.
      status: job.status === "pending" || job.status === "running" ? "spawned" : job.status
   };
   if (job.transcript && job.transcript.length > 0) summary.transcript = job.transcript;
   return summary;
}

function buildResultSummary(jobs: ReadonlyArray<Job>, isBatch: boolean): unknown {
   const jobSummaries = jobs.map((job) => buildJobSummary(job));

   if (!isBatch && jobSummaries.length === 1) {
      const summary = jobSummaries[0];
      return {
         ok: true,
         id: summary.id,
         name: summary.name,
         agent: summary.agent,
         status: summary.status,
         message: `Task ${String(summary.name)} (${String(summary.id)}) spawned. Its result will be delivered automatically when it completes.`
      };
   }

   return {
      ok: true,
      count: jobSummaries.length,
      jobs: jobSummaries,
      message: `${jobSummaries.length} task${jobSummaries.length === 1 ? "" : "s"} spawned. Results will be delivered automatically.`
   };
}

export const handleTask = Effect.fn("task.handleTask")(function* (params: TaskToolParams, options?: HandleTaskOptions) {
   const taskManager = yield* TaskManager;
   const registry = yield* JobRegistry;

   const rawSpecs = normalizeTaskSpecs(params);
   if (rawSpecs.length === 0) {
      return { ok: false, error: 'task_spawn requires either a single "task" or a non-empty "tasks" array.' };
   }
   const contextStr = (params as any)?.context;
   const prependedSpecs = prependContext(rawSpecs, contextStr).map((spec) => ({
      ...spec,
      cwd: spec.cwd ?? options?.cwd
   }));

   const jobs = yield* taskManager.spawnBatch(prependedSpecs, {
      ownerSessionId: options?.ownerSessionId,
      modelRegistry: options?.modelRegistry,
      inheritedModel: options?.inheritedModel,
      parentSessionFile: options?.parentSessionFile
   });

   // Harbor tasks are always async: return immediately with start acknowledgements.
   // Worker results arrive automatically via the settled-job delivery path.
   const isBatch = Array.isArray((params as { readonly tasks?: unknown }).tasks);

   const finalJobs = [];
   for (const origJob of jobs) {
      const latest = yield* registry.get(origJob.id);
      finalJobs.push(latest ?? origJob);
   }

   return buildResultSummary(finalJobs, isBatch);
});
