/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: persistent when the parent has a session file,
 * trust-aware resources, built-in tools, recursive orchestration/user-prompt tools denied, and an optional
 * one-shot `structured_output` tool for every Workflow Agent. Ambient workspace
 * extensions are intentionally not bound to the child session.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
   createAgentSession,
   DefaultResourceLoader,
   defineTool,
   SettingsManager,
   type AgentSession,
   type AgentSessionEvent,
   type AgentSessionEventListener,
   type ExtensionAPI,
   type ExtensionContext,
   type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { resolveAgentProfile, type AgentProfile } from "../shared/agent-profiles.ts";
import {
   childToolPolicy,
   createChildResources,
   createChildSessionManager,
   shutdownAndDisposeChildSession
} from "../shared/child-session.ts";
import { createCompactionState, observeCompactionEvent, shouldDeferAgentEnd } from "../shared/compaction.ts";
import { resolveProfileModel } from "../shared/model-resolution.ts";
import { createToolCallTimeoutGuard } from "../shared/timeouts.ts";
import { boundTranscript } from "../shared/transcript.ts";
import { computeAssistantUsage, emptyUsage } from "../shared/usage.ts";
import { type AgentUsage, type TranscriptEntry } from "./model.ts";
import { buildWorkflowAgentPrompt, STRUCTURED_OUTPUT_TOOL_DESCRIPTION } from "./prompt.ts";
import { safeStringify, truncateUtf8 } from "../shared/serialization.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;

/** Default result shape for agents that do not provide a custom schema. */
export const DEFAULT_WORKFLOW_OUTPUT_SCHEMA = {
   type: "object",
   properties: {
      output: {
         type: "string",
         description: "The concise final answer for the workflow assignment."
      }
   },
   required: ["output"],
   additionalProperties: false
} as const;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
type ToolTimingEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_end" }>;

export interface ToolExecutionTiming {
   startedAt?: number;
   finishedAt?: number;
   durationMs?: number;
}

export interface AgentOutcome {
   ok: boolean;
   /** Final assistant text (may be empty when only structured output was produced). */
   output: string;
   /** Captured structured_output payload from the agent's final action. */
   structured?: unknown;
   error?: string;
   aborted: boolean;
   usage: AgentUsage;
   provider?: string;
   model?: string;
   contextWindow?: number;
   /** Selected profile name for dashboard and recovery metadata. */
   profile?: string;
   /** Persistent child Pi session identifier, when available. */
   sessionId?: string;
   /** Persistent child Pi session file, when available. */
   sessionFile?: string;
   /** Effective system prompt used by the child Pi session, when available. */
   systemPrompt?: string;
   transcript: TranscriptEntry[];
}

export interface AgentProgress {
   preview: string;
   usage: AgentUsage;
   provider?: string;
   model?: string;
   contextWindow?: number;
   profile?: string;
   sessionId?: string;
   sessionFile?: string;
   /** Effective system prompt used by the child Pi session, when available. */
   systemPrompt?: string;
   transcript: TranscriptEntry[];
}

export interface RunAgentOptions {
   prompt: string;
   schema?: unknown;
   profile?: AgentProfile;
   model?: WorkflowModel;
   thinkingLevel?: ThinkingLevel;
   cwd: string;
   parentSessionFile?: string;
   loader: DefaultResourceLoader;
   settingsManager: SettingsManager;
   modelRegistry: ExtensionContext["modelRegistry"];
   signal?: AbortSignal;
   onSession?: (session: AgentSession) => void;
   onProgress?: (progress: AgentProgress) => void;
   /** Test-only override for the per-tool execution timeout. */
   toolCallTimeoutMs?: number;
   /** Test-only override for the first assistant response-event timeout. */
   firstResponseTimeoutMs?: number;
}

