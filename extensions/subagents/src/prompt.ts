/** All model-facing strings for the subagents tools. */

import { AGY_BASE_MODELS, AGY_REASONING_EFFORTS, DEFAULT_AGY_MODEL } from "./backends/agy.ts";

const AGY_MODELS_LIST = AGY_BASE_MODELS.join(", ");
const AGY_EFFORTS_LIST = AGY_REASONING_EFFORTS.join(", ");

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
   "Spawn a background subagent: a fully autonomous, headless agent with its own context window. You choose the harness: pi (in-process pi session, inherits this environment's tools and config) or agy (Antigravity CLI print-mode process). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Max 4 subagents can be running at once.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
   "Spawn a background subagent on a chosen harness (pi or agy; own context) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export function getSubagentSpawnPromptGuidelines(cwd?: string): string[] {
   const guidelines = [
      "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
      "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result."
   ];

   try {
      // Dynamic import / require of loadAllAgents
      const { loadAllAgents } = require("./agents/types.ts");
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

export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = getSubagentSpawnPromptGuidelines();

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
   agent: "Optional agent definition name (e.g. 'scout'). Drives system prompt, tools, harness, and model defaults.",
   prompt:
      "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
   name: "Short human-readable name for this subagent, shown in listings and the UI",
   harness:
      'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment) or "agy" (Antigravity CLI print mode).',
   workingDir: "Working directory (default: current working directory)",
   model: `Model hint. pi: "provider/model-id" or model id (omit to inherit parent). agy models: ${AGY_MODELS_LIST} (default: ${DEFAULT_AGY_MODEL}).`,
   reasoningEffort: `Reasoning effort. pi: thinking level (off|minimal|low|medium|high|xhigh|max). agy: ${AGY_EFFORTS_LIST} (default: low). For agy, the final CLI model is {model}-{effort} (e.g. ${DEFAULT_AGY_MODEL}-medium).`
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
   id: string;
   title: string;
   harness: string;
   modelLabel: string;
   cwd: string;
}) {
   return (
      `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
      `It runs in the background. Its result will be delivered to you when it finishes, ` +
      `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
   );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
   "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
   ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]'
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
   "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
   ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]'
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
   "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
   id: "Subagent id"
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
   "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
   id: string;
   title: string;
   status: "running" | "done" | "error";
   errorText?: string;
   output: string;
}) {
   const verb = options.status === "error" ? "failed" : "finished";
   let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
   if (options.errorText) text += `\nError: ${options.errorText}`;
   text += `\n\n${options.output}`;
   return text;
}
