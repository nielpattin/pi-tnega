import { existsSync, readFileSync, rmSync } from "node:fs";
import { readAgentActivityFile, type AgentActivityReadResult } from "./agent-activity.ts";

const ABORT_MESSAGE = "Aborted while waiting for agent to finish";
const TERMINAL_SENTINEL = /__PI_AGENT_DONE_(-?\d+)__/;

export type AgentCompletionResult =
   | { readonly reason: "done"; readonly exitCode: number }
   | { readonly reason: "error"; readonly exitCode: number; readonly errorMessage: string }
   | {
        readonly reason: "ping";
        readonly exitCode: number;
        readonly ping: { readonly name: string; readonly message: string };
     };

export interface AgentExitSidecar {
   readonly type: "done" | "error" | "ping";
   readonly errorMessage?: string;
   readonly stopReason?: string;
   readonly name?: string;
   readonly message?: string;
}

export interface AgentCompletionOptions {
   readonly intervalMs?: number;
   readonly exitFile: string;
   readonly activityFile?: string;
   readonly runningChildId?: string;
   readonly readTerminalTail?: () => Promise<string>;
   readonly inspectPane?: () => Promise<"present" | "missing" | "unavailable">;
   readonly processExited?: () => number | null;
   readonly paneDisappearanceGraceMs?: number;
   readonly onActivitySnapshot?: (
      activity: Extract<AgentActivityReadResult, { readonly ok: true }>["activity"]
   ) => void;
   readonly onTick?: (elapsedSeconds: number) => void;
}

export function interpretAgentExitSidecar(payload: unknown): AgentCompletionResult {
   const sidecar = payload as Partial<AgentExitSidecar> | null;
   if (sidecar?.type === "done") return { reason: "done", exitCode: 0 };
   if (sidecar?.type === "ping") {
      return {
         reason: "ping",
         exitCode: 0,
         ping: {
            name: typeof sidecar.name === "string" && sidecar.name.length > 0 ? sidecar.name : "agent",
            message: typeof sidecar.message === "string" ? sidecar.message : ""
         }
      };
   }
   if (sidecar?.type === "error") {
      return {
         reason: "error",
         exitCode: 1,
         errorMessage:
            typeof sidecar.errorMessage === "string" && sidecar.errorMessage.trim()
               ? sidecar.errorMessage
               : "Agent exited with an error and did not provide a message."
      };
   }
   return {
      reason: "error",
      exitCode: 1,
      errorMessage: "Invalid agent completion sidecar: unsupported payload type."
   };
}

export function consumeAgentExitSidecar(exitFile: string): AgentCompletionResult | null {
   if (!existsSync(exitFile)) return null;
   try {
      const result = interpretAgentExitSidecar(JSON.parse(readFileSync(exitFile, "utf8")));
      rmSync(exitFile, { force: true });
      return result;
   } catch {
      // The child may still be replacing the sidecar. Retry on the next poll.
      return null;
   }
}

/** Per-agent run stats read back from a child session file. */
export interface SessionStats {
   /** Total model cost in dollars. */
   readonly cost: number;
   /** Number of tool calls issued by the agent. */
   readonly toolCalls: number;
   /** Largest observed context footprint in tokens. */
   readonly contextTokens: number;
}

/** Zeroed run stats for aborted runs or unreadable sessions. */
export function emptySessionStats(): SessionStats {
   return { cost: 0, toolCalls: 0, contextTokens: 0 };
}

/**
 * Aggregate cost, tool calls, and context footprint from assistant messages
 * in a child session file. Tolerates missing or partially written files.
 */
export function readSessionStats(sessionFile: string): SessionStats {
   let cost = 0;
   let toolCalls = 0;
   let contextTokens = 0;
   try {
      for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
         if (!line.trim()) continue;
         let entry: any;
         try {
            entry = JSON.parse(line);
         } catch {
            continue;
         }
         if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
         const usage = entry.message.usage;
         if (typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total)) {
            cost += usage.cost.total;
         }
         if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
            contextTokens = Math.max(contextTokens, usage.totalTokens);
         }
         if (Array.isArray(entry.message.content)) {
            for (const part of entry.message.content) {
               if (part?.type === "toolCall") toolCalls += 1;
            }
         }
      }
   } catch {
      // Stats are informational; completion evidence stands on its own.
   }
   return { cost, toolCalls, contextTokens };
}
function terminalExitCode(screen: string): number | null {
   const match = screen.match(TERMINAL_SENTINEL);
   return match ? Number.parseInt(match[1], 10) : null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
   if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));
   return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
         clearTimeout(timer);
         reject(new Error(ABORT_MESSAGE));
      };
      const timer = setTimeout(() => {
         signal.removeEventListener("abort", onAbort);
         resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
   });
}

async function waitForCompletionSidecar(
   signal: AbortSignal,
   options: AgentCompletionOptions,
   graceMs: number
): Promise<AgentCompletionResult | null> {
   const deadline = Date.now() + Math.max(0, graceMs);
   while (Date.now() <= deadline) {
      if (signal.aborted) throw new Error(ABORT_MESSAGE);
      const result = consumeAgentExitSidecar(options.exitFile);
      if (result) return result;
      await abortableDelay(Math.min(25, Math.max(1, deadline - Date.now())), signal);
   }
   return null;
}

export async function waitForAgentCompletion(
   signal: AbortSignal,
   options: AgentCompletionOptions
): Promise<AgentCompletionResult> {
   const startedAt = Date.now();
   let lastActivitySequence = -1;
   for (;;) {
      if (signal.aborted) throw new Error(ABORT_MESSAGE);

      const sidecarResult = consumeAgentExitSidecar(options.exitFile);
      if (sidecarResult) return sidecarResult;

      if (options.activityFile && options.runningChildId && options.onActivitySnapshot) {
         const activity = readAgentActivityFile(options.activityFile, options.runningChildId);
         if (activity.ok && activity.activity.sequence > lastActivitySequence) {
            lastActivitySequence = activity.activity.sequence;
            options.onActivitySnapshot(activity.activity);
         }
      }

      if (options.readTerminalTail) {
         try {
            const exitCode = terminalExitCode(await options.readTerminalTail());
            if (exitCode !== null)
               return {
                  reason: exitCode === 0 ? "done" : "error",
                  exitCode,
                  ...(exitCode === 0 ? {} : { errorMessage: `Agent exited with code ${exitCode}.` })
               } as AgentCompletionResult;
         } catch {
            // Terminal reads are advisory. Continue with sidecar and process evidence.
         }
      }

      const processExitCode = options.processExited?.();
      if (processExitCode !== undefined && processExitCode !== null) {
         const result = await waitForCompletionSidecar(signal, options, options.paneDisappearanceGraceMs ?? 500);
         if (result) return result;
         return {
            reason: "error",
            exitCode: processExitCode,
            errorMessage: "Agent process exited before completion evidence was recorded."
         };
      }

      if (options.inspectPane) {
         let inspection: "present" | "missing" | "unavailable";
         try {
            inspection = await options.inspectPane();
         } catch {
            inspection = "unavailable";
         }
         if (inspection === "missing") {
            const result = await waitForCompletionSidecar(signal, options, options.paneDisappearanceGraceMs ?? 500);
            if (result) return result;
            return {
               reason: "error",
               exitCode: 1,
               errorMessage: "Agent pane disappeared before completion evidence was recorded."
            };
         }
      }

      options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
      await abortableDelay(Math.max(25, options.intervalMs ?? 300), signal);
   }
}
