import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentActivityEvent, AgentActivityPhase, AgentActivityScope, AgentActivityState } from "../domain.js";

export type AgentActivityReadResult =
   | { readonly ok: true; readonly activity: AgentActivityState }
   | { readonly ok: false; readonly reason: "missing" | "invalid" | "wrong-id"; readonly error?: string };

export interface AgentActivityRecorder {
   sessionStart(): void;
   input(): void;
   beforeAgentStart(): void;
   agentStart(): void;
   agentEndWaiting(): void;
   agentEndDone(): void;
   turnStart(turnIndex?: number): void;
   turnEnd(turnIndex?: number): void;
   beforeProviderRequest(): void;
   afterProviderResponse(): void;
   messageUpdate(messageEventType?: string): void;
   toolExecutionStart(toolCallId?: string, toolName?: string): void;
   toolCall(toolCallId?: string, toolName?: string): void;
   toolExecutionUpdate(toolCallId?: string, toolName?: string): void;
   toolResult(toolCallId?: string, toolName?: string): void;
   toolExecutionEnd(toolCallId?: string, toolName?: string): void;
   subagentDone(): void;
   sessionShutdown(): void;
}

const ACTIVITY_UPDATE_THROTTLE_MS = 300;
const MAX_WRITE_FAILURES = 3;
const MAX_ACTIVITY_STRING_LENGTH = 200;
const PHASES = new Set<AgentActivityPhase>(["starting", "active", "waiting", "done"]);
const SCOPES = new Set<AgentActivityScope>(["agent", "turn", "provider", "streaming", "tool"]);
const EVENTS = new Set<AgentActivityEvent>([
   "session_start",
   "input",
   "before_agent_start",
   "agent_start",
   "agent_end",
   "turn_start",
   "turn_end",
   "before_provider_request",
   "after_provider_response",
   "message_update",
   "tool_execution_start",
   "tool_call",
   "tool_execution_update",
   "tool_result",
   "tool_execution_end",
   "subagent_done",
   "session_shutdown"
]);

type MutableActivity = { -readonly [Key in keyof AgentActivityState]: AgentActivityState[Key] };

export function getAgentActivityFile(sessionFile: string): string {
   return `${sessionFile}.activity.json`;
}

