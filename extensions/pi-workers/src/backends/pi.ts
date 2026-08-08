import { isContextOverflow } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { ControlError, CancelError, type ControlMode, type BackendCapabilities } from "../domain.js";

export type { ControlMode };

export const PI_BACKEND_CAPABILITIES: BackendCapabilities = {
   steering: true,
   followUp: true,
   midTurnTools: true,
   modelSelection: true,
   reasoningEffort: true
};

export interface BackendSession {
   readonly capabilities: BackendCapabilities;
   readonly control: (text: string, mode: ControlMode) => Effect.Effect<void, ControlError>;
   readonly abort: () => Effect.Effect<void, CancelError>;
}

export interface SessionControlTarget {
   readonly isStreaming: boolean;
   readonly steer: (text: string) => Promise<void> | void;
   readonly followUp: (text: string) => Promise<void> | void;
   readonly prompt: (text: string) => Promise<void> | void;
}

export interface SessionCancelTarget {
   readonly clearQueue?: () => void;
   readonly abort: () => Promise<void> | void;
}

export const routeControl = Effect.fn("PiBackend.routeControl")(function* (
   session: SessionControlTarget,
   text: string,
   mode: ControlMode
) {
   return yield* Effect.tryPromise({
      try: async () => {
         if (session.isStreaming) {
            if (mode === "steer") {
               await session.steer(text);
            } else {
               await session.followUp(text);
            }
         } else {
            await session.prompt(text);
         }
      },
      catch: (err) =>
         new ControlError({
            message: err instanceof Error ? err.message : String(err)
         })
   });
});

export const cancelSession = Effect.fn("PiBackend.cancelSession")(function* (
   session: SessionCancelTarget,
   timeoutMs: number = 5000
) {
   return yield* Effect.tryPromise({
      try: async () => {
         if (typeof session.clearQueue === "function") {
            session.clearQueue();
         }
         const abortPromise = Promise.resolve(session.abort());
         let timerId: any;
         const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(() => reject(new Error("Abort timed out")), timeoutMs);
         });
         try {
            await Promise.race([abortPromise, timeoutPromise]);
         } finally {
            clearTimeout(timerId);
         }
      },
      catch: (err) =>
         new CancelError({
            message: err instanceof Error ? err.message : String(err)
         })
   });
});

export interface CreateChildInitOptionsParams {
   cwd: string;
   agentDir: string;
   settingsManager: unknown;
   agentDef: {
      body: string;
      tools: readonly string[];
   };
}

export function createChildInitOptions(params: CreateChildInitOptionsParams) {
   return {
      loaderOptions: {
         cwd: params.cwd,
         agentDir: params.agentDir,
         settingsManager: params.settingsManager,
         appendSystemPromptOverride: (base: string[]) => [...base, buildWorkerInstructions(params.agentDef.body)]
      },
      createSessionOptions: {}
   };
}

/**
 * Ensure Pi's automatic context compaction is enabled for a Pi Workers child session
 * session, while leaving an explicit user/project disable in place.
 *
 * Pi already defaults compaction to `true`, but child worker sessions should make
 * that default explicit so long-running workers do not silently inherit a
 * disabled setting from project/global defaults.
 */
export function ensureAutoCompactionEnabled(settingsManager: SettingsManager): void {
   const globalSettings = settingsManager.getGlobalSettings();
   const projectSettings = settingsManager.getProjectSettings();
   const isExplicitlyDisabled = (scope: { compaction?: { enabled?: boolean } | undefined }) =>
      scope.compaction !== undefined && scope.compaction.enabled === false;

   if (isExplicitlyDisabled(globalSettings) || isExplicitlyDisabled(projectSettings)) {
      return;
   }

   settingsManager.applyOverrides({ compaction: { enabled: true } });
}

export function configureChildTools(
   childSession: {
      getAllTools: () => Array<{ name: string }>;
      setActiveToolsByName: (names: string[]) => void;
   },
   allowedTools: readonly string[]
) {
   const available = new Set(childSession.getAllTools().map((t) => t.name));
   if (!available.has("submit")) {
      throw new Error("Workers submit tool is unavailable");
   }
   const requested = [...allowedTools, "submit", "bash"];
   const filtered = [...new Set(requested)].filter((tool) => available.has(tool));
   childSession.setActiveToolsByName(filtered);
}

