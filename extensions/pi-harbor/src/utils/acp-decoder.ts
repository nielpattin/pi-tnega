import { Effect, Schedule } from "effect";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobTranscriptEntry } from "../domain.js";

export interface AcpRecord {
   readonly id?: string;
   readonly type?: string;
   readonly status?: string;
   readonly toolCallId?: string;
   readonly toolName?: string;
   readonly stepIndex?: number;
   readonly args?: unknown;
   readonly result?: unknown;
   readonly isError?: boolean;
   readonly delta?: string;
   readonly timestamp?: number;
}

export type AcpDecodedEvent =
   | {
        readonly _tag: "ToolStart";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly argsPreview?: string;
        readonly stepIndex?: number;
        readonly timestamp?: number;
     }
   | {
        readonly _tag: "ToolEnd";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly resultPreview?: string;
        readonly isError?: boolean;
        readonly stepIndex?: number;
        readonly timestamp?: number;
     }
   | {
        readonly _tag: "AssistantDelta";
        readonly delta: string;
        readonly timestamp?: number;
     };

interface AgyTranscriptToolCall {
   readonly name?: unknown;
   readonly args?: unknown;
}

interface AgyTranscriptRow {
   readonly step_index?: unknown;
   readonly source?: unknown;
   readonly type?: unknown;
   readonly status?: unknown;
   readonly content?: unknown;
   readonly tool_calls?: unknown;
}

/**
 * Read Agy's live per-conversation transcript and normalize tool activity for Harbor.
 */
export async function readAgyTranscriptRecords(
   conversationId: string,
   lastProcessedIndex: number,
   brainRoot: string = join(homedir(), ".gemini", "antigravity-cli", "brain")
): Promise<AcpRecord[]> {
   const transcriptPath = join(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl");
   const text = await readFile(transcriptPath, "utf8").catch(() => "");
   const rows: AgyTranscriptRow[] = [];
   for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
         const parsed: unknown = JSON.parse(line);
         if (parsed && typeof parsed === "object") rows.push(parsed as AgyTranscriptRow);
      } catch {
         // Agy may be appending the final JSONL line while Harbor reads it. Retry on the next poll.
      }
   }

   const records: AcpRecord[] = [];
   let pendingCalls: Array<{ id: string; name: string }> = [];
   for (const row of rows) {
      if (Array.isArray(row.tool_calls)) {
         pendingCalls = row.tool_calls.flatMap((value: unknown, index: number) => {
            if (!value || typeof value !== "object") return [];
            const call = value as AgyTranscriptToolCall;
            if (typeof call.name !== "string") return [];
            const step = typeof row.step_index === "number" ? row.step_index : records.length;
            const id = `agy-${step}-${index}`;
            records.push({
               id,
               toolCallId: id,
               toolName: call.name,
               status: "in_progress",
               args: call.args,
               stepIndex: step
            });
            return [{ id, name: call.name }];
         });
         continue;
      }

      if (pendingCalls.length > 0 && row.source === "MODEL" && typeof row.content === "string") {
         const call = pendingCalls.shift();
         if (call) {
            records.push({
               id: call.id,
               toolCallId: call.id,
               toolName: call.name,
               status: "completed",
               result: row.content,
               isError: row.status !== "DONE",
               stepIndex: typeof row.step_index === "number" ? row.step_index : undefined
            });
         }
      }
   }
   return records.slice(lastProcessedIndex);
}

function parsePreview(value: string | undefined): unknown {
   if (value === undefined) return undefined;
   try {
      return JSON.parse(value);
   } catch {
      return value;
   }
}

/** Convert one decoded Agy event into the transcript shape consumed by takeover. */
export function acpEventToTranscriptEntry(event: AcpDecodedEvent): JobTranscriptEntry {
   const raw = "stepIndex" in event && event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : undefined;
   if (event._tag === "ToolStart") {
      return {
         type: "tool-call",
         toolCallId: event.toolCallId,
         toolName: event.toolName,
         arguments: parsePreview(event.argsPreview) ?? {},
         ...(raw === undefined ? {} : { raw }),
         timestamp: event.timestamp
      };
   }

   if (event._tag === "ToolEnd") {
      return {
         type: "tool-result",
         toolCallId: event.toolCallId,
         toolName: event.toolName,
         content: event.resultPreview === undefined ? [] : [{ type: "text", text: event.resultPreview }],
         isError: event.isError === true,
         ...(raw === undefined ? {} : { raw }),
         timestamp: event.timestamp
      };
   }

   return {
      type: "assistant",
      text: event.delta,
      timestamp: event.timestamp
   };
}

export function decodeAcpRecord(record: AcpRecord): AcpDecodedEvent | null {
   if (record.delta != null && record.delta.length > 0) {
      return {
         _tag: "AssistantDelta",
         delta: record.delta,
         timestamp: record.timestamp
      };
   }

   if (record.status === "in_progress" && (record.toolName || record.toolCallId)) {
      return {
         _tag: "ToolStart",
         toolCallId: record.toolCallId ?? record.id ?? `tool-${Date.now()}`,
         toolName: record.toolName ?? "unknown",
         argsPreview:
            typeof record.args === "string"
               ? record.args
               : record.args != null
                 ? JSON.stringify(record.args)
                 : undefined,
         ...(record.stepIndex === undefined ? {} : { stepIndex: record.stepIndex }),
         timestamp: record.timestamp
      };
   }

   if (record.status === "completed" && (record.toolName || record.toolCallId)) {
      return {
         _tag: "ToolEnd",
         toolCallId: record.toolCallId ?? record.id ?? `tool-${Date.now()}`,
         toolName: record.toolName ?? "unknown",
         resultPreview:
            typeof record.result === "string"
               ? record.result
               : record.result != null
                 ? JSON.stringify(record.result)
                 : undefined,
         isError: record.isError ?? false,
         ...(record.stepIndex === undefined ? {} : { stepIndex: record.stepIndex }),
         timestamp: record.timestamp
      };
   }

   return null;
}

export interface PollAgyDbOptions {
   conversationId: string;
   readDb?: (conversationId: string, lastProcessedIndex: number) => Promise<AcpRecord[]>;
   onEvent: (event: AcpDecodedEvent) => void;
   intervalMs?: number;
}

export function pollAgyDb(options: PollAgyDbOptions) {
   const intervalMs = options.intervalMs ?? 200;
   return Effect.gen(function* () {
      let lastProcessedIndex = 0;

      yield* Effect.forkScoped(
         Effect.repeat(
            Effect.gen(function* () {
               if (!options.readDb) return;
               try {
                  const records = yield* Effect.promise(() =>
                     options.readDb!(options.conversationId, lastProcessedIndex)
                  );
                  if (records && records.length > 0) {
                     lastProcessedIndex += records.length;
                     for (const record of records) {
                        const event = decodeAcpRecord(record);
                        if (event) {
                           options.onEvent(event);
                        }
                     }
                  }
               } catch {
                  // Ignore DB read errors during poll iteration
               }
            }),
            Schedule.spaced(`${intervalMs} millis`)
         )
      );
   });
}
