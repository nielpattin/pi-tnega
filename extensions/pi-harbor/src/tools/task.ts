import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { TaskManager } from "../services/TaskManager.js";
import { JobRegistry } from "../services/JobRegistry.js";
import { normalizeTaskSpecs, prependContext, type AgentDefinition, type Job, type TaskSpec } from "../domain.js";
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
            'Agent profile name resolved through /agents, for example "high-task". Use this when the user names an agent. Omitting agent selects the default "task" profile.'
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
   ),
   background: Type.Optional(
      Type.Boolean({
         default: false,
         description:
            "False or omitted blocks until settlement so the result appears in this task call. True starts the task in the background, returns only a job acknowledgement immediately, and delivers the completed result automatically. Do not call hub wait or describe unless manual inspection or recovery is needed."
      })
   )
});

export const TaskToolParamsSchema = Type.Union(
   [
      Type.Object({
         context: Type.Optional(
            Type.String({ description: "Batch-only shared background context prepended to every task prompt." })
         ),
         tasks: Type.Array(TaskSpecSchema, {
            minItems: 1,
            maxItems: 4,
            description:
               "Batch of 1 to 4 task specifications. When starting 2 to 4 independent background assignments at once, use one batch call with background: true on each item instead of repeated flat calls."
         })
      }),
      TaskSpecSchema
   ],
   { type: "object" }
);

export type TaskToolParams = Static<typeof TaskToolParamsSchema>;

export const TASK_TOOL_BASE_DESCRIPTION =
   'Spawn one or more subagent jobs. Flat: { task: "prompt", name: "short-title", agent?, model?, background? } for a single job. Batch: { tasks: [{ task: "prompt", name: "short-title", ... }], context? } for 1 to 4 concurrent jobs. When starting 2 to 4 independent background assignments at once, prefer one batch call with background: true on each item instead of repeated flat calls, e.g. { tasks: [{ task: "investigate A", name: "investigate-a", background: true }, { task: "investigate B", name: "investigate-b", background: true }] }. The parent AI must generate name from the work; name is separate from agent and the returned task-N job ID. The agent field selects an /agents profile; model only overrides the selected agent model.';

export const TASK_TOOL_BASE_PROMPT_SNIPPET =
   "Spawn subagents with { task, name, agent?, background? } or a batch { tasks: [{ task, name, background? }] }. Prefer one batch with background: true per item when starting 2 to 4 independent background tasks at once.";

export const TASK_TOOL_BASE_PROMPT_GUIDELINES = [
   'Use task agent: "high-task" when the user names the high-task agent. task model is only a model override and never selects an agent.',
   "Always generate task name as a short human-readable description of the work. Never copy the agent name into task name. The returned task-N value is the separate job ID.",
   "Omit task model unless the user explicitly requests a model override; otherwise inherit the selected agent or parent model.",
   "A background task returns only a start acknowledgement and steers the result to the parent session immediately when it settles. Do not call hub wait or describe after starting it unless automatic delivery fails or the user asks for manual inspection.",
   "When the user explicitly asks to delegate to an agent, call task before reading, searching, or investigating the target yourself. Put the requested investigation in the task prompt instead.",
   'Use task with a flat { task: "prompt", ... } payload for one job or { tasks: [{ task: "prompt", ... }], context? } for 1 to 4 concurrent jobs. When starting 2 to 4 independent background assignments at once, set background: true on each item in a single batch instead of making repeated flat calls, e.g. { tasks: [{ task: "investigate A", name: "investigate-a", background: true }, { task: "investigate B", name: "investigate-b", background: true }] }.'
];

export const taskToolDefinition = {
   name: "task",
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
export function augmentTaskToolMetadata(agents: ReadonlyArray<AgentDefinition>): TaskToolMetadataAugmentation {
   const enabled = agents
      .filter((a) => a.enabled)
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
         `Use task agent: "${a.name}" when the work matches: ${truncateMetadata(a.description ?? "", MAX_TASK_METADATA_DESCRIPTION_LEN) || "this profile"}.`
   );
   return { descriptionAppendix, additionalGuidelines };
}