export interface PiSessionRunnerOptions {
   session: {
      subscribe?: (fn: (event: any) => void) => () => void;
      prompt: (text: string) => Promise<void> | void;
      followUp?: (text: string) => Promise<void> | void;
      clearQueue?: () => void;
      abort: () => Promise<void> | void;
   };
   onSettle: (status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string) => void;
   /** Context window of the active model, used to recognize overflow errors that Pi will recover via auto-compaction. */
   modelContextWindow?: number;
}

export class PiSessionRunner {
   private reminderCount = 0;
   private settled = false;
   private compacting = false;
   private retrying = false;
   private correctiveSubmit = false;

   constructor(private options: PiSessionRunnerOptions) {}

   public handleEvent(event: any): void {
      if (this.settled) return;

      if (event?.type === "compaction_start") {
         this.compacting = true;
         return;
      }
      if (event?.type === "compaction_end") {
         this.compacting = false;
         // If the turn is being continued automatically we wait for the next agent_end.
         // If compaction finished without a retry, the previous agent_end already drove
         // reminder/settlement logic, so we do not add an extra reminder here.
         return;
      }
      if (event?.type === "auto_retry_start") {
         this.retrying = true;
         return;
      }
      if (event?.type === "auto_retry_end") {
         this.retrying = false;
         if (event?.success === false && event?.finalError) {
            this.settle("failed", undefined, String(event.finalError));
         }
         return;
      }

      if (event?.type === "tool_execution_end" && event?.toolName === "submit") {
         if (event.isError === true || event.result?.isError === true) {
            return;
         }
         const details = event.result?.details ?? event.result;
         if (details?.ok === false) {
            if (this.isSchemaRejection(details)) {
               this.correctiveSubmit = true;
            }
            return;
         }
         if (details?.status === "failed") {
            this.settle(
               "failed",
               undefined,
               String(details.result?.error ?? details.errorText ?? details.error ?? "Worker submission failed")
            );
            return;
         }
         const result = event.args?.result ?? details?.result;
         if (result && typeof result === "object") {
            if ("data" in result) {
               this.settle("completed", result.data);
               return;
            }
            if ("error" in result) {
               this.settle("failed", undefined, String(result.error));
               return;
            }
         }
         return;
      }

      if (event?.type === "agent_end") {
         if (this.compacting || this.retrying || event?.willRetry === true) {
            return;
         }
         const lastAssistant = this.lastAssistantMessage(event);
         // Pi handles context overflow via auto-compaction rather than terminal failure.
         // Do not treat an overflow (explicit error or silent window exceedance) as a missing submit.
         if (lastAssistant && isContextOverflow(lastAssistant, this.options.modelContextWindow)) {
            return;
         }
         if (lastAssistant?.stopReason === "aborted") {
            this.settle("cancelled");
            return;
         }
         if (lastAssistant?.stopReason === "stop" && this.hasFinalProse(lastAssistant)) {
            this.tryRemind();
            return;
         }
         if (lastAssistant?.stopReason === "error") {
            const errorText =
               typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.length > 0
                  ? lastAssistant.errorMessage
                  : "Agent failed";
            this.settle("failed", undefined, errorText);
            return;
         }
         if (this.correctiveSubmit) {
            return;
         }
         this.tryRemind();
      }
   }

