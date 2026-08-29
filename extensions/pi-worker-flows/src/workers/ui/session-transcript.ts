import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TaskTranscriptContent, TaskTranscriptEntry } from "../domain.js";

type SessionMessage = {
   readonly role?: string;
   readonly content?: unknown;
   readonly timestamp?: number;
   readonly toolCallId?: string;
   readonly toolName?: string;
   readonly isError?: boolean;
   readonly errorMessage?: string;
   readonly output?: string;
};

function timestampOf(entry: { readonly timestamp?: string }, message?: SessionMessage): number | undefined {
   if (typeof message?.timestamp === "number") return message.timestamp;
   if (!entry.timestamp) return undefined;
   const timestamp = Date.parse(entry.timestamp);
   return Number.isFinite(timestamp) ? timestamp : undefined;
}

function contentText(content: unknown): string {
   if (typeof content === "string") return content;
   if (!Array.isArray(content)) return "";
   return content
      .map((block) => {
         if (!block || typeof block !== "object") return "";
         const value = block as { readonly type?: string; readonly text?: unknown; readonly mimeType?: unknown };
         if (value.type === "text" && typeof value.text === "string") return value.text;
         if (value.type === "image" && typeof value.mimeType === "string") return `[image ${value.mimeType}]`;
         return "";
      })
      .filter(Boolean)
      .join("\n");
}

function transcriptContent(content: unknown): ReadonlyArray<TaskTranscriptContent> {
   if (!Array.isArray(content)) return [];
   return content.flatMap((block): TaskTranscriptContent[] => {
      if (!block || typeof block !== "object") return [];
      const value = block as { readonly type?: string; readonly text?: unknown; readonly mimeType?: unknown };
      if (value.type === "text" && typeof value.text === "string") return [{ type: "text", text: value.text }];
      if (value.type === "image" && typeof value.mimeType === "string") {
         return [{ type: "image", mimeType: value.mimeType }];
      }
      return [];
   });
}

function messageEntries(entry: { readonly timestamp?: string; readonly message?: unknown }): TaskTranscriptEntry[] {
   if (!entry.message || typeof entry.message !== "object") return [];
   const message = entry.message as SessionMessage;
   const timestamp = timestampOf(entry, message);

   if (message.role === "user") {
      return [{ type: "user", text: contentText(message.content), timestamp }];
   }

   if (message.role === "assistant") {
      const entries = Array.isArray(message.content)
         ? message.content.flatMap((block): TaskTranscriptEntry[] => {
              if (!block || typeof block !== "object") return [];
              const value = block as {
                 readonly type?: string;
                 readonly text?: unknown;
                 readonly thinking?: unknown;
                 readonly id?: unknown;
                 readonly name?: unknown;
                 readonly arguments?: unknown;
              };
              if (value.type === "thinking" && typeof value.thinking === "string") {
                 return [{ type: "thinking", text: value.thinking, timestamp }];
              }
              if (value.type === "text" && typeof value.text === "string") {
                 return [{ type: "assistant", text: value.text, timestamp }];
              }
              if (value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") {
                 return [
                    {
                       type: "tool-call",
                       toolCallId: value.id,
                       toolName: value.name,
                       arguments: value.arguments,
                       timestamp
                    }
                 ];
              }
              return [];
           })
         : [];
      if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
         entries.push({ type: "error", text: message.errorMessage, timestamp });
      }
      return entries;
   }

   if (message.role === "toolResult") {
      return [
         {
            type: "tool-result",
            toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
            toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
            content: transcriptContent(message.content),
            isError: message.isError === true,
            timestamp
         }
      ];
   }

   if (message.role === "bashExecution") {
      return [
         {
            type: "tool-result",
            toolCallId: "",
            toolName: "bash",
            content: [{ type: "text", text: typeof message.output === "string" ? message.output : "" }],
            isError: message.isError === true,
            timestamp
         }
      ];
   }

   return [];
}

/**
 * Read the latest positive assistant context token count from a persisted Pi session.
 *
 * @param sessionFile - The persisted worker session path.
 * @returns The latest assistant usage total, or `undefined` when no usable usage exists.
 */
export function getPiSessionContextTokens(sessionFile: string): number | undefined {
   try {
      const session = SessionManager.open(sessionFile);
      const branch = session.getBranch();
      for (let index = branch.length - 1; index >= 0; index -= 1) {
         const entry = branch[index];
         if (entry?.type !== "message" || entry.message.role !== "assistant" || !entry.message.usage) continue;

         const usage = entry.message.usage;
         const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
         if (Number.isFinite(totalTokens) && totalTokens > 0) return totalTokens;
      }
   } catch {
      return undefined;
   }
   return undefined;
}

/** Read the active Pi worker conversation directly from its persisted JSONL session. */
export function readPiSessionTranscript(sessionFile: string): ReadonlyArray<TaskTranscriptEntry> {
   try {
      const session = SessionManager.open(sessionFile);
      return session.getBranch().flatMap((entry) => (entry.type === "message" ? messageEntries(entry) : []));
   } catch {
      return [];
   }
}
