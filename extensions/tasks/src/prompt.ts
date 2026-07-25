/** All model-facing strings for the tasks tools. */

import { loadAllAgents } from "./agents/types.ts";

/** Describes task_spawn, including agent selection and the fixed concurrency cap. */
export const TASK_SPAWN_TOOL_DESCRIPTION =
   "Spawn a background task: a fully autonomous, headless agent with its own context window, configured by a named agent role (agent). Fire-and-forget: this returns immediately with an id. The task's final output is queued back to you as a message when it settles, or collect it explicitly with task_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Max 4 tasks can be running at once. Use task_spawn_batch for multiple parallel workers.";

/** Adds background task delegation to the parent model's available-tools prompt. */
export const TASK_SPAWN_PROMPT_SNIPPET =
   "Spawn a background task using a defined agent role (agent) for a self-contained task; use task_spawn_batch for parallel workers with shared context";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export function getTaskSpawnPromptGuidelines(cwd?: string): string[] {
   const guidelines = [
      "Use task_spawn to delegate self-contained tasks that can run in the background. Always specify both `agent` (the agent role name) and `name` (a short title for the task) along with a complete, standalone prompt.",
      "Always set `agent` to a valid agent role name (e.g. 'scout', 'task', 'high-task') and `name` to a short human-readable name. Do not attempt to specify harness, model, or effort parameters.",
      "After task_spawn, keep working; results arrive automatically. Only call task_wait when you cannot proceed without the result.",
      "Use task_spawn_batch when launching several independent workers at once. Pass shared constraints in `context` (prepended to every task). Do not fan out sequential single spawns for the same batch of work."
   ];

   try {
      const agentsMap = loadAllAgents(cwd);
      const enabled = Array.from(agentsMap.values()).filter((a: any) => Boolean(a.enabled));
      if (enabled.length > 0) {
         guidelines.push("Available agent roles for `agent` parameter:");
         for (const a of enabled as any[]) {
            guidelines.push(`- ${a.name}: ${a.description}${a.guidance ? ` Guidance: ${a.guidance}` : ""}`);
         }
      }
   } catch {
      // fallback if unavailable
   }

   return guidelines;
}

export const TASK_SPAWN_PROMPT_GUIDELINES = getTaskSpawnPromptGuidelines();

/** Model-facing schema descriptions for task_spawn task and execution options. */
export const TASK_SPAWN_PARAMETER_DESCRIPTIONS = {
   agent: "Required agent definition name (e.g. 'scout', 'task', 'high-task'). Defines harness, model, thinking, tools, and system prompt.",
   prompt:
      "Task prompt for the task agent. Must be self-contained: include all needed context, file paths, and what to report back.",
   name: "Required short human-readable name for this task, shown in listings and the UI",
   workingDir: "Working directory (default: current working directory)"
};

export const TASK_SPAWN_BATCH_TOOL_DESCRIPTION =
   "Spawn multiple tasks in parallel with an optional shared context prepended to every task prompt.";

export const TASK_SPAWN_BATCH_PROMPT_SNIPPET = "Spawn several background tasks at once with optional shared context";

export const TASK_SPAWN_BATCH_PROMPT_GUIDELINES = [
   "Use task_spawn_batch for parallel independent work; use task_spawn for a single worker.",
   "Put shared constraints, paths, and contracts in `context` once — do not duplicate them in every task.prompt.",
   "Max 4 tasks can run at once including already-running ones. Batch size + current running must not exceed 4.",
   "Each task still needs agent, name, and a self-contained prompt. Results deliver individually when each settles."
];

export const TASK_SPAWN_BATCH_PARAMETER_DESCRIPTIONS = {
   context: "Shared constraints or context prepended to every task prompt",
   tasks: "List of task items to spawn"
};

/** Builds the task_spawn result that tells the parent model how to continue or inspect the child. */
export function buildTaskSpawnResult(options: {
   id: string;
   title: string;
   harness: string;
   modelLabel: string;
   cwd: string;
}) {
   return (
      `Spawned task ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
      `It runs in the background. Its result will be delivered to you when it finishes, ` +
      `or use task_wait(ids: ["${options.id}"]) to block for it, task_cancel to stop it, task_check to peek, task_list to see all.`
   );
}

/** Describes explicit blocking collection of one or more task results. */
export const TASK_WAIT_TOOL_DESCRIPTION =
   "Block until all listed tasks have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the task ids to await. */
export const TASK_WAIT_PARAMETER_DESCRIPTIONS = {
   ids: 'Task ids to wait for, e.g. ["task-1", "task-2"]'
};

/** Describes aborting running tasks while retaining their partial transcripts. */
export const TASK_CANCEL_TOOL_DESCRIPTION =
   "Cancel one or more running tasks. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the task ids to cancel. */
export const TASK_CANCEL_PARAMETER_DESCRIPTIONS = {
   ids: 'Task ids to cancel, e.g. ["task-1", "task-2"]'
};

/** Describes nonblocking inspection of a task without consuming its result. */
export const TASK_CHECK_TOOL_DESCRIPTION =
   "Peek at a task's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the task id to inspect. */
export const TASK_CHECK_PARAMETER_DESCRIPTIONS = {
   id: "Task id"
};

/** Describes listing all tracked running and settled tasks. */
export const TASK_LIST_TOOL_DESCRIPTION = "List all tasks (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildTaskResultMessage(options: {
   id: string;
   title: string;
   status: "running" | "done" | "error";
   errorText?: string;
   output: string;
}) {
   const verb = options.status === "error" ? "failed" : "finished";
   let text = `Task ${options.id} "${options.title}" ${verb}.`;
   if (options.errorText) text += `\nError: ${options.errorText}`;
   text += `\n\n${options.output}`;
   return text;
}
