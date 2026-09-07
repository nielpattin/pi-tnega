import { Effect } from "effect";
import { Type, type Static, type TSchema } from "typebox";
import { TaskRegistry } from "../services/task-registry.js";
import { AgentManager } from "../services/agent-manager.js";
import {
   normalizeAgentSpecs,
   prependContext,
   type Task,
   type TaskStatus,
   type TaskTranscriptEntry,
   type TaskUsageStats,
   type AgentSpec
} from "../domain.js";
import type { AgentProfile } from "../services/agent-profiles.ts";
import type { InheritedModelIdentity, ProfileModelRegistry } from "../services/model-resolution.ts";

// -----------------------------------------------------------------------------
// Tool input
// -----------------------------------------------------------------------------

const TaskIdSchema = Type.String({
   minLength: 1,
   description: "Task ID returned by agent_spawn (for example task-019c2f8e-7b3a-7c42-b9d1-6e8f4a2c1b90)."
});

/** Schema for one agent delegated by the parent session. */
export const AgentSpecSchema = Type.Object({
   task: Type.String({
      description: [
         "Detailed task instruction prompt for the agent.",
         "State the expected outcome, scope, edit permission, and stop condition."
      ].join(" ")
   }),
   name: Type.String({
      description: "Required short agent name, for example investigate-copy-all."
   }),
   profile: Type.String({
      minLength: 1,
      description: "Required enabled agent profile name listed in the current agent_spawn tool metadata."
   })
});

const batchContextSchema = Type.Optional(
   Type.String({ description: "Context prepended to every agent prompt in the batch." })
);

function createBatchParamsSchema<const AgentSchema extends TSchema>(agentSchema: AgentSchema) {
   return Type.Object({
      context: batchContextSchema,
      agents: Type.Array(agentSchema, {
         minItems: 1,
         maxItems: 4,
         description: "One to four agent specifications."
      }),
      background: Type.Optional(
         Type.Boolean({
            description: "Return immediately while agents continue independently. Defaults to false."
         })
      )
   });
}

/** Schema for the batch input accepted by the agent tool. */
export const AgentSpawnToolParamsSchema = createBatchParamsSchema(AgentSpecSchema);

/** Typed input accepted by the agent tool. */
export type AgentSpawnToolParams = Static<typeof AgentSpawnToolParamsSchema>;

export function resolveAgentBackground(background?: boolean): boolean {
   return background === true;
}

export const AgentListToolParamsSchema = Type.Object({}, { description: "List agent tasks." });
export type AgentListToolParams = Static<typeof AgentListToolParamsSchema>;

export const AgentCancelToolParamsSchema = Type.Object(
   {
      id: TaskIdSchema
   },
   { description: "Cancel an agent task by its task id." }
);
export type AgentCancelToolParams = Static<typeof AgentCancelToolParamsSchema>;

function createAgentProfileSchema(agentNames: readonly string[]) {
   const choices = agentNames.map((name) => Type.Literal(name));
   if (choices.length === 0) {
      return Type.Never({ description: "No agent profiles are available." });
   }
   if (choices.length === 1) {
      return choices[0];
   }
   return Type.Union(choices, {
      description: `Enabled agent profiles: ${agentNames.join(", ")}.`
   });
}

function createAgentSpecSchema(agentNames: readonly string[]) {
   return Type.Object({
      ...AgentSpecSchema.properties,
      profile: createAgentProfileSchema(agentNames)
   });
}

/**
 * Create the provider-facing agent schema with the enabled agent profiles as
 * the allowed values for each agent's `profile` field.
 */
export function createAgentSpawnToolParamsSchema(agentNames: readonly string[]) {
   return createBatchParamsSchema(createAgentSpecSchema(agentNames));
}

// -----------------------------------------------------------------------------
// Tool metadata
// -----------------------------------------------------------------------------

