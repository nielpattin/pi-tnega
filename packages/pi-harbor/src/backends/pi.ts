import { isContextOverflow } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import {
   ControlError,
   CancelError,
   type ControlMode,
   type BackendCapabilities,
   type JobTranscriptContent,
   type JobTranscriptEntry
} from "../domain.js";

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
         systemPrompt: params.agentDef.body
      },
      createSessionOptions: {}
   };
}

/**
 * Ensure Pi's automatic context compaction is enabled for a Harbor child task
 * session, while leaving an explicit user/project disable in place.
 *
 * Pi already defaults compaction to `true`, but child task sessions should make
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
   const requested = [...allowedTools, "submit", "hub"];
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
         const details = event.result?.details ?? event.result;
         if (details?.ok === false) {
            if (this.isSchemaRejection(details)) {
               this.correctiveSubmit = true;
            }
            return;
         }
         if (details?.status === "failed") {
            this.settle("failed", undefined, String(details.errorText ?? details.error ?? "Task submission failed"));
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
            "Your previous response did not complete the task. Do not explain or summarize. Call submit now.";
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
import { handleSubmit, SubmitToolParamsSchema } from "../tools/submit.js";
import { handleHub, HubToolParamsSchema } from "../tools/hub.js";

export function createWorkerSubmitTool(
   runEffect: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>,
   jobId: string,
   expectedSchema?: unknown
) {
   return {
      name: "submit",
      label: "Submit",
      description:
         "Submit the complete self-contained task result or error. result.data must contain every detail the parent needs and must never refer to text above or the private worker transcript. This is the only valid way to complete a Harbor worker task. If submit returns validation errors, correct the result data and call submit again through the same tool.",
      promptSnippet: "Use submit as the final action to complete the Harbor worker task",
      promptGuidelines: [
         "Use submit exactly once as the final action after completing the worker task.",
         "Use submit with { result: { data: ... } } for success or { result: { error: ... } } for failure.",
         "Use submit result.data for the full self-contained answer, not a short summary or a reference to previous assistant prose.",
         "Do not emit a final assistant answer before or after calling submit.",
         "If submit returns schema validation errors, correct the result data and call submit again through the same tool."
      ],
      parameters: SubmitToolParamsSchema,
      async execute(_toolCallId: string, params: any) {
         try {
            const res = await runEffect(handleSubmit(params, { jobId, expectedSchema, settleJob: false }));
            return {
               content: [{ type: "text" as const, text: JSON.stringify(res) }],
               details: { ...res, result: params.result },
               terminate: res && typeof res === "object" && "ok" in res && res.ok === true ? (true as const) : undefined
            };
         } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return {
               content: [{ type: "text" as const, text: errorMsg }],
               details: { ok: false, error: errorMsg },
               terminate: undefined
            };
         }
      }
   };
}

export function createWorkerHubTool(runEffect: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>) {
   return {
      name: "hub",
      label: "Hub",
      description: "Worker messaging and sync shell exec.",
      parameters: HubToolParamsSchema,
      async execute(_toolCallId: string, params: any) {
         try {
            const res = await runEffect(handleHub(params, { isWorker: true, harness: "pi" }));
            return {
               content: [{ type: "text" as const, text: JSON.stringify(res) }],
               details: res
            };
         } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return {
               content: [{ type: "text" as const, text: errorMsg }],
               details: { ok: false, error: errorMsg }
            };
         }
      }
   };
}

export interface SpawnPiSessionOptions {
   jobId: string;
   sessionName?: string;
   prompt: string;
   cwd?: string;
   parentSessionFile?: string;
   agentDef?: {
      body: string;
      model?: string;
      thinking?: string;
      tools?: readonly string[];
   };
   specModel?: string;
   specThinking?: string;
   specTools?: readonly string[];
   outputSchema?: unknown;
   modelRegistry?: any;
   modelRuntime?: any;
   inheritedModel?: { provider: string; id: string };
   runEffect: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;
   onSettled?: (status: "completed" | "failed" | "cancelled", data?: unknown, errorText?: string) => void;
   onOutput?: (rawText: string) => void;
   onTranscript?: (entries: ReadonlyArray<JobTranscriptEntry>) => void;
   onSessionReady?: (metadata: {
      model?: string;
      thinking?: string;
      cwd: string;
      sessionFile?: string;
      sessionId?: string;
   }) => Promise<void> | void;
   createSessionFn?: typeof createAgentSession;
   resourceLoader?: DefaultResourceLoader;
}

const PI_WORKER_TOOL_GUIDANCE = `## Harbor worker tool guidance

Use the built-in find tool with { "path": "extensions/copy-all", "pattern": "*" } when listing a directory. Put the directory in find.path and a filename glob in find.pattern. Do not put directory paths inside find.pattern.

## Mandatory Harbor completion contract

Complete the task only by calling submit exactly once as your final action. Use { "result": { "data": ... } } for success or { "result": { "error": "..." } } for failure. Do not write a final assistant answer before or after submit. A task is not complete until submit succeeds.

Submit a complete, self-contained result with every detail the parent needs. Put the detailed findings, decisions, paths, changes, verification, risks, and next steps directly inside result.data as applicable. Never refer to text above, previous prose, or the worker transcript because the parent receives the submitted data, not your private session narrative. Do not submit a summary that omits the detailed answer.

If the task specifies an outputSchema, submit.result.data must validate against it before the task can complete. If submit returns validation errors, correct the data and call submit again through the same tool.

MANDATORY: You must end every task by calling submit. Never finish with a normal assistant response.`;

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

   const loader =
      options.resourceLoader ??
      new DefaultResourceLoader({
         cwd,
         agentDir,
         settingsManager,
         systemPrompt: `${options.agentDef?.body ?? ""}\n\n${PI_WORKER_TOOL_GUIDANCE}`
      });
   if (!options.resourceLoader) await loader.reload();

   const modelHint = options.specModel ?? options.agentDef?.model;
   const model = options.modelRegistry
      ? resolvePiModel(options.modelRegistry, modelHint, options.inheritedModel)
      : undefined;

   const thinkingHint = options.specThinking ?? options.agentDef?.thinking;
   const thinkingLevel = thinkingHint ? mapThinkingLevel(thinkingHint) : undefined;

   const submitTool = createWorkerSubmitTool(options.runEffect, options.jobId, options.outputSchema);
   const hubTool = createWorkerHubTool(options.runEffect);

   const createSessionOptions: any = {
      cwd,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      customTools: [submitTool, hubTool],
      excludeTools: ["task", "bash"]
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
   const { session: childSession } = await createSession(createSessionOptions);

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

   await notifySessionReady();
   await childSession.bindExtensions({ mode: "print" });

   const allowedTools = options.specTools ?? options.agentDef?.tools ?? ["read", "write", "edit", "grep", "find"];
   configureChildTools(childSession, allowedTools);

   const runner = new PiSessionRunner({
      session: childSession,
      modelContextWindow: childSession.model?.contextWindow,
      onSettle: (status, data, errorText) => {
         Promise.resolve(notifySessionReady())
            .then(() => {
               options.onSettled?.(status, data, errorText);
            })
            .catch(() => {
               options.onSettled?.(status, data, errorText);
            });
      }
   });

   let liveText = "";
   const transcript: JobTranscriptEntry[] = [];
   const emitTranscript = () => options.onTranscript?.([...transcript]);
   const appendAssistantDelta = (delta: string) => {
      liveText += delta;
      const previous = transcript.at(-1);
      if (previous?.type === "assistant") {
         transcript[transcript.length - 1] = { ...previous, text: previous.text + delta };
      } else {
         transcript.push({ type: "assistant", text: delta });
      }
      options.onOutput?.(liveText);
      emitTranscript();
   };
   const appendThinkingDelta = (delta: string) => {
      const previous = transcript.at(-1);
      if (previous?.type === "thinking") {
         transcript[transcript.length - 1] = { ...previous, text: previous.text + delta };
      } else {
         transcript.push({ type: "thinking", text: delta });
      }
      emitTranscript();
   };
   const normalizeToolResultContent = (result: unknown): ReadonlyArray<JobTranscriptContent> => {
      const content =
         result && typeof result === "object" && "content" in result && Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
      return content.flatMap((item: any): JobTranscriptContent[] => {
         if (item?.type === "text" && typeof item.text === "string") {
            return [{ type: "text", text: item.text }];
         }
         if (item?.type === "image" && typeof item.mimeType === "string") {
            return [{ type: "image", mimeType: item.mimeType }];
         }
         return [];
      });
   };
   const handleLiveEvent = (event: any) => {
      if (event?.type === "message_update") {
         const streamEvent = event.assistantMessageEvent;
         if (streamEvent?.type === "text_delta" && typeof streamEvent.delta === "string") {
            appendAssistantDelta(streamEvent.delta);
         } else if (streamEvent?.type === "thinking_delta" && typeof streamEvent.delta === "string") {
            appendThinkingDelta(streamEvent.delta);
         }
      } else if (event?.type === "tool_execution_start") {
         transcript.push({
            type: "tool-call",
            toolCallId: String(event.toolCallId ?? ""),
            toolName: String(event.toolName ?? "unknown"),
            arguments: event.args,
            raw: {
               type: "tool_execution_start",
               toolCallId: event.toolCallId,
               toolName: event.toolName,
               args: event.args
            }
         });
         emitTranscript();
      } else if (event?.type === "tool_execution_end") {
         transcript.push({
            type: "tool-result",
            toolCallId: String(event.toolCallId ?? ""),
            toolName: String(event.toolName ?? "unknown"),
            content: normalizeToolResultContent(event.result),
            isError: event.isError === true,
            raw: {
               type: "tool_execution_end",
               toolCallId: event.toolCallId,
               toolName: event.toolName,
               result: event.result,
               isError: event.isError === true
            }
         });
         emitTranscript();
      }
   };

   const unsubscribe = childSession.subscribe
      ? childSession.subscribe((event) => {
           handleLiveEvent(event);
           runner.handleEvent(event);
           Promise.resolve(notifySessionReady()).catch(() => {});
        })
      : undefined;

   Promise.resolve(childSession.prompt(options.prompt)).catch(() => {});

   return {
      session: childSession,
      unsubscribe,
      abort: () => cancelSession(childSession, 5000),
      control: (text: string, mode: ControlMode) => {
         transcript.push({ type: "user", text });
         emitTranscript();
         return routeControl(childSession, text, mode);
      }
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

export class PiBackend extends Context.Service<PiBackend, PiBackendShape>()("harbor/PiBackend") {
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
