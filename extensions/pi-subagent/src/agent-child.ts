import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgentActivityRecorder } from "./shared/agent-activity.ts";

export type AgentCompletionSidecar =
   | { readonly type: "done" }
   | { readonly type: "error"; readonly errorMessage: string; readonly stopReason: "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
   return value !== null && typeof value === "object" && !Array.isArray(value);
}

function latestAssistantError(messages: readonly unknown[] | undefined): string | undefined {
   if (!messages) return undefined;
   for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!isRecord(message) || message.role !== "assistant") continue;
      if (message.stopReason !== "error") return undefined;
      return typeof message.errorMessage === "string" && message.errorMessage.trim()
         ? message.errorMessage.trim()
         : "Agent agent loop ended with an error.";
   }
   return undefined;
}

export function buildAgentCompletionSidecar(messages: readonly unknown[] | undefined): AgentCompletionSidecar {
   const errorMessage = latestAssistantError(messages);
   return errorMessage ? { type: "error", errorMessage, stopReason: "error" } : { type: "done" };
}

export function shouldAutoExitAgent(messages: readonly unknown[] | undefined): boolean {
   if (!messages) return true;
   for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!isRecord(message) || message.role !== "assistant") continue;
      return message.stopReason !== "aborted";
   }
   return true;
}

export function writeAgentCompletionSidecar(exitFile: string, sidecar: AgentCompletionSidecar): void {
   const directory = dirname(exitFile);
   mkdirSync(directory, { recursive: true });
   const temporary = join(directory, `.${process.pid}.${Date.now()}.exit.tmp`);
   try {
      writeFileSync(temporary, `${JSON.stringify(sidecar)}\n`, "utf8");
      renameSync(temporary, exitFile);
   } catch (error) {
      try {
         unlinkSync(temporary);
      } catch {
         // Cleanup is best effort.
      }
      throw error;
   }
}

export default function agentChildExtension(pi: any): void {
   const agentId = process.env.PI_AGENT_ID;
   const sessionFile = process.env.PI_AGENT_SESSION;
   const activityFile = process.env.PI_AGENT_ACTIVITY_FILE;
   const exitFile = sessionFile ? `${sessionFile}.exit` : undefined;
   const autoExit = process.env.PI_AGENT_AUTO_EXIT === "1";
   const recorder = createAgentActivityRecorder({ runningChildId: agentId, activityFile });

   let latestMessages: unknown[] | undefined;
   let completionFinalized = false;

   pi.on("session_start", () => {
      recorder.sessionStart();
   });
   pi.on("input", () => {
      recorder.input();
   });
   pi.on("before_agent_start", (event: any): { systemPrompt: string } | undefined => {
      recorder.beforeAgentStart();
      const childPrompt = process.env.PI_AGENT_SYSTEM_PROMPT;
      if (!childPrompt) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${childPrompt}` };
   });
   pi.on("agent_start", () => {
      recorder.agentStart();
   });
   pi.on("agent_end", (event: any) => {
      latestMessages = Array.isArray(event?.messages) ? event.messages : undefined;
      recorder.agentEndWaiting();
   });
   pi.on("agent_settled", (_event: any, ctx: any) => {
      if (!autoExit || completionFinalized) return;
      let messages = latestMessages;
      try {
         const branchMessages = ctx?.sessionManager
            ?.getBranch?.()
            ?.flatMap((entry: any) => (entry?.type === "message" ? [entry.message] : []));
         if (Array.isArray(branchMessages) && branchMessages.length > 0) messages = branchMessages;
      } catch {
         // Fall back to the latest agent event when session evidence is unavailable.
      }
      if (!shouldAutoExitAgent(messages)) return;
      completionFinalized = true;
      if (exitFile) {
         try {
            writeAgentCompletionSidecar(exitFile, buildAgentCompletionSidecar(messages));
         } catch {
            // The parent still has the process sentinel as a fallback.
         }
      }
      recorder.agentEndDone();
      // Stay open at the final answer so the run can be read in the pane.
      // The parent detects completion through the exit sidecar above.
   });
   pi.on("turn_start", (event: any) => recorder.turnStart(event?.turnIndex));
   pi.on("turn_end", (event: any) => recorder.turnEnd(event?.turnIndex));
   pi.on("before_provider_request", () => recorder.beforeProviderRequest());
   pi.on("after_provider_response", () => recorder.afterProviderResponse());
   pi.on("message_update", (event: any) => recorder.messageUpdate(event?.assistantMessageEvent?.type));
   pi.on("tool_execution_start", (event: any) => recorder.toolExecutionStart(event?.toolCallId, event?.toolName));
   pi.on("tool_call", (event: any) => recorder.toolCall(event?.toolCallId, event?.toolName));
   pi.on("tool_execution_update", (event: any) => recorder.toolExecutionUpdate(event?.toolCallId, event?.toolName));
   pi.on("tool_result", (event: any) => recorder.toolResult(event?.toolCallId, event?.toolName));
   pi.on("tool_execution_end", (event: any) => recorder.toolExecutionEnd(event?.toolCallId, event?.toolName));
   pi.on("session_shutdown", () => recorder.sessionShutdown());
}
