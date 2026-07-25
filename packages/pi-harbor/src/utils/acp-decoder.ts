import { Effect, Schedule } from "effect";

export interface AcpRecord {
   readonly id?: string;
   readonly type?: string;
   readonly status?: string;
   readonly toolCallId?: string;
   readonly toolName?: string;
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
        readonly timestamp?: number;
     }
   | {
        readonly _tag: "ToolEnd";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly resultPreview?: string;
        readonly isError?: boolean;
        readonly timestamp?: number;
     }
   | {
        readonly _tag: "AssistantDelta";
        readonly delta: string;
        readonly timestamp?: number;
     };

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
