/**
 * In-process agent runner kept as a small compatibility boundary.
 *
 * The AgentManager uses the external child monitor. This runner remains useful
 * to embedders that provide an AgentSession factory, and it has the same normal
 * assistant-message completion contract as an external agent.
 */

import {
   createAgentSession,
   type AgentSession,
   type AgentSessionEvent,
   type ExtensionAPI,
   type ExtensionContext,
   type DefaultResourceLoader,
   type SettingsManager
} from "@earendil-works/pi-coding-agent";
import { formatUnknownAgentProfileError, type AgentProfile } from "../services/agent-profiles.ts";
import { resolveProfileModel } from "../services/model-resolution.ts";
import { childToolPolicy, createChildSessionManager, shutdownAndDisposeChildSession } from "./child-session.ts";
import { buildAgentPrompt } from "../agent-prompt.ts";
import { boundTranscript } from "../utils/transcript.ts";
import { computeAssistantUsage, emptyUsage } from "../utils/usage.ts";
import type { AgentUsage, TranscriptEntry } from "../agent-model.ts";

export type AgentModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];

export interface AgentOutcome {
   ok: boolean;
   output: string;
   error?: string;
   aborted: boolean;
   usage: AgentUsage;
   provider?: string;
   model?: string;
   contextWindow?: number;
   profile?: string;
   sessionId?: string;
   sessionFile?: string;
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
   profile?: AgentRunnerProfile;
   model?: AgentModel;
   thinkingLevel?: ThinkingLevel;
   cwd: string;
   parentSessionFile?: string;
   loader?: DefaultResourceLoader;
   settingsManager?: SettingsManager;
   modelRegistry: ExtensionContext["modelRegistry"];
   signal?: AbortSignal;
   onSession?: (session: AgentSession) => void;
   onSessionReady?: (metadata: AgentSessionMetadata) => Promise<void> | void;
   onProgress?: (progress: AgentProgress) => void;
   sessionName?: string;
   createSessionFn?: typeof createAgentSession;
}

function errorText(error: unknown): string {
   return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

function textFromContent(content: unknown): string {
   if (typeof content === "string") return content;
   if (!Array.isArray(content)) return "";
   return content
      .filter((part): part is { type: "text"; text: string } => {
         return Boolean(
            part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"
         );
      })
      .map((part) => part.text)
      .join("\n");
}

function finalOutput(messages: readonly AgentMessage[]): string {
   for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as any;
      if (message?.role !== "assistant") continue;
      const text = textFromContent(message.content).trim();
      if (text) return text;
   }
   return "";
}

function transcriptFromMessages(messages: readonly AgentMessage[]): TranscriptEntry[] {
   const entries: TranscriptEntry[] = [];
   for (const rawMessage of messages as readonly any[]) {
      if (rawMessage?.role === "user") {
         const text = textFromContent(rawMessage.content).trim();
         if (text) entries.push({ role: "user", text, timestamp: rawMessage.timestamp });
         continue;
      }
      if (rawMessage?.role === "assistant") {
         for (const part of Array.isArray(rawMessage.content) ? rawMessage.content : []) {
            if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
               entries.push({ role: "assistant", text: part.text, timestamp: rawMessage.timestamp });
            } else if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
               entries.push({ role: "thinking", text: part.thinking, timestamp: rawMessage.timestamp });
            } else if (part?.type === "toolCall") {
               entries.push({
                  role: "tool",
                  name: typeof part.name === "string" ? part.name : undefined,
                  toolCallId: typeof part.id === "string" ? part.id : undefined,
                  text: JSON.stringify(part.arguments ?? {}),
                  timestamp: rawMessage.timestamp
               });
            }
         }
         continue;
      }
      if (rawMessage?.role === "toolResult") {
         entries.push({
            role: "toolResult",
            name: typeof rawMessage.toolName === "string" ? rawMessage.toolName : undefined,
            toolCallId: typeof rawMessage.toolCallId === "string" ? rawMessage.toolCallId : undefined,
            text: textFromContent(rawMessage.content),
            isError: rawMessage.isError === true,
            timestamp: rawMessage.timestamp
         });
      }
   }
   return boundTranscript(entries);
}

function latestAssistantError(messages: readonly AgentMessage[]): string | undefined {
   for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as any;
      if (message?.role !== "assistant") continue;
      if (message.stopReason !== "error") return undefined;
      return typeof message.errorMessage === "string" && message.errorMessage.trim()
         ? message.errorMessage.trim()
         : "Agent agent loop ended with an error.";
   }
   return undefined;
}