/** Description sent to the model with the agent spawn tool definition. */
export const AGENT_SPAWN_TOOL_BASE_DESCRIPTION = [
   "Spawn one or more agents.",
   'Use this input: { agents: [{ task: "prompt", name: "short-title", profile, ... }], context?, background? }.',
   "The agents array must contain 1 to 4 agent specifications.",
   "By default, the tool waits for all agents and returns their final results.",
   "Set background to true to return a spawned acknowledgement immediately while agents continue independently.",
   "Background agent results are delivered to the parent session automatically.",
   "The agent name is a display label. The returned task id is the agent identity.",
   "Each agent's `profile` field selects an enabled agent profile.",
   "If an agent fails, use agent_list to inspect its status and session file."
].join(" ");

/** Short description shown in the available-tools section. */
export const AGENT_SPAWN_TOOL_BASE_PROMPT_SNIPPET =
   "Spawn 1 to 4 agents with { agents: [{ task, name, profile, ... }], context?, background? }.";

/** Static agent tool definition for callers that do not need dynamic profile names. */
export const agentSpawnToolDefinition = {
   name: "agent_spawn",
   description: AGENT_SPAWN_TOOL_BASE_DESCRIPTION,
   parameters: AgentSpawnToolParamsSchema
};

export const agentListToolDefinition = {
   name: "agent_list",
   label: "Agent List",
   description:
      "List agent tasks with status (pending, running, completed, failed, cancelled), error, and session file.",
   parameters: AgentListToolParamsSchema
};

export const agentCancelToolDefinition = {
   name: "agent_cancel",
   label: "Agent Cancel",
   description: "Cancel an agent task by its task id.",
   parameters: AgentCancelToolParamsSchema
};

// -----------------------------------------------------------------------------
// Agent-profile metadata
// -----------------------------------------------------------------------------

/** Metadata added to the agent tool for enabled agent profiles. */
export interface AgentToolMetadataAugmentation {
   /** Names allowed in each agent's `agent` field. */
   readonly agentNames: ReadonlyArray<string>;
   /** Profile list appended to the tool description. */
   readonly descriptionAppendix: string;
}

/** Optional filter for the agent profiles advertised by the agent tool. */
export interface AgentToolMetadataOptions {
   readonly allowedAgentNames?: ReadonlyArray<string>;
}

type AgentProfileSummary = Pick<AgentProfile, "name" | "description" | "enabled">;

function formatAgentProfile(agent: AgentProfileSummary): string {
   const description = agent.description.trim();
   return description.length === 0 ? `  - ${agent.name}` : `  - ${agent.name}: ${description}`;
}

/**
 * Build the agent-tool metadata for enabled agent profiles.
 *
 * Agent bodies and disabled profiles are not exposed to the parent session.
 */
