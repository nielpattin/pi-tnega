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

import { contentText, isContextOverflow } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
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
import { Type, type TSchema } from "typebox";
import { resolveAgentProfile, type AgentProfile } from "../services/worker-profiles.ts";
import {
   childToolPolicy,
   createChildResources,
   getChildExtensionPathsForTools,
   createChildSessionManager,
   shutdownAndDisposeChildSession
} from "./child-session.ts";
import { createCompactionState, observeCompactionEvent, shouldDeferAgentEnd } from "./compaction.ts";
import { resolveProfileModel } from "../services/model-resolution.ts";
import { createToolCallTimeoutGuard } from "../utils/timeouts.ts";
import { boundTranscript } from "../utils/transcript.ts";
import { computeAssistantUsage, emptyUsage } from "../utils/usage.ts";
import { type AgentUsage, type TranscriptEntry } from "../core/model.ts";
import {
   buildWorkflowAgentPrompt,
   buildWorkflowSummaryTranscript,
   SUMMARY_SYSTEM_PROMPT,
   STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
   STRUCTURED_OUTPUT_TOOL_DESCRIPTION
} from "../core/prompt.ts";
import { safeStringify, truncateUtf8 } from "../utils/serialization.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;

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

export interface AgentSessionMetadata {
   model?: string;
   thinking?: string;
   cwd: string;
   sessionFile?: string;
   sessionId?: string;
   systemPrompt?: string;
}

export type AgentRunnerProfile = Pick<AgentProfile, "name" | "tools" | "model" | "thinking">;

export interface RunAgentOptions {
   prompt: string;
   schema?: unknown;
   profile?: AgentRunnerProfile;
   model?: WorkflowModel;
   thinkingLevel?: ThinkingLevel;
   cwd: string;
   parentSessionFile?: string;
   loader: DefaultResourceLoader;
   settingsManager: SettingsManager;
   modelRegistry: ExtensionContext["modelRegistry"];
   signal?: AbortSignal;
   onSession?: (session: AgentSession) => void;
   onSessionReady?: (metadata: AgentSessionMetadata) => Promise<void> | void;
   onProgress?: (progress: AgentProgress) => void;
   sessionName?: string;
   createSessionFn?: typeof createAgentSession;
   /** Test-only override for the per-tool execution timeout. */
   toolCallTimeoutMs?: number;
   /** Configured fallback model IDs to swap to and retry when the agent fails. */
   fallbackModels?: string[];
}

/** Options for the mandatory final summary request. */
export interface RunWorkflowSummaryOptions {
   /** Summary source data from the previous phase. */
   prompt: string;
   /** Model used for the summary request. */
   model: WorkflowModel;
   /** Optional reasoning level. The summary request never inherits profile tools or prompts. */
   thinkingLevel?: ThinkingLevel;
   modelRegistry: ExtensionContext["modelRegistry"];
   signal: AbortSignal;
   /** Maximum output tokens for the final summary. */
   maxTokens?: number;
   /** Models to retry when the primary summary completion fails. */
   fallbackModels?: WorkflowModel[];
   /** Provider completion implementation, injectable for alternate runtimes and tests. */
   completeFn?: typeof completeSimple;
}

