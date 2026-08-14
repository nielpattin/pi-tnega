import { readFileSync } from "node:fs";
import type { JobTranscriptContent, JobTranscriptEntry } from "../domain.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
   return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textParts(value: unknown): string[] {
   if (typeof value === "string") return [value];
   if (!Array.isArray(value)) return [];
   return value.flatMap((part) => {
      if (!isRecord(part) || typeof part.text !== "string") return [];
      return [part.text];
   });
}

function normalizeContent(value: unknown): ReadonlyArray<JobTranscriptContent> {
   if (!Array.isArray(value)) return [];
   const normalized: JobTranscriptContent[] = [];
   for (const part of value) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
         normalized.push({ type: "text", text: part.text });
      } else if (part.type === "image" && typeof part.mimeType === "string") {
         normalized.push({ type: "image", mimeType: part.mimeType });
      }
   }
   return normalized;
}

function timestampOf(message: JsonRecord): number | undefined {
   return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
}

/** Read the current Pi JSONL session into Workers's normal transcript shape. */
export function readSessionTranscript(sessionFile: string): ReadonlyArray<JobTranscriptEntry> {
   let raw: string;
   try {
      raw = readFileSync(sessionFile, "utf8");
   } catch {
      return [];
   }

   const transcript: JobTranscriptEntry[] = [];
   for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
         entry = JSON.parse(line);
      } catch {
         continue;
      }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;

      const message = entry.message;
      const role = message.role;
      const timestamp = timestampOf(message);
      if (role === "user") {
         const text = textParts(message.content).join("\n");
         if (text.length > 0) transcript.push({ type: "user", text, timestamp });
         continue;
      }

      if (role === "assistant") {
         if (Array.isArray(message.content)) {
            for (const part of message.content) {
               if (!isRecord(part)) continue;
               if (part.type === "text" && typeof part.text === "string") {
                  transcript.push({ type: "assistant", text: part.text, timestamp });
               } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
                  transcript.push({
                     type: "tool-call",
                     toolCallId: part.id,
                     toolName: part.name,
                     arguments: part.arguments,
                     timestamp
                  });
               }
            }
         }
         if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
            transcript.push({ type: "error", text: message.errorMessage, timestamp });
         }
         continue;
      }

      if (role === "toolResult" || role === "tool") {
         if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;
         transcript.push({
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            content: normalizeContent(message.content),
            isError: message.isError === true,
            timestamp
         });
      }
   }
   return transcript;
}