export function augmentAgentToolMetadata(
   agents: ReadonlyArray<AgentProfileSummary>,
   options?: AgentToolMetadataOptions
): AgentToolMetadataAugmentation {
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
// Agent execution
// -----------------------------------------------------------------------------

/** Dependencies and parent-session information required to spawn agents. */
export interface HandleAgentSpawnOptions {
   readonly ownerSessionId?: string;
   readonly modelRegistry?: ProfileModelRegistry<any>;
   readonly inheritedModel?: InheritedModelIdentity;
   readonly cwd?: string;
   readonly parentSessionFile?: string;
}

let agentBatchSequence = 0;

function createAgentBatchId(): string {
   agentBatchSequence += 1;
   return `batch-${Date.now()}-${agentBatchSequence}`;
}

function prepareAgentSpecs(input: AgentSpawnToolParams, defaultCwd?: string): AgentSpec[] {
   const agents = prependContext(normalizeAgentSpecs(input), input.context).map((agent) => ({
      ...agent,
      context: input.context
   }));
   if (defaultCwd === undefined) {
      return agents;
   }

   return agents.map((agent) => (agent.cwd === undefined ? { ...agent, cwd: defaultCwd } : agent));
}

type AgentAcknowledgementStatus = TaskStatus | "spawned";

type AgentTaskSummary = {
   readonly id: string;
   readonly name: string;
   readonly profile: string | undefined;
   readonly status: AgentAcknowledgementStatus;
   readonly result?: unknown;
   readonly errorText?: string;
   readonly sessionFile?: string;
   readonly usage?: TaskUsageStats;
};

type AgentToolResult =
   | {
        readonly ok: false;
        readonly error: string;
     }
   | {
        readonly ok: true;
        readonly count: number;
        readonly tasks: ReadonlyArray<AgentTaskSummary>;
        readonly message: string;
     };

function agentTaskView(task: Task): Record<string, unknown> {
   return {
      id: task.id,
      name: task.name ?? task.id,
      kind: "agent",
      status: task.status,
      profile: task.profile,
      model: task.model,
      cwd: task.cwd,
      context: task.context,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      settledAt: task.settledAt,
      errorText: task.errorText ? task.errorText.slice(0, 1000) : undefined,
      ...(task.sessionFile === undefined ? {} : { sessionFile: task.sessionFile }),
      ...(task.usage === undefined ? {} : { usage: task.usage })
   };
}

function summarizeTask(task: Task): AgentTaskSummary {
   const status: AgentAcknowledgementStatus =
      task.status === "pending" || task.status === "running" ? "spawned" : task.status;
   return {
      id: task.id,
      name: task.name ?? task.id,
      profile: task.profile,
      status,
      ...(task.resultData === undefined ? {} : { result: task.resultData }),
      ...(task.errorText === undefined ? {} : { errorText: task.errorText }),
      ...(task.sessionFile === undefined ? {} : { sessionFile: task.sessionFile }),
      ...(task.usage === undefined ? {} : { usage: task.usage })
   };
}

function summarizeSpawnedAgents(tasks: ReadonlyArray<Task>, background: boolean): AgentToolResult {
   const summaries = tasks.map(summarizeTask);
   const agentWord = summaries.length === 1 ? "agent" : "agents";

   return {
      ok: true,
      count: summaries.length,
      tasks: summaries,
      message: background
         ? `${summaries.length} ${agentWord} spawned in background. Results will be delivered automatically.`
         : `${summaries.length} ${agentWord} finished.`
   };
}

/** Spawn a batch of agents, waiting unless background execution is requested. */
export const handleAgentSpawn = Effect.fn("agent.handleSpawn")(function* (
   params: AgentSpawnToolParams,
   options?: HandleAgentSpawnOptions
) {
   const agentManager = yield* AgentManager;
   const registry = yield* TaskRegistry;
   const agents = prepareAgentSpecs(params, options?.cwd);

   if (agents.length === 0) {
      return { ok: false, error: 'agent_spawn requires a non-empty "agents" array.' } satisfies AgentToolResult;
   }

   const background = resolveAgentBackground(params.background);
   const spawnedTasks = yield* agentManager.spawnBatch(agents, {
      ownerSessionId: options?.ownerSessionId,
      modelRegistry: options?.modelRegistry,
      inheritedModel: options?.inheritedModel,
      parentSessionFile: options?.parentSessionFile,
      batchId: createAgentBatchId(),
      batchSize: agents.length,
      background
   });

   const currentTasks: Task[] = [];
   for (const spawnedTask of spawnedTasks) {
      const currentTask = yield* registry.get(spawnedTask.id);
      currentTasks.push(currentTask ?? spawnedTask);
   }

   return summarizeSpawnedAgents(currentTasks, background);
});

export const handleAgentList = Effect.fn("agent.handleList")(function* (_params: AgentListToolParams) {
   const registry = yield* TaskRegistry;
   const tasks = yield* registry.list();

   return {
      ok: true,
      tasks: tasks.map(agentTaskView)
   };
});

export const handleAgentCancel = Effect.fn("agent.handleCancel")(function* (params: AgentCancelToolParams) {
   const registry = yield* TaskRegistry;
   const agentManager = yield* AgentManager;

   const task = yield* registry.get(params.id);
   if (task) {
      const cancelled = yield* agentManager.cancelTask(params.id);
      return {
         ok: true,
         action: "cancelled" as const,
         id: params.id,
         task: cancelled ? agentTaskView(cancelled) : undefined
      };
   }

   return { ok: false, error: `Agent task "${params.id}" not found.` };
});