export interface HandleTaskOptions {
   ownerSessionId?: string;
   timeoutMs?: number;
   modelRegistry?: ModelRegistryLike;
   inheritedModel?: InheritedModelInfo;
   cwd?: string;
   parentSessionFile?: string;
   /** Called with a fresh summary each time a foreground job settles while others are still running. */
   onUpdate?: (summary: unknown) => void;
}

function buildJobSummary(job: Job, spec: Readonly<TaskSpec>): Record<string, unknown> {
   const summary: Record<string, unknown> = {
      id: job.id,
      name: job.name ?? job.id,
      agent: job.agent ?? "task",
      status: job.status,
      background: spec.async === true
   };
   if (spec.async !== true) {
      if (job.resultData !== undefined) summary.result = job.resultData;
      if (job.errorText) summary.error = job.errorText;
   }
   return summary;
}

function buildResultSummary(
   jobs: ReadonlyArray<Job>,
   specs: ReadonlyArray<Readonly<TaskSpec>>,
   isBatch: boolean
): unknown {
   const jobSummaries = jobs.map((job, index) => buildJobSummary(job, specs[index]));

   if (!isBatch && jobSummaries.length === 1) {
      const summary = jobSummaries[0];
      if (summary.background === true) {
         return {
            ok: true,
            id: summary.id,
            name: summary.name,
            agent: summary.agent,
            status: summary.status,
            background: true,
            message: `Task ${String(summary.name)} (${String(summary.id)}) started in the background. Its result will be delivered automatically when it completes.`
         };
      }
      return { ok: true, ...summary };
   }

   const backgroundCount = jobSummaries.filter((job) => job.background === true).length;
   return {
      ok: true,
      count: jobSummaries.length,
      jobs: jobSummaries,
      ...(backgroundCount > 0
         ? {
              message: `${backgroundCount} background task${backgroundCount === 1 ? "" : "s"} started. Results will be delivered automatically.`
           }
         : {})
   };
}

export const handleTask = Effect.fn("task.handleTask")(function* (params: TaskToolParams, options?: HandleTaskOptions) {
   const taskManager = yield* TaskManager;
   const registry = yield* JobRegistry;

   const rawSpecs = normalizeTaskSpecs(params);
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

   const isBatch = Array.isArray((params as { readonly tasks?: unknown }).tasks);
   const syncJobs: string[] = [];
   for (let i = 0; i < prependedSpecs.length; i++) {
      const spec = prependedSpecs[i];
      const job = jobs[i];
      if (spec.async !== true) {
         syncJobs.push(job.id);
      }
   }

   if (syncJobs.length > 0) {
      const onUpdate = options?.onUpdate;
      if (onUpdate) {
         const syncJobIds = new Set(syncJobs);
         const latestJobs = Array.from(jobs);

         yield* Effect.acquireUseRelease(
            registry.onSettled((settledJob) => {
               if (!syncJobIds.has(settledJob.id)) return;
               const index = latestJobs.findIndex((job) => job.id === settledJob.id);
               if (index >= 0) latestJobs[index] = settledJob;
               onUpdate(buildResultSummary(latestJobs, prependedSpecs, isBatch));
            }),
            (unsubscribe) => registry.awaitSettlement(syncJobs, options?.timeoutMs),
            (unsubscribe) => Effect.sync(() => unsubscribe())
         );
      } else {
         yield* registry.awaitSettlement(syncJobs, options?.timeoutMs);
      }
   }

   const finalJobs = [];
   for (const origJob of jobs) {
      const latest = yield* registry.get(origJob.id);
      finalJobs.push(latest ?? origJob);
   }

   return buildResultSummary(finalJobs, prependedSpecs, isBatch);
});
