/**
 * Build the user message sent to an isolated agent.
 *
 * Agents finish with an ordinary assistant message. The parent reads that
 * message from the child session after the child publishes its exit marker.
 */
export function buildAgentPrompt(prompt: string): string {
   return prompt;
}

/** System instruction shared by external agent children. */
export const AGENT_SYSTEM_INSTRUCTION =
   "Work autonomously on the assigned task. When complete, return a concise final assistant message that summarizes the result, evidence, and any remaining issue.";