   private hasFinalProse(message: any): boolean {
      const content = Array.isArray(message?.content) ? message.content : [];
      return content.some(
         (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0
      );
   }

   private isSchemaRejection(details: any): boolean {
      const errorText = typeof details?.error === "string" ? details.error : "";
      const normalized = errorText.toLowerCase();
      return (
         normalized.includes("schema validation") ||
         normalized.includes("schema conversion") ||
         normalized.includes("failed to convert json schema") ||
         normalized === "schema document must be an object."
      );
   }

   private tryRemind(): void {
      if (this.settled || this.compacting || this.retrying) {
         return;
      }
      if (this.reminderCount < 3) {
         this.reminderCount++;
         const reminder =
            "Your previous response did not complete the worker. Do not explain or summarize. Call submit now.";
         if (this.options.session.followUp) {
            Promise.resolve(this.options.session.followUp(reminder)).catch(() => {});
         } else {
            queueMicrotask(() => {
               if (this.settled || this.compacting || this.retrying) return;
               Promise.resolve(this.options.session.prompt(reminder)).catch(() => {});
            });
         }
      } else {
         this.settle("failed", undefined, "Job ended with missing submit after 3 reminders");
      }
   }

   private lastAssistantMessage(event: any): any {
      const messages = Array.isArray(event?.messages) ? event.messages : undefined;
      if (!messages) return undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
         if (messages[i]?.role === "assistant") {
            return messages[i];
         }
      }
      return undefined;
   }

   private settle(status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string): void {
      if (this.settled) return;
      this.settled = true;
      this.options.onSettle(status, data, errorText);
   }
}

import * as fs from "node:fs";
import {
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   SessionManager,
   SettingsManager
} from "@earendil-works/pi-coding-agent";
import { deriveChildSessionDirectory } from "../utils/child-session-dir.js";
import { resolvePiModel, mapThinkingLevel } from "./pi-model.js";
import { createSubmitToolParamsSchema, handleSubmit } from "../tools/submit.js";

export function createWorkerSubmitTool(
   runEffect: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>,
   jobId: string,
   expectedSchema?: unknown
) {
   return {
      name: "submit",
      label: "Submit",
      description:
         "Submit the complete self-contained worker result or error. result.data must contain every detail the parent needs, match the schema shown in this tool's parameters when one is provided, and never refer to text above or the private worker transcript. This is the only valid way to complete a worker. If submit returns validation errors, correct the result data and call submit again through the same tool.",
      promptSnippet: "Use submit as the final action to complete the worker.",
      promptGuidelines: [
         "Use submit exactly once as the final action after completing the worker.",
         "Use submit with { result: { data: ... } } for success or { result: { error: ... } } for failure.",
         "Use submit result.data for the full self-contained answer matching the tool schema, not a short summary or a reference to previous assistant prose.",
         "Do not emit a final assistant answer before or after calling submit.",
         "If submit returns schema validation errors, correct the result data and call submit again through the same tool."
      ],
      parameters: createSubmitToolParamsSchema(expectedSchema),
      async execute(_toolCallId: string, params: any) {
         const res = await runEffect(handleSubmit(params, { jobId, expectedSchema, settleJob: false }));
         if (!res || typeof res !== "object" || !("ok" in res) || res.ok !== true) {
            const errorMessage =
               res && typeof res === "object" && "error" in res ? String(res.error) : "Submission rejected";
            throw new Error(errorMessage);
         }
         return {
            content: [{ type: "text" as const, text: JSON.stringify(res) }],
            details: { ...res, result: params.result },
            terminate: true as const
         };
      }
   };
}

export interface SpawnPiSessionOptions {
   jobId: string;
   sessionName?: string;
   prompt: string;
   cwd?: string;
   signal?: AbortSignal;
   parentSessionFile?: string;
   agentDef?: {
      body: string;
      model?: string;
      thinking?: string;
      tools?: readonly string[];
   };
   specThinking?: string;
   specTools?: readonly string[];
   outputSchema?: unknown;
   modelRegistry?: any;
   modelRuntime?: any;
   inheritedModel?: { provider: string; id: string };
   runEffect: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;
   onSettled?: (status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string) => void;
   onOutput?: (text: string) => void;
   onSessionReady?: (metadata: {
      model?: string;
      thinking?: string;
      cwd: string;
      sessionFile?: string;
      sessionId?: string;
   }) => Promise<void> | void;
   onSystemPrompt?: (systemPrompt: string) => Promise<void> | void;
   createSessionFn?: typeof createAgentSession;
   resourceLoader?: DefaultResourceLoader;
}