/** Build isolated resources for each concurrent workflow child. */
export function createWorkflowResources(
   cwd: string,
   variant: "plain" | "structured",
   projectTrusted: boolean,
   profile?: AgentProfile
) {
   const appendSystemPrompt = profile?.systemPrompt ? [profile.systemPrompt] : [];
   return createChildResources({
      cwd,
      projectTrusted,
      ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {})
   });
}

interface WorkflowToolSession {
   getAllTools(): Array<{ name: string }>;
   getToolDefinition(name: string): ToolDefinition | undefined;
   subscribe(listener: AgentSessionEventListener): () => void;
}

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(session: WorkflowToolSession, timeoutMs?: number) {
   const guard = createToolCallTimeoutGuard(timeoutMs);
   guard.apply(session);
   return session.subscribe((event) => {
      if (event.type === "agent_start") guard.apply(session);
   });
}

function isJsonSchema(value: unknown): value is TSchema {
   if (!value || typeof value !== "object" || Array.isArray(value)) return false;
   const seen = new WeakSet();
   let nodes = 0;
   const validate = (current: unknown, depth: number): boolean => {
      if (++nodes > 10_000 || depth > 24) return false;
      if (current === null || typeof current === "string" || typeof current === "boolean") {
         return true;
      }
      if (typeof current === "number") return Number.isFinite(current);
      if (Array.isArray(current)) {
         return current.every((item) => validate(item, depth + 1));
      }
      if (typeof current !== "object") return false;
      if (seen.has(current)) return false;
      seen.add(current);
      return Object.keys(current).every((key) => {
         if (key === "__proto__" || key === "constructor" || key === "prototype") {
            return false;
         }
         return validate((current as Record<string, unknown>)[key], depth + 1);
      });
   };
   return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
   if (!isJsonSchema(schema)) {
      throw new Error("structured output schema must be a bounded JSON object");
   }
   return Type.Unsafe(schema);
}

/** One-shot terminating tool used as the final action for every Workflow Agent. */
function makeStructuredOutputTool(schema: unknown, capture: (value: unknown) => void): ToolDefinition {
   return defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      parameters: jsonSchemaToTypebox(schema),
      async execute(_toolCallId, params) {
         capture(params);
         return {
            content: [],
            details: params,
            terminate: true
         };
      }
   });
}

function finalOutput(messages: AgentMessage[]): string {
   for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      const text = msg.content
         .filter((part) => part.type === "text")
         .map((part) => part.text)
         .join("\n")
         .trim();
      if (text) return text;
   }
   return "";
}

function defaultWorkflowOutput(value: unknown): string | undefined {
   if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
   const output = (value as { output?: unknown }).output;
   return typeof output === "string" ? output : undefined;
}

function safeJson(value: unknown): string {
   return safeStringify(value, {
      maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
      maxDepth: 12,
      maxNodes: 2_000
   });
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
   timings: Map<string, ToolExecutionTiming>,
   event: ToolTimingEvent,
   observedAt = Date.now()
) {
   const previous = timings.get(event.toolCallId);
   if (event.type === "tool_execution_start") {
      if (previous?.startedAt !== undefined) return;
      timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
      return;
   }
   if (previous?.finishedAt !== undefined) return;
   const durationMs = previous?.startedAt === undefined ? undefined : Math.max(0, observedAt - previous.startedAt);
   timings.set(event.toolCallId, {
      ...previous,
      finishedAt: observedAt,
      ...(durationMs === undefined ? {} : { durationMs })
   });
}

function toolMetadata(toolCallId: string, timings: ReadonlyMap<string, ToolExecutionTiming>) {
   const timing = timings.get(toolCallId);
   return {
      toolCallId: truncateUtf8(toolCallId, 1024),
      ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
      ...(timing?.finishedAt === undefined ? {} : { finishedAt: timing.finishedAt }),
      ...(timing?.durationMs === undefined ? {} : { durationMs: timing.durationMs })
   };
}