function metadataForSession(session: AgentSession, options: RunAgentOptions, sessionFile?: string, sessionId?: string) {
   const model = session.model;
   const rawSystemPrompt = session.systemPrompt;
   return {
      provider: model?.provider ?? options.model?.provider,
      model: model?.id ?? options.model?.id,
      contextWindow: model?.contextWindow ?? options.model?.contextWindow,
      profile: options.profile?.name,
      sessionFile,
      sessionId,
      systemPrompt: typeof rawSystemPrompt === "string" && rawSystemPrompt.length > 0 ? rawSystemPrompt : undefined
   };
}

function progressForSession(
   session: AgentSession,
   options: RunAgentOptions,
   sessionFile?: string,
   sessionId?: string
): AgentProgress {
   return {
      preview: finalOutput(session.messages),
      usage: computeAssistantUsage(session.messages),
      ...metadataForSession(session, options, sessionFile, sessionId),
      transcript: transcriptFromMessages(session.messages)
   };
}

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
   const profile = options.profile;
   if (!profile) {
      return {
         ok: false,
         output: "",
         error: formatUnknownAgentProfileError("", options.cwd),
         aborted: false,
         usage: emptyUsage(),
         transcript: []
      };
   }

   let session: AgentSession | undefined;
   let sessionManager: ReturnType<typeof createChildSessionManager> | undefined;
   let unsubscribe: (() => void) | undefined;
   let aborted = options.signal?.aborted === true;
   let failure: string | undefined;

   try {
      const selectedModel =
         options.model ??
         (resolveProfileModel(options.modelRegistry as any, profile, undefined) as AgentModel | undefined);
      sessionManager = createChildSessionManager(options.cwd, options.parentSessionFile);
      const createSession = options.createSessionFn ?? createAgentSession;
      const modelRuntime = (options.modelRegistry as any)?.runtime;
      const created = await createSession({
         cwd: options.cwd,
         ...(selectedModel ? { model: selectedModel } : {}),
         ...((options.thinkingLevel ?? profile.thinking)
            ? { thinkingLevel: options.thinkingLevel ?? profile.thinking }
            : {}),
         ...(modelRuntime ? { modelRuntime } : {}),
         ...(options.loader ? { resourceLoader: options.loader } : {}),
         ...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
         sessionManager,
         tools: [...profile.tools],
         ...childToolPolicy()
      } as any);
      session = created.session;
      if (options.sessionName && typeof session.setSessionName === "function")
         session.setSessionName(options.sessionName);
      options.onSession?.(session);

      const sessionFile = sessionManager.getSessionFile();
      const sessionId = sessionManager.getSessionId();
      await options.onSessionReady?.({
         ...metadataForSession(session, options, sessionFile, sessionId),
         cwd: options.cwd,
         thinking: typeof session.thinkingLevel === "string" ? session.thinkingLevel : undefined
      });
      options.onProgress?.(progressForSession(session, options, sessionFile, sessionId));

      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
         if (event.type === "agent_end") {
            const message = (event as any).messages?.at?.(-1);
            if (message?.stopReason === "error")
               failure = message.errorMessage ?? "Agent agent loop ended with an error.";
         }
         options.onProgress?.(progressForSession(session!, options, sessionFile, sessionId));
      });

      const abort = () => {
         aborted = true;
         void session?.abort().catch(() => {});
      };
      if (options.signal) {
         if (options.signal.aborted) abort();
         else options.signal.addEventListener("abort", abort, { once: true });
      }

      if (!aborted) {
         try {
            await session.prompt(buildAgentPrompt(options.prompt));
         } catch (error) {
            failure = errorText(error);
         }
      }
      if (options.signal) options.signal.removeEventListener("abort", abort);
      failure = failure ?? latestAssistantError(session.messages);
   } catch (error) {
      failure = `Failed to create agent session: ${errorText(error)}`;
   } finally {
      unsubscribe?.();
      if (session) await shutdownAndDisposeChildSession(session);
   }

   const finalSession = session;
   const output = finalSession ? finalOutput(finalSession.messages) : "";
   const metadata = finalSession
      ? metadataForSession(finalSession, options, sessionManager?.getSessionFile(), sessionManager?.getSessionId())
      : {};
   const transcript = finalSession ? transcriptFromMessages(finalSession.messages) : [];
   const usage = finalSession ? computeAssistantUsage(finalSession.messages) : emptyUsage();
   if (aborted) {
      return { ok: false, output, error: "Agent was aborted", aborted: true, usage, ...metadata, transcript };
   }
   if (failure) {
      return { ok: false, output, error: failure, aborted: false, usage, ...metadata, transcript };
   }
   return { ok: true, output, aborted: false, usage, ...metadata, transcript };
}