/** Strong worker-only completion contract, shared by the Pi backend and extension prompt assembly. */
export const PI_WORKER_SUBMIT_MANDATE = `## MANDATORY COMPLETION CONTRACT

YOU ARE A WORKER. YOUR TURN MUST END WITH A CALL TO THE submit TOOL.

THERE IS NO VALID FINAL TEXT RESPONSE, MESSAGE, SUMMARY, OR EXPLANATION.

DO NOT WRITE A FINAL ASSISTANT ANSWER. DO NOT SAY "DONE". DO NOT EXPLAIN OR SUMMARIZE IN PROSE.

THE ONLY VALID COMPLETION IS:

- submit { "result": { "data": <complete answer> } } for success
- submit { "result": { "error": "<message>" } } for failure

WHEN THE WORK IS COMPLETE, IMMEDIATELY CALL submit. YOUR TEXT IS DISCARDED; ONLY SUBMITTED DATA REACHES THE PARENT.

Submit a complete, self-contained result with every detail the parent needs. Include detailed findings, decisions, paths, changes, verification, risks, and next steps directly inside result.data as applicable. Never refer to text above, previous prose, or the worker transcript. Do not submit a short summary that omits the detailed answer. If the worker specifies an outputSchema, submit.result.data must validate against it before the worker can complete. If submit returns validation errors, correct the result data and call submit again through the same tool.`;

/** Internal delimiters removed after Pi Workers reorders a worker prompt around Pi's native sections. */
export const PI_WORKER_PROMPT_PREFIX_START = "<!-- pi-workers-worker-prompt-prefix -->";
export const PI_WORKER_AGENT_BODY_START = "<!-- pi-workers-worker-agent-body -->";
export const PI_WORKER_AGENT_BODY_END = "<!-- /pi-workers-worker-agent-body -->";
export const PI_WORKER_PROMPT_PREFIX_END = "<!-- /pi-workers-worker-prompt-prefix -->";

const PI_DEFAULT_ROLE_PROMPT =
   "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

function stripPiDefaultRolePrompt(systemPrompt: string): string {
   if (!systemPrompt.startsWith(PI_DEFAULT_ROLE_PROMPT)) return systemPrompt;
   return systemPrompt.slice(PI_DEFAULT_ROLE_PROMPT.length).trimStart();
}

/** Move the selected worker body and contract ahead of Pi's native prompt sections. */
export function buildWorkerSystemPrompt(systemPrompt: string): string {
   const prefixStart = systemPrompt.indexOf(PI_WORKER_PROMPT_PREFIX_START);
   const bodyStart = prefixStart < 0 ? -1 : systemPrompt.indexOf(PI_WORKER_AGENT_BODY_START, prefixStart);
   const bodyEnd = bodyStart < 0 ? -1 : systemPrompt.indexOf(PI_WORKER_AGENT_BODY_END, bodyStart);
   const prefixEnd =
      bodyEnd < 0 ? -1 : systemPrompt.indexOf(PI_WORKER_PROMPT_PREFIX_END, bodyEnd + PI_WORKER_AGENT_BODY_END.length);

   if (prefixStart < 0 || prefixEnd < 0 || bodyStart < 0 || bodyEnd < 0) {
      return `${PI_WORKER_SUBMIT_MANDATE}\n\n${stripPiDefaultRolePrompt(systemPrompt).trim()}`;
   }

   const workerBody = systemPrompt.slice(bodyStart + PI_WORKER_AGENT_BODY_START.length, bodyEnd).trim();
   const nativePrompt = stripPiDefaultRolePrompt(
      `${systemPrompt.slice(0, prefixStart)}${systemPrompt.slice(prefixEnd + PI_WORKER_PROMPT_PREFIX_END.length)}`
   ).trim();
   const workerPrefix = workerBody ? `${workerBody}\n\n${PI_WORKER_SUBMIT_MANDATE}` : PI_WORKER_SUBMIT_MANDATE;
   return `${workerPrefix}\n\n${nativePrompt}`;
}

function buildWorkerInstructions(body: string | undefined): string {
   const workerPromptPrefix = [
      PI_WORKER_PROMPT_PREFIX_START,
      PI_WORKER_AGENT_BODY_START,
      body?.trim(),
      PI_WORKER_AGENT_BODY_END,
      PI_WORKER_SUBMIT_MANDATE,
      PI_WORKER_PROMPT_PREFIX_END
   ]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n\n");
   return workerPromptPrefix;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
   if (!signal) return promise;
   if (signal.aborted) {
      promise.catch(() => {});
      throw new Error("Pi worker startup aborted");
   }

   return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
         if (settled) return;
         settled = true;
         cleanup();
         reject(new Error("Pi worker startup aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
         (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
         },
         (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
         }
      );
   });
}