/** Convert pi messages into a compact, serializable transcript for the UI. */
export function transcriptFromMessages(
   messages: AgentMessage[],
   toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map()
): TranscriptEntry[] {
   const entries: TranscriptEntry[] = [];
   for (const message of messages) {
      if (message.role === "user") {
         const text =
            typeof message.content === "string"
               ? message.content
               : message.content
                    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
                    .join("\n");
         if (text.trim()) {
            entries.push({ role: "user", text, timestamp: message.timestamp });
         }
         continue;
      }

      if (message.role === "assistant") {
         for (const part of message.content) {
            if (part.type === "text" && part.text.trim()) {
               entries.push({
                  role: "assistant",
                  text: part.text,
                  timestamp: message.timestamp
               });
            } else if (part.type === "thinking" && part.thinking.trim()) {
               entries.push({
                  role: "thinking",
                  text: part.thinking,
                  timestamp: message.timestamp
               });
            } else if (part.type === "toolCall") {
               entries.push({
                  role: "tool",
                  name: part.name,
                  text: safeJson(part.arguments),
                  timestamp: message.timestamp,
                  ...toolMetadata(part.id, toolTimings)
               });
            }
         }
         continue;
      }

      if (message.role !== "toolResult") continue;
      const text = message.content
         .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
         .join("\n");
      entries.push({
         role: "toolResult",
         name: message.toolName,
         text,
         isError: message.isError,
         timestamp: message.timestamp,
         ...toolMetadata(message.toolCallId, toolTimings)
      });
   }
   return entries;
}

function computeUsage(messages: AgentMessage[]): AgentUsage {
   return computeAssistantUsage(messages);
}