export function createAgentActivityState(runningChildId: string, now = Date.now()): AgentActivityState {
   return {
      version: 1,
      runningChildId,
      createdAt: now,
      updatedAt: now,
      sequence: 0,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false
   };
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validOptionalString(value: unknown): boolean {
   return (
      value === undefined ||
      (typeof value === "string" && value.length <= MAX_ACTIVITY_STRING_LENGTH && !/[\r\n]/.test(value))
   );
}

function validOptionalNumber(value: unknown): boolean {
   return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validateActivity(value: unknown, expectedId: string): AgentActivityReadResult {
   if (!isRecord(value)) return { ok: false, reason: "invalid", error: "activity must be an object" };
   if (value.version !== 1) return { ok: false, reason: "invalid", error: "unsupported activity version" };
   if (value.runningChildId !== expectedId) return { ok: false, reason: "wrong-id" };
   if (typeof value.latestEvent !== "string" || !EVENTS.has(value.latestEvent as AgentActivityEvent)) {
      return { ok: false, reason: "invalid", error: "unknown latestEvent" };
   }
   if (typeof value.phase !== "string" || !PHASES.has(value.phase as AgentActivityPhase)) {
      return { ok: false, reason: "invalid", error: "unknown phase" };
   }
   if (
      value.activeScope !== undefined &&
      (typeof value.activeScope !== "string" || !SCOPES.has(value.activeScope as AgentActivityScope))
   ) {
      return { ok: false, reason: "invalid", error: "unknown activeScope" };
   }
   const requiredNumbers = ["createdAt", "updatedAt", "sequence"];
   if (requiredNumbers.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      return { ok: false, reason: "invalid", error: "invalid activity timing" };
   }
   const requiredBooleans = ["agentActive", "turnActive", "providerActive", "toolActive"];
   if (requiredBooleans.some((key) => typeof value[key] !== "boolean")) {
      return { ok: false, reason: "invalid", error: "invalid activity flags" };
   }
   if (
      ["activeSince", "waitingSince", "turnIndex", "toolStartedAt", "toolEndedAt"].some(
         (key) => !validOptionalNumber(value[key])
      )
   ) {
      return { ok: false, reason: "invalid", error: "invalid activity number" };
   }
   if (["messageEventType", "toolCallId", "toolName"].some((key) => !validOptionalString(value[key]))) {
      return { ok: false, reason: "invalid", error: "invalid activity text" };
   }
   return { ok: true, activity: value as unknown as AgentActivityState };
}

export function readAgentActivityFile(activityFile: string, expectedRunningChildId: string): AgentActivityReadResult {
   if (!existsSync(activityFile)) return { ok: false, reason: "missing" };
   try {
      return validateActivity(JSON.parse(readFileSync(activityFile, "utf8")), expectedRunningChildId);
   } catch (error) {
      return { ok: false, reason: "invalid", error: error instanceof Error ? error.message : String(error) };
   }
}

export function writeAgentActivityFile(activityFile: string, activity: AgentActivityState): void {
   const directory = dirname(activityFile);
   mkdirSync(directory, { recursive: true });
   const temporary = join(directory, `.${activity.runningChildId}.${process.pid}.${activity.sequence}.tmp`);
   try {
      writeFileSync(temporary, `${JSON.stringify(activity)}\n`, "utf8");
      renameSync(temporary, activityFile);
   } catch (error) {
      try {
         unlinkSync(temporary);
      } catch {
         // Cleanup is best effort.
      }
      throw error;
   }
}

function clearActiveState(activity: MutableActivity): void {
   activity.agentActive = false;
   activity.turnActive = false;
   activity.providerActive = false;
   activity.toolActive = false;
   delete activity.activeScope;
   delete activity.activeSince;
}

function refreshActiveScope(activity: MutableActivity): void {
   if (activity.toolActive) {
      activity.phase = "active";
      activity.activeScope = "tool";
      return;
   }
   if (activity.providerActive) {
      activity.phase = "active";
      activity.activeScope = "provider";
      return;
   }
   if (activity.turnActive) {
      activity.phase = "active";
      activity.activeScope = "turn";
      return;
   }
   if (activity.agentActive) {
      activity.phase = "active";
      activity.activeScope = "agent";
      return;
   }
   delete activity.activeScope;
   delete activity.activeSince;
}

function markActive(activity: MutableActivity, scope: AgentActivityScope, observedAt: number, reset = false): void {
   activity.phase = "active";
   activity.activeScope = scope;
   if (activity.activeSince === undefined || reset) activity.activeSince = observedAt;
   delete activity.waitingSince;
}

function noopRecorder(): AgentActivityRecorder {
   return {
      sessionStart() {},
      input() {},
      beforeAgentStart() {},
      agentStart() {},
      agentEndWaiting() {},
      agentEndDone() {},
      turnStart() {},
      turnEnd() {},
      beforeProviderRequest() {},
      afterProviderResponse() {},
      messageUpdate() {},
      toolExecutionStart() {},
      toolCall() {},
      toolExecutionUpdate() {},
      toolResult() {},
      toolExecutionEnd() {},
      subagentDone() {},
      sessionShutdown() {}
   };
}

export function createAgentActivityRecorder(params: {
   runningChildId?: string;
   activityFile?: string;
   now?: () => number;
}): AgentActivityRecorder {
   const runningChildId = params.runningChildId?.trim();
   const activityFile = params.activityFile?.trim();
   if (!runningChildId || !activityFile) return noopRecorder();

   const now = params.now ?? (() => Date.now());
   const activity = createAgentActivityState(runningChildId, now()) as MutableActivity;
   let disabled = false;
   let failures = 0;
   let lastFlushAt = 0;
   let pendingFlush: ReturnType<typeof setTimeout> | undefined;

   const clearPending = () => {
      if (pendingFlush) clearTimeout(pendingFlush);
      pendingFlush = undefined;
   };
   const disable = () => {
      disabled = true;
      clearPending();
   };
   const flushNow = () => {
      if (disabled) return;
      try {
         writeAgentActivityFile(activityFile, activity);
         lastFlushAt = now();
         failures = 0;
      } catch {
         failures += 1;
         if (failures >= MAX_WRITE_FAILURES) disable();
      }
   };
   const schedule = () => {
      if (disabled || pendingFlush) return;
      const remaining = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt));
      if (remaining === 0) {
         flushNow();
         return;
      }
      pendingFlush = setTimeout(() => {
         pendingFlush = undefined;
         flushNow();
      }, remaining);
      pendingFlush.unref?.();
   };
   const record = (
      event: AgentActivityEvent,
      update: (current: MutableActivity, observedAt: number) => void,
      mode: "immediate" | "throttled" = "immediate"
   ) => {
      if (disabled) return;
      if (mode === "immediate") clearPending();
      const observedAt = now();
      activity.latestEvent = event;
      activity.updatedAt = observedAt;
      activity.sequence += 1;
      update(activity, observedAt);
      if (mode === "immediate") flushNow();
      else schedule();
   };
   const done = (event: AgentActivityEvent) => {
      record(event, (current) => {
         current.phase = "done";
         clearActiveState(current);
         delete current.waitingSince;
      });
      disable();
   };

   return {
      sessionStart: () =>
         record("session_start", (current) => {
            current.phase = "starting";
            clearActiveState(current);
            delete current.waitingSince;
         }),
      input: () => record("input", () => {}),
      beforeAgentStart: () =>
         record("before_agent_start", (current, observedAt) => {
            current.agentActive = true;
            markActive(current, "agent", observedAt);
         }),
      agentStart: () =>
         record("agent_start", (current, observedAt) => {
            current.agentActive = true;
            markActive(current, "agent", observedAt);
         }),
      agentEndWaiting: () =>
         record("agent_end", (current, observedAt) => {
            clearActiveState(current);
            current.phase = "waiting";
            current.waitingSince = observedAt;
         }),
      agentEndDone: () => done("agent_end"),
      turnStart: (turnIndex) =>
         record("turn_start", (current, observedAt) => {
            current.agentActive = true;
            current.turnActive = true;
            if (turnIndex !== undefined) current.turnIndex = turnIndex;
            markActive(
               current,
               current.toolActive || current.providerActive ? (current.activeScope ?? "turn") : "turn",
               observedAt
            );
         }),
      turnEnd: (turnIndex) =>
         record("turn_end", (current) => {
            current.turnActive = false;
            current.providerActive = false;
            current.toolActive = false;
            if (turnIndex !== undefined) current.turnIndex = turnIndex;
            refreshActiveScope(current);
         }),
      beforeProviderRequest: () =>
         record("before_provider_request", (current, observedAt) => {
            current.providerActive = true;
            markActive(current, "provider", observedAt, true);
         }),
      afterProviderResponse: () =>
         record("after_provider_response", (current) => {
            current.providerActive = false;
            refreshActiveScope(current);
         }),
      messageUpdate: (messageEventType) =>
         record(
            "message_update",
            (current, observedAt) => {
               current.agentActive = true;
               current.turnActive = true;
               current.messageEventType = messageEventType;
               if (!current.toolActive) markActive(current, "streaming", observedAt);
            },
            "throttled"
         ),
      toolExecutionStart: (toolCallId, toolName) =>
         record("tool_execution_start", (current, observedAt) => {
            current.toolActive = true;
            current.toolCallId = toolCallId;
            current.toolName = toolName;
            current.toolStartedAt = observedAt;
            markActive(current, "tool", observedAt, true);
         }),
      toolCall: (toolCallId, toolName) =>
         record("tool_call", (current, observedAt) => {
            current.toolActive = true;
            current.toolCallId = toolCallId ?? current.toolCallId;
            current.toolName = toolName ?? current.toolName;
            markActive(current, "tool", observedAt);
         }),
      toolExecutionUpdate: (toolCallId, toolName) =>
         record(
            "tool_execution_update",
            (current, observedAt) => {
               current.toolActive = true;
               current.toolCallId = toolCallId ?? current.toolCallId;
               current.toolName = toolName ?? current.toolName;
               markActive(current, "tool", observedAt);
            },
            "throttled"
         ),
      toolResult: (toolCallId, toolName) =>
         record("tool_result", (current) => {
            current.toolCallId = toolCallId ?? current.toolCallId;
            current.toolName = toolName ?? current.toolName;
            refreshActiveScope(current);
         }),
      toolExecutionEnd: (toolCallId, toolName) =>
         record("tool_execution_end", (current, observedAt) => {
            current.toolActive = false;
            current.toolCallId = toolCallId ?? current.toolCallId;
            current.toolName = toolName ?? current.toolName;
            current.toolEndedAt = observedAt;
            refreshActiveScope(current);
         }),
      subagentDone: () => done("subagent_done"),
      sessionShutdown: () => done("session_shutdown")
   };
}