export async function spawnPiSession(options: SpawnPiSessionOptions) {
   const cwd = options.cwd ?? process.cwd();

   const childSessionDir = deriveChildSessionDirectory(options.parentSessionFile);
   if (childSessionDir) {
      fs.mkdirSync(childSessionDir, { recursive: true });
   }
   const sessionManager = childSessionDir ? SessionManager.create(cwd, childSessionDir) : SessionManager.create(cwd);

   const agentDir = getAgentDir();
   const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
   ensureAutoCompactionEnabled(settingsManager);

   const workerInstructions = buildWorkerInstructions(options.agentDef?.body);
   const loader =
      options.resourceLoader ??
      new DefaultResourceLoader({
         cwd,
         agentDir,
         settingsManager,
         appendSystemPromptOverride: (base) => [...base, workerInstructions]
      });
   if (!options.resourceLoader) await awaitWithAbort(loader.reload(), options.signal);

   const modelHint = options.agentDef?.model;
   const model = options.modelRegistry
      ? resolvePiModel(options.modelRegistry, modelHint, options.inheritedModel)
      : undefined;

   const thinkingHint = options.specThinking ?? options.agentDef?.thinking;
   const thinkingLevel = thinkingHint ? mapThinkingLevel(thinkingHint) : undefined;

   const submitTool = createWorkerSubmitTool(options.runEffect, options.jobId, options.outputSchema);

   const createSessionOptions: any = {
      cwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      customTools: [submitTool],
      excludeTools: ["worker_spawn", "worker_spawn"]
   };

   if (model) {
      createSessionOptions.model = model;
   }
   if (thinkingLevel) {
      createSessionOptions.thinkingLevel = thinkingLevel;
   }
   if (options.modelRuntime) {
      createSessionOptions.modelRuntime = options.modelRuntime;
   }

   const createSession = options.createSessionFn ?? createAgentSession;
   const createSessionPromise = createSession(createSessionOptions).then((result) => {
      if (options.signal?.aborted) {
         Effect.runPromise(cancelSession(result.session, 5000)).catch(() => {});
      }
      return result;
   });
   const { session: childSession } = await awaitWithAbort(createSessionPromise, options.signal);

   if (options.sessionName && typeof childSession.setSessionName === "function") {
      childSession.setSessionName(options.sessionName);
   }

   const buildSessionMetadata = () => {
      const sessionModel = childSession.model;
      const managerFile =
         typeof (sessionManager as any).getSessionFile === "function"
            ? (sessionManager as any).getSessionFile()
            : undefined;
      const managerId =
         typeof (sessionManager as any).getSessionId === "function"
            ? (sessionManager as any).getSessionId()
            : undefined;
      const childSessionId = (childSession as any).sessionId ?? (childSession as any).id;
      return {
         model:
            sessionModel && typeof sessionModel.provider === "string" && typeof sessionModel.id === "string"
               ? `${sessionModel.provider}/${sessionModel.id}`
               : undefined,
         thinking: typeof childSession.thinkingLevel === "string" ? childSession.thinkingLevel : undefined,
         cwd,
         sessionFile: typeof managerFile === "string" ? managerFile : undefined,
         sessionId:
            typeof managerId === "string" ? managerId : typeof childSessionId === "string" ? childSessionId : undefined
      };
   };

   let emittedSessionMetadata: ReturnType<typeof buildSessionMetadata> | undefined = undefined;

   const notifySessionReady = async () => {
      const metadata = buildSessionMetadata();
      if (
         emittedSessionMetadata &&
         metadata.model === emittedSessionMetadata.model &&
         metadata.thinking === emittedSessionMetadata.thinking &&
         metadata.cwd === emittedSessionMetadata.cwd &&
         metadata.sessionFile === emittedSessionMetadata.sessionFile &&
         metadata.sessionId === emittedSessionMetadata.sessionId
      ) {
         return;
      }
      emittedSessionMetadata = metadata;
      await options.onSessionReady?.(metadata);
   };

   await awaitWithAbort(notifySessionReady(), options.signal);
   const bindPromise = childSession.bindExtensions({ mode: "print" }).then(async () => {
      if (options.signal?.aborted) {
         await Effect.runPromise(cancelSession(childSession, 5000));
      }
   });
   await awaitWithAbort(bindPromise, options.signal);

   const allowedTools = options.specTools ?? options.agentDef?.tools ?? ["read", "write", "edit", "grep", "find"];
   configureChildTools(childSession, allowedTools);

   const workerSystemPrompt = childSession.agent?.state?.systemPrompt;
   if (typeof workerSystemPrompt === "string") {
      const orderedSystemPrompt = workerSystemPrompt.includes(PI_WORKER_PROMPT_PREFIX_START)
         ? buildWorkerSystemPrompt(workerSystemPrompt)
         : workerSystemPrompt;
      await awaitWithAbort(Promise.resolve(options.onSystemPrompt?.(orderedSystemPrompt)), options.signal);
   }

   let unsubscribe: (() => void) | undefined;
   const cleanupSubscription = () => {
      unsubscribe?.();
      unsubscribe = undefined;
   };
   let sessionSettled = false;
   const settleOnce = (status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string) => {
      if (sessionSettled) return;
      sessionSettled = true;
      cleanupSubscription();
      Promise.resolve(notifySessionReady())
         .then(() => options.onSettled?.(status, data, errorText))
         .catch(() => options.onSettled?.(status, data, errorText));
   };

   const runner = new PiSessionRunner({
      session: {
         prompt: (text) => childSession.prompt(text),
         followUp: typeof childSession.followUp === "function" ? (text) => childSession.followUp(text) : undefined,
         clearQueue: typeof childSession.clearQueue === "function" ? () => childSession.clearQueue() : undefined,
         abort: () => childSession.abort()
      },
      modelContextWindow: childSession.model?.contextWindow,
      onSettle: settleOnce
   });

   let liveText = "";
   const appendAssistantDelta = (delta: string) => {
      liveText += delta;
      options.onOutput?.(liveText);
   };
   const handleLiveEvent = (event: any) => {
      if (event?.type === "message_update") {
         const streamEvent = event.assistantMessageEvent;
         if (streamEvent?.type === "text_delta" && typeof streamEvent.delta === "string") {
            appendAssistantDelta(streamEvent.delta);
         }
      }
   };

   unsubscribe = childSession.subscribe
      ? childSession.subscribe((event) => {
           handleLiveEvent(event);
           runner.handleEvent(event);
           Promise.resolve(notifySessionReady()).catch(() => {});
        })
      : undefined;

   Promise.resolve()
      .then(() => childSession.prompt(options.prompt))
      .catch((error) => {
         const status = options.signal?.aborted ? "cancelled" : "failed";
         const errorText = error instanceof Error ? error.message : String(error);
         settleOnce(status, undefined, errorText);
         return Effect.runPromise(cancelSession(childSession, 5000)).catch(() => {});
      });

   return {
      session: childSession,
      unsubscribe: cleanupSubscription,
      abort: () =>
         Effect.gen(function* () {
            cleanupSubscription();
            yield* cancelSession(childSession, 5000);
         }),
      control: (text: string, mode: ControlMode) => routeControl(childSession, text, mode)
   };
}

export interface PiBackendShape {
   readonly capabilities: BackendCapabilities;
   readonly spawnSession: (options: SpawnPiSessionOptions) => Promise<{
      session: any;
      unsubscribe?: () => void;
      abort: () => Effect.Effect<void, CancelError>;
      control: (text: string, mode: ControlMode) => Effect.Effect<void, ControlError>;
   }>;
}

export class PiBackend extends Context.Service<PiBackend, PiBackendShape>()("workers/PiBackend") {
   static readonly layer = Layer.effect(
      PiBackend,
      Effect.sync(() =>
         PiBackend.of({
            capabilities: PI_BACKEND_CAPABILITIES,
            spawnSession: spawnPiSession
         })
      )
   );
}