function errorText(error: unknown): string {
   return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

function formatTimeout(timeoutMs: number) {
   return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs} ms`;
}

/**
 * Abort a provider turn that does not produce a real assistant response.
 * The timer can be re-armed for every provider turn in one agent prompt.
 */
export function createFirstResponseWatchdog(
   onTimeout: () => Promise<unknown>,
   options: { timeoutMs?: number; model?: string } = {}
) {
   const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
   let timer: ReturnType<typeof setTimeout> | undefined;
   let rejectTimeout: ((reason: Error) => void) | undefined;
   let active = false;
   let timedOut = false;
   const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
   });

   const arm = () => {
      if (!active || timedOut) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
         timer = undefined;
         timedOut = true;
         const model = options.model ? ` for ${options.model}` : "";
         const error = new Error(
            `Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`
         );
         rejectTimeout?.(error);
         void onTimeout().catch(() => {});
      }, timeoutMs);
      timer.unref?.();
   };

   const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
   };

   return {
      arm,
      markResponse: cancel,
      async waitFor<T>(operation: Promise<T>) {
         active = true;
         arm();
         try {
            return await Promise.race([operation, timeout]);
         } finally {
            active = false;
            cancel();
         }
      }
   };
}

/**
 * Identify a real assistant response for the response watchdog.
 * Empty and thinking-only messages can be provider progress events and must
 * not cancel the watchdog before the model produces usable output.
 */
export function isAssistantResponseEvent(event: AgentSessionEvent): boolean {
   if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
      return false;
   }
   if (event.message.role !== "assistant") return false;
   return event.message.content.some((part) => {
      if (part.type === "text") return part.text.trim().length > 0;
      return part.type === "toolCall";
   });
}

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
   let structured: unknown;
   let customTools: ToolDefinition[] | undefined;
   let session: AgentSession | undefined;
   let sessionManager: ReturnType<typeof createChildSessionManager> | undefined;
   let unsubscribeToolTimeout: (() => void) | undefined;
   const profile = options.profile ?? resolveAgentProfile(undefined);
   const toolPolicy = childToolPolicy();
   try {
      if (!profile) throw new Error("The default `good` agent profile is unavailable.");
      customTools = [
         makeStructuredOutputTool(options.schema ?? DEFAULT_WORKFLOW_OUTPUT_SCHEMA, (value) => {
            structured = value;
         })
      ];
      const model = profile.model
         ? resolveProfileModel(
              options.modelRegistry,
              profile,
              options.model ? { provider: options.model.provider, id: options.model.id } : undefined
           )
         : options.model;
      const thinkingLevel = options.thinkingLevel ?? profile.thinking;
      sessionManager = createChildSessionManager(options.cwd, options.parentSessionFile);
      ({ session } = await createAgentSession({
         cwd: options.cwd,
         ...(model ? { model } : {}),
         ...(thinkingLevel ? { thinkingLevel } : {}),
         resourceLoader: options.loader,
         settingsManager: options.settingsManager,
         sessionManager,
         ...(customTools ? { customTools } : {}),
         tools: [...profile.tools, "structured_output"],
         ...toolPolicy
      }));
      unsubscribeToolTimeout = guardWorkflowChildTools(session, options.toolCallTimeoutMs);
   } catch (error) {
      unsubscribeToolTimeout?.();
      if (session) await shutdownAndDisposeChildSession(session);
      return {
         ok: false,
         output: "",
         error: `Failed to create agent session: ${errorText(error)}`,
         aborted: false,
         usage: emptyUsage(),
         provider: options.model?.provider,
         model: options.model?.id,
         contextWindow: options.model?.contextWindow,
         profile: profile?.name,
         sessionId: sessionManager?.getSessionId(),
         sessionFile: sessionManager?.getSessionFile(),
         transcript: []
      };
   }

   const childSession = session;
   options.onSession?.(childSession);
   const profileName = profile?.name;
   const sessionId = sessionManager?.getSessionId();
   const sessionFile = sessionManager?.getSessionFile();
   const rawSystemPrompt = childSession.systemPrompt;
   const systemPrompt = typeof rawSystemPrompt === "string" && rawSystemPrompt.length > 0 ? rawSystemPrompt : undefined;
   let usage = emptyUsage();
   let providerId = childSession.model?.provider ?? options.model?.provider;
   let modelId = childSession.model?.id ?? options.model?.id;
   let contextWindow = childSession.model?.contextWindow;
   let stopReason: string | undefined;
   let errorMessage: string | undefined;
   let compactionState = createCompactionState();
   const toolTimings = new Map<string, ToolExecutionTiming>();

   const sync = () => {
      const messages = childSession.messages;
      usage = computeUsage(messages);

      const sessionModel = childSession.model;
      providerId = sessionModel?.provider ?? providerId;
      modelId = sessionModel?.id ?? modelId;
      contextWindow = sessionModel?.contextWindow ?? contextWindow;
      const context = childSession.getContextUsage();
      if (typeof context?.tokens === "number" && Number.isFinite(context.tokens) && context.tokens >= 0) {
         usage.contextTokens = context.tokens;
      }
      if (
         typeof context?.contextWindow === "number" &&
         Number.isFinite(context.contextWindow) &&
         context.contextWindow > 0
      ) {
         contextWindow = context.contextWindow;
      }

      for (let i = messages.length - 1; i >= 0; i--) {
         const msg = messages[i];
         if (msg.role !== "assistant") continue;
         // Some gateways report a concrete fallback model. Prefer its registry
         // metadata when available so capacity tracks the model that served the
         // latest response rather than a hardcoded/configured guess.
         const responseMatchesSession =
            !sessionModel || (msg.provider === sessionModel.provider && msg.model === sessionModel.id);
         const reportedId = msg.responseModel ?? msg.model;
         const reportedModel = responseMatchesSession
            ? options.modelRegistry.find(msg.provider, reportedId)
            : undefined;
         if (reportedModel) {
            providerId = reportedModel.provider ?? providerId;
            modelId = reportedModel.id;
            contextWindow = reportedModel.contextWindow;
         }
         if (msg.stopReason) stopReason = msg.stopReason;
         if (msg.errorMessage) errorMessage = msg.errorMessage;
         break;
      }
   };

   sync();
   options.onProgress?.({
      preview: "",
      usage,
      provider: providerId,
      model: modelId,
      contextWindow,
      profile: profileName,
      sessionId,
      sessionFile,
      systemPrompt,
      transcript: []
   });

   let responseWatchdog: ReturnType<typeof createFirstResponseWatchdog> | undefined;
   const unsubscribe = childSession.subscribe((event) => {
      compactionState = observeCompactionEvent(compactionState, event);
      if (event.type === "compaction_start") responseWatchdog?.markResponse();
      if (event.type === "compaction_end" || event.type === "auto_retry_end") responseWatchdog?.arm();
      if (event.type === "turn_start") responseWatchdog?.arm();
      if (isAssistantResponseEvent(event)) responseWatchdog?.markResponse();
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
         recordToolExecutionTiming(toolTimings, event);
      } else if (event.type === "agent_end" && shouldDeferAgentEnd(compactionState, event)) {
         return;
      } else if (event.type !== "message_end" && event.type !== "compaction_end") {
         return;
      }
      sync();
      options.onProgress?.({
         preview: finalOutput(childSession.messages),
         usage,
         provider: providerId,
         model: modelId,
         contextWindow,
         profile: profileName,
         sessionId,
         sessionFile,
         systemPrompt,
         transcript: transcriptFromMessages(childSession.messages, toolTimings)
      });
   });

   let aborted = false;
   let abortPromise: Promise<void> | undefined;
   const onAbort = () => {
      aborted = true;
      abortPromise ??= childSession.abort().catch(() => {});
   };
   if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
   }

   let output = "";
   let transcript: TranscriptEntry[] = [];
   try {
      if (!aborted) {
         const watchdog = createFirstResponseWatchdog(() => childSession.abort(), {
            timeoutMs: options.firstResponseTimeoutMs,
            model: modelId
         });
         responseWatchdog = watchdog;
         await watchdog.waitFor(
            childSession.prompt(
               buildWorkflowAgentPrompt(options.prompt, {
                  requireStructuredOutput: options.schema !== undefined
               })
            )
         );
      }
   } catch (error) {
      errorMessage = errorMessage ?? errorText(error);
      stopReason = stopReason ?? "error";
   } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (abortPromise) await abortPromise;
      unsubscribe();
      responseWatchdog = undefined;
      unsubscribeToolTimeout?.();
      sync();
      const finalText = !options.schema ? defaultWorkflowOutput(structured) : undefined;
      output = truncateUtf8(finalText ?? finalOutput(childSession.messages), AGENT_OUTPUT_MAX_BYTES);
      transcript = transcriptFromMessages(childSession.messages, toolTimings);
      await shutdownAndDisposeChildSession(childSession);
   }

   const lastAssistant = childSession.messages.toReversed().find((message) => message.role === "assistant");
   if (lastAssistant && isContextOverflow(lastAssistant, contextWindow)) {
      // Pi may have emitted an intermediate overflow message before compacting.
      // Do not convert that recoverable event into a terminal provider failure.
      stopReason = undefined;
      errorMessage = undefined;
   }

   const sessionMetadata = {
      profile: profileName,
      sessionId,
      sessionFile,
      systemPrompt,
      provider: providerId,
      model: modelId,
      contextWindow
   };

   if (aborted || stopReason === "aborted") {
      return {
         ok: false,
         output,
         structured,
         error: "Agent was aborted",
         aborted: true,
         usage,
         ...sessionMetadata,
         transcript
      };
   }

   const failed = stopReason === "error" || errorMessage !== undefined;
   if (failed) {
      return {
         ok: false,
         output,
         structured,
         error: errorMessage ?? "Agent failed",
         aborted: false,
         usage,
         ...sessionMetadata,
         transcript
      };
   }

   if (structured === undefined) {
      return {
         ok: false,
         output,
         error: "Agent finished without calling structured_output; no structured result matching the schema was produced.",
         aborted: false,
         usage,
         ...sessionMetadata,
         transcript
      };
   }

   return {
      ok: true,
      output,
      structured,
      aborted: false,
      usage,
      ...sessionMetadata,
      transcript
   };
}