/** Build isolated resources for each concurrent workflow child. */
export function createWorkflowResources(
   cwd: string,
   variant: "plain" | "structured",
   projectTrusted: boolean,
   profile?: AgentProfile
) {
   const appendSystemPrompt = [
      ...(profile?.systemPrompt ? [profile.systemPrompt] : []),
      ...(variant === "structured" ? [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] : [])
   ];
   const additionalExtensionPaths = getChildExtensionPathsForTools(profile?.tools ?? []);
   return createChildResources({
      cwd,
      projectTrusted,
      ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}),
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

/**
 * Run the mandatory final summary as a direct text completion.
 *
 * This intentionally bypasses AgentSession: it supplies the Summary system
 * prompt directly, binds no tools, and does not use structured_output. The
 * assistant's final text is the workflow result.
 */
export async function runWorkflowSummary(options: RunWorkflowSummaryOptions): Promise<AgentOutcome> {
   const models = [options.model, ...(options.fallbackModels ?? [])];
   const metadataFor = (model: WorkflowModel) => ({
      provider: model.provider,
      model: model.id,
      contextWindow: model.contextWindow,
      systemPrompt: SUMMARY_SYSTEM_PROMPT
   });
   const emptyResult = (model: WorkflowModel, error: string, aborted = false): AgentOutcome => ({
      ok: false,
      output: "",
      error,
      aborted,
      usage: emptyUsage(),
      ...metadataFor(model),
      transcript: []
   });

   if (options.signal.aborted) return emptyResult(options.model, "Final summary was aborted", true);

   let lastError = "Final summary failed";
   for (const model of models) {
      if (options.signal.aborted) return emptyResult(model, "Final summary was aborted", true);

      const metadata = metadataFor(model);
      try {
         const auth = await options.modelRegistry.getApiKeyAndHeaders?.(model);
         const maxTokens = Math.max(
            1,
            Math.min(options.maxTokens ?? 8_192, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY)
         );
         const reasoning = options.thinkingLevel === "off" ? undefined : options.thinkingLevel;
         const complete = options.completeFn ?? completeSimple;
         const response = await complete(
            model,
            {
               systemPrompt: SUMMARY_SYSTEM_PROMPT,
               messages: [
                  {
                     role: "user",
                     content: options.prompt,
                     timestamp: Date.now()
                  }
               ]
            },
            {
               ...(auth?.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {}),
               ...(reasoning ? { reasoning } : {}),
               signal: options.signal,
               maxTokens,
               cacheRetention: "none"
            }
         );

         if (options.signal.aborted || response.stopReason === "aborted") {
            return emptyResult(model, "Final summary was aborted", true);
         }
         if (response.stopReason === "error") {
            lastError = response.errorMessage ?? "Final summary failed";
            continue;
         }

         const output = contentText(response.content).trim();
         if (!output) {
            lastError = "Final summary returned no text";
            continue;
         }

         return {
            ok: true,
            output,
            aborted: false,
            usage: computeAssistantUsage([{ role: "assistant", usage: response.usage }]),
            ...metadata,
            transcript: buildWorkflowSummaryTranscript({ prompt: options.prompt, output })
         };
      } catch (error) {
         if (options.signal.aborted) return emptyResult(model, errorText(error), true);
         lastError = errorText(error);
      }
   }

   return emptyResult(models.at(-1) ?? options.model, lastError);
}

export function shouldRetryWorkflowFallback(options: {
   signalAborted: boolean;
   aborted: boolean;
   structuredOutput: unknown;
   structuredOutputStarted: boolean;
   agentWorking: boolean;
   activeToolCalls: number;
   toolCallsStarted: boolean;
}): boolean {
   return (
      !options.signalAborted &&
      !options.aborted &&
      options.structuredOutput === undefined &&
      !options.structuredOutputStarted &&
      !options.agentWorking &&
      options.activeToolCalls === 0 &&
      !options.toolCallsStarted
   );
}

export function resolveModelById(
   registry: ExtensionContext["modelRegistry"],
   modelId: string
): WorkflowModel | undefined {
   if (!registry || !modelId) return undefined;
   const slash = modelId.indexOf("/");
   if (slash > 0) {
      const provider = modelId.slice(0, slash);
      const id = modelId.slice(slash + 1);
      return registry.find(provider, id);
   }
   const all = registry.getAll?.() ?? [];
   const matches = all.filter((m) => m.id === modelId);
   if (matches.length > 0) {
      return registry.find(matches[0].provider, matches[0].id);
   }
   return undefined;
}

export function capWorkflowModelToParentContext(
   model: WorkflowModel | undefined,
   parentModel?: WorkflowModel
): WorkflowModel | undefined {
   const parentContextWindow = parentModel?.contextWindow;
   if (
      !model ||
      typeof model.contextWindow !== "number" ||
      !Number.isFinite(model.contextWindow) ||
      model.contextWindow <= 0 ||
      typeof parentContextWindow !== "number" ||
      !Number.isFinite(parentContextWindow) ||
      parentContextWindow <= 0 ||
      model.contextWindow <= parentContextWindow
   ) {
      return model;
   }
   return { ...model, contextWindow: parentContextWindow };
}

export function resolveWorkflowAgentModel(
   registry: ExtensionContext["modelRegistry"],
   profile: Pick<AgentProfile, "model">,
   inheritedModel?: WorkflowModel
): WorkflowModel | undefined {
   const resolved = resolveProfileModel(
      registry,
      profile,
      inheritedModel ? { provider: inheritedModel.provider, id: inheritedModel.id } : undefined
   );
   return capWorkflowModelToParentContext(resolved ?? inheritedModel, inheritedModel);
}

/** Accept a captured structured result even when the provider reports a late request error. */
export function shouldAcceptStructuredWorkflowResult(options: {
   structuredOutput: unknown;
   aborted: boolean;
   stopReason?: string;
}): boolean {
   return options.structuredOutput !== undefined && !options.aborted && options.stopReason !== "aborted";
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
      if (!profile) throw new Error("The default `worker` agent profile is unavailable.");
      customTools = [
         makeStructuredOutputTool(options.schema ?? DEFAULT_WORKFLOW_OUTPUT_SCHEMA, (value) => {
            structured = value;
         })
      ];
      const model = resolveWorkflowAgentModel(options.modelRegistry, profile, options.model);
      const thinkingLevel = options.thinkingLevel ?? profile.thinking;
      sessionManager = createChildSessionManager(options.cwd, options.parentSessionFile);
      const createSession = options.createSessionFn ?? createAgentSession;
      const modelRuntime = (options.modelRegistry as any)?.runtime;
      ({ session } = await createSession({
         cwd: options.cwd,
         ...(model ? { model } : {}),
         ...(thinkingLevel ? { thinkingLevel } : {}),
         ...(modelRuntime ? { modelRuntime } : {}),
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
   if (options.sessionName && typeof childSession.setSessionName === "function") {
      childSession.setSessionName(options.sessionName);
   }
   options.onSession?.(childSession);
   const profileName = profile?.name;
   const sessionId = sessionManager?.getSessionId();
   const sessionFile = sessionManager?.getSessionFile();
   const rawSystemPrompt = childSession.systemPrompt;
   const systemPrompt = typeof rawSystemPrompt === "string" && rawSystemPrompt.length > 0 ? rawSystemPrompt : undefined;
   const readyMetadata: AgentSessionMetadata = {
      model:
         childSession.model &&
         typeof childSession.model.provider === "string" &&
         typeof childSession.model.id === "string"
            ? `${childSession.model.provider}/${childSession.model.id}`
            : undefined,
      thinking: typeof childSession.thinkingLevel === "string" ? childSession.thinkingLevel : undefined,
      cwd: options.cwd,
      sessionFile,
      sessionId,
      systemPrompt
   };
   try {
      await options.onSessionReady?.(readyMetadata);
   } catch {
      // Session metadata is advisory. Do not fail a child when persistence is unavailable.
   }
   let usage = emptyUsage();
   let providerId = childSession.model?.provider ?? options.model?.provider;
   let modelId = childSession.model?.id ?? options.model?.id;
   let contextWindow = childSession.model?.contextWindow;
   let stopReason: string | undefined;
   let errorMessage: string | undefined;
   let compactionState = createCompactionState();
   let agentWorking = false;
   let structuredOutputStarted = false;
   let toolCallsStarted = false;
   const activeToolCalls = new Set<string>();
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

   const unsubscribe = childSession.subscribe((event) => {
      compactionState = observeCompactionEvent(compactionState, event);
      if (event.type === "agent_start") {
         agentWorking = true;
      } else if (event.type === "agent_end" && shouldDeferAgentEnd(compactionState, event)) {
         return;
      } else if (event.type === "agent_end") {
         agentWorking = false;
      } else if (event.type === "tool_execution_start") {
         toolCallsStarted = true;
         activeToolCalls.add(event.toolCallId);
         if (event.toolName === "structured_output") structuredOutputStarted = true;
      } else if (event.type === "tool_execution_end") {
         activeToolCalls.delete(event.toolCallId);
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
         recordToolExecutionTiming(toolTimings, event);
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
         try {
            await childSession.prompt(
               buildWorkflowAgentPrompt(options.prompt, {
                  requireStructuredOutput: options.schema !== undefined
               })
            );
         } catch (error) {
            errorMessage = errorText(error);
            stopReason = "error";
         }
         sync();

         const shouldFallback = shouldRetryWorkflowFallback({
            signalAborted: options.signal?.aborted === true,
            aborted,
            structuredOutput: structured,
            structuredOutputStarted,
            agentWorking,
            activeToolCalls: activeToolCalls.size,
            toolCallsStarted
         });

         if (shouldFallback && options.fallbackModels && options.fallbackModels.length > 0) {
            for (const fallbackModelId of options.fallbackModels) {
               if (options.signal?.aborted || aborted) break;
               const resolvedFallback = capWorkflowModelToParentContext(
                  resolveModelById(options.modelRegistry, fallbackModelId),
                  options.model
               );
               if (!resolvedFallback) continue;
               try {
                  if (toolCallsStarted || activeToolCalls.size > 0 || agentWorking) break;
                  await childSession.setModel(resolvedFallback);
                  providerId = resolvedFallback.provider;
                  modelId = resolvedFallback.id;
                  contextWindow = resolvedFallback.contextWindow;
                  errorMessage = undefined;
                  stopReason = undefined;

                  await childSession.prompt(
                     "Continue the unfinished task from the existing session and call structured_output when complete."
                  );
                  sync();
                  if (structured !== undefined && stopReason !== "error" && errorMessage === undefined) {
                     break;
                  }
                  if (toolCallsStarted || activeToolCalls.size > 0 || agentWorking) break;
               } catch (fallbackError) {
                  errorMessage = errorText(fallbackError);
                  stopReason = "error";
               }
            }
         }
      }
   } catch (error) {
      errorMessage = errorMessage ?? errorText(error);
      stopReason = stopReason ?? "error";
   } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (abortPromise) await abortPromise;
      unsubscribe();
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

   const hasUsableStructuredResult = shouldAcceptStructuredWorkflowResult({
      structuredOutput: structured,
      aborted,
      stopReason
   });
   const failed = stopReason === "error" || errorMessage !== undefined;
   if (!hasUsableStructuredResult && failed) {
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

   if (!hasUsableStructuredResult) {
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
