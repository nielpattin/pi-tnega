import { isAbsolute, normalize, resolve, win32 } from "node:path";

/** A value-or-error result used by pure parsing boundaries. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** A concise parse failure. */
export interface MessageParseError {
   readonly _tag: "MessageParseError";
   readonly message: string;
}

/** The roles and block kinds understood by the pruning core. */
export type ParsedBlockKind =
   | "user"
   | "assistant_text"
   | "assistant_thinking"
   | "tool_call"
   | "tool_result"
   | "bash"
   | "other";

/** One durable content block projected from one Pi message. */
export interface ParsedBlock {
   readonly id: string;
   readonly kind: ParsedBlockKind;
   readonly messageIndex: number;
   readonly contentIndex?: number;
   readonly text: string;
   readonly tokens: number;
   readonly toolCallId?: string;
   readonly toolName?: string;
   readonly arguments?: Record<string, unknown>;
   readonly fullOutputPath?: string;
   readonly isError: boolean;
   readonly opaque: boolean;
   readonly turn: number;
   readonly timestamp?: number;
   readonly message: Record<string, unknown>;
   readonly contentBlock?: Record<string, unknown>;
}

/** A unique tool-call/result correlation. */
export interface ToolPair {
   readonly assistantBlockId: string;
   readonly resultBlockId: string;
}

/** Parsed messages plus the indexes used by pure pruning decisions. */
export interface ParsedMessages {
   readonly messages: readonly Record<string, unknown>[];
   readonly blocks: readonly ParsedBlock[];
   readonly pairs: ReadonlyMap<string, ToolPair>;
   readonly ambiguousIds: ReadonlySet<string>;
   readonly ambiguousToolCallIds: ReadonlySet<string>;
   readonly invalid: boolean;
   readonly cwd: string;
}

/** Options for message parsing. */
export interface ParseMessagesOptions {
   readonly cwd?: string;
}

const EMPTY_OBJECT: Record<string, unknown> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success<T>(value: T): Result<T, never> {
   return { ok: true, value };
}

function failure(message: string): Result<never, MessageParseError> {
   return { ok: false, error: { _tag: "MessageParseError", message } };
}

/** Return deterministic JSON with recursively sorted object keys and bounded hostile values. */
export function stableJson(value: unknown): string {
   const active = new Set<object>();
   const visit = (current: unknown, depth: number): unknown => {
      if (depth > 32) return "[depth-limit]";
      if (current === null || typeof current !== "object") {
         if (typeof current === "number" && !Number.isFinite(current)) return String(current);
         if (typeof current === "bigint") return `${current.toString()}n`;
         if (typeof current === "function" || typeof current === "symbol") return `[${typeof current}]`;
         return current;
      }
      if (active.has(current)) return "[circular]";
      active.add(current);
      let result: unknown;
      if (Array.isArray(current)) {
         result = current.slice(0, 2_000).map((item) => visit(item, depth + 1));
      } else if (isRecord(current)) {
         const sorted: Record<string, unknown> = {};
         for (const key of Object.keys(current).toSorted()) sorted[key] = visit(current[key], depth + 1);
         result = sorted;
      } else {
         result = "[opaque-object]";
      }
      active.delete(current);
      return result;
   };
   try {
      const text = JSON.stringify(visit(value, 0));
      return typeof text === "string" ? text : "null";
   } catch {
      return '"[unserializable]"';
   }
}

/** Estimate tokens without throwing on untrusted text. */
export function estimateTokens(text: string): number {
   return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** Extract only text blocks, preserving their order and exact text. */
export function extractText(content: unknown): string {
   if (typeof content === "string") return content;
   if (!Array.isArray(content)) return "";
   const parts: string[] = [];
   for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      else if (part.type === "thinking" && typeof part.thinking === "string") parts.push(part.thinking);
   }
   return parts.join("\n");
}

/** Tell callers whether content carries an image or another non-text block. */
export function hasOpaqueContent(content: unknown): boolean {
   if (!Array.isArray(content)) return false;
   return content.some((part) => isRecord(part) && part.type !== "text");
}

function timestampOf(message: Record<string, unknown>): number | undefined {
   const timestamp = message.timestamp;
   return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function hashText(text: string): string {
   let hash = 2_166_136_261;
   for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
   }
   return (hash >>> 0).toString(16).padStart(8, "0");
}

function messageHash(message: Record<string, unknown>): string {
   return hashText(stableJson(message));
}

function messageAnchor(message: Record<string, unknown>, prefix: string): string {
   if (typeof message.responseId === "string" && message.responseId.length > 0) return message.responseId;
   const timestamp = timestampOf(message);
   if (timestamp !== undefined) return `${prefix}${timestamp}`;
   return `h${messageHash(message)}`;
}

/** Build a durable id that never uses the current array position. */
export function durableBlockId(
   message: Record<string, unknown>,
   messageIndex: number,
   contentIndex?: number,
   kind: ParsedBlockKind = "other"
): string {
   void messageIndex;
   if (kind === "user") {
      const timestamp = timestampOf(message);
      return timestamp === undefined ? `u:h${messageHash(message)}` : `u:${timestamp}`;
   }
   if (kind === "tool_result") {
      const callId = message.toolCallId;
      return typeof callId === "string" && callId.length > 0 ? `r:${callId}` : `r:h${messageHash(message)}`;
   }
   if (kind === "tool_call") {
      const block =
         Array.isArray(message.content) && contentIndex !== undefined ? message.content[contentIndex] : undefined;
      const callId = isRecord(block) ? block.id : undefined;
      return typeof callId === "string" && callId.length > 0
         ? `c:${callId}`
         : `c:h${messageHash(message)}:${contentIndex ?? 0}`;
   }
   if (kind === "assistant_text" || kind === "assistant_thinking") {
      return `a:${messageAnchor(message, "t")}:p${contentIndex ?? 0}`;
   }
   const timestamp = timestampOf(message);
   return timestamp === undefined ? `s:h${messageHash(message)}` : `s:${timestamp}`;
}

/** Return true for ids anchored to durable message content or provider call ids. */
export function isDurableId(id: string): boolean {
   return /^(?:u|a|c|r|s):/.test(id);
}

/** Normalize a tool path against a session cwd without exposing path traversal semantics. */
export function normalizeSessionPath(value: string, cwd: string): string {
   const raw = value.trim().replaceAll("\\", "/");
   const looksWindowsAbsolute = win32.isAbsolute(value);
   const normalized = looksWindowsAbsolute || isAbsolute(raw) ? normalize(raw) : resolve(cwd, raw);
   return normalized.replaceAll("\\", "/");
}

function textForBlock(message: Record<string, unknown>, contentBlock: Record<string, unknown> | undefined): string {
   if (contentBlock?.type === "text" && typeof contentBlock.text === "string") return contentBlock.text;
   if (contentBlock?.type === "thinking" && typeof contentBlock.thinking === "string") return contentBlock.thinking;
   if (contentBlock?.type === "toolCall" || contentBlock?.type === "tool_use") {
      const name = typeof contentBlock.name === "string" ? contentBlock.name : "tool";
      return `${name} ${stableJson(contentBlock.arguments ?? contentBlock.input ?? {})}`;
   }
   if (message.role === "toolResult" || message.role === "bashExecution")
      return extractText(message.content ?? message.output ?? "");
   return extractText(message.content);
}

function parseOneMessage(message: Record<string, unknown>, messageIndex: number, turn: number): ParsedBlock[] {
   const role = typeof message.role === "string" ? message.role : "other";
   const content = message.content;
   const blocks: ParsedBlock[] = [];
   const add = (
      kind: ParsedBlockKind,
      text: string,
      contentIndex: number | undefined,
      contentBlock: Record<string, unknown> | undefined,
      opaque: boolean,
      extra: Pick<ParsedBlock, "toolCallId" | "toolName" | "arguments" | "fullOutputPath" | "isError"> = {
         isError: false
      }
   ): void => {
      const id = durableBlockId(message, messageIndex, contentIndex, kind);
      blocks.push({
         id,
         kind,
         messageIndex,
         contentIndex,
         text,
         tokens: estimateTokens(text),
         toolCallId: extra.toolCallId,
         toolName: extra.toolName,
         arguments: extra.arguments,
         fullOutputPath: extra.fullOutputPath,
         isError: extra.isError,
         opaque,
         turn,
         timestamp: timestampOf(message),
         message,
         contentBlock
      });
   };

   if (role === "assistant" && typeof content === "string") {
      add("assistant_text", content, undefined, undefined, false);
      return blocks;
   }

   if (role === "assistant" && Array.isArray(content)) {
      content.forEach((value, index) => {
         if (!isRecord(value)) {
            add("other", "", index, undefined, true);
            return;
         }
         if (value.type === "text")
            add("assistant_text", typeof value.text === "string" ? value.text : "", index, value, false);
         else if (value.type === "thinking")
            add("assistant_thinking", typeof value.thinking === "string" ? value.thinking : "", index, value, false);
         else if (value.type === "toolCall" || value.type === "tool_use") {
            const callId = typeof value.id === "string" ? value.id : undefined;
            const toolName = typeof value.name === "string" ? value.name : undefined;
            const args = isRecord(value.arguments)
               ? value.arguments
               : isRecord(value.input)
                 ? value.input
                 : EMPTY_OBJECT;
            add("tool_call", textForBlock(message, value), index, value, false, {
               toolCallId: callId,
               toolName,
               arguments: args,
               isError: false
            });
         } else add("other", "", index, value, true);
      });
      return blocks;
   }

   if (role === "toolResult") {
      const opaque = hasOpaqueContent(content);
      add("tool_result", extractText(content), undefined, undefined, opaque, {
         toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
         toolName: typeof message.toolName === "string" ? message.toolName : undefined,
         fullOutputPath:
            isRecord(message.details) && typeof message.details.fullOutputPath === "string"
               ? message.details.fullOutputPath
               : undefined,
         isError: message.isError === true
      });
      return blocks;
   }

   if (role === "user") {
      add("user", extractText(content), undefined, undefined, hasOpaqueContent(content));
      return blocks;
   }

   if (role === "bashExecution") {
      const output = typeof message.output === "string" ? message.output : extractText(content);
      add("bash", output, undefined, undefined, false);
      return blocks;
   }

   const summary = typeof message.summary === "string" ? message.summary : extractText(content);
   if (summary || content !== undefined) add("other", summary, undefined, undefined, hasOpaqueContent(content));
   return blocks;
}

/** Parse a Pi AgentMessage array into durable blocks and unique tool correlations. */
export function parseMessages(
   messages: readonly unknown[],
   options: ParseMessagesOptions = {}
): Result<ParsedMessages, MessageParseError> {
   if (!Array.isArray(messages)) return failure("Context messages must be an array");
   const parsedMessages: Record<string, unknown>[] = [];
   const blocks: ParsedBlock[] = [];
   const idCounts = new Map<string, number>();
   const callBlocks = new Map<string, ParsedBlock[]>();
   const resultBlocks = new Map<string, ParsedBlock[]>();
   let turn = 0;
   let invalid = false;

   messages.forEach((value, index) => {
      if (!isRecord(value)) {
         invalid = true;
         return;
      }
      parsedMessages.push(value);
      const role = value.role;
      if (role === "user") turn += 1;
      const messageBlocks = parseOneMessage(value, index, turn);
      for (const block of messageBlocks) {
         blocks.push(block);
         idCounts.set(block.id, (idCounts.get(block.id) ?? 0) + 1);
         if (block.kind === "tool_call" && block.toolCallId) {
            const existing = callBlocks.get(block.toolCallId) ?? [];
            existing.push(block);
            callBlocks.set(block.toolCallId, existing);
         }
         if (block.kind === "tool_result" && block.toolCallId) {
            const existing = resultBlocks.get(block.toolCallId) ?? [];
            existing.push(block);
            resultBlocks.set(block.toolCallId, existing);
         }
      }
   });

   if (invalid) return failure("Context contains a non-object message");
   const ambiguousIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id));
   const ambiguousToolCallIds = new Set<string>();
   const pairs = new Map<string, ToolPair>();
   const callIds = new Set([...callBlocks.keys(), ...resultBlocks.keys()]);
   for (const callId of callIds) {
      const calls = callBlocks.get(callId) ?? [];
      const results = resultBlocks.get(callId) ?? [];
      if (calls.length !== 1 || results.length !== 1) {
         ambiguousToolCallIds.add(callId);
         continue;
      }
      const call = calls[0];
      const result = results[0];
      if (!call || !result) {
         ambiguousToolCallIds.add(callId);
         continue;
      }
      pairs.set(callId, {
         assistantBlockId: call.id,
         resultBlockId: result.id
      });
   }

   return success({
      messages: parsedMessages,
      blocks,
      pairs,
      ambiguousIds,
      ambiguousToolCallIds,
      invalid: false,
      cwd: options.cwd ?? process.cwd()
   });
}

/**
 * Detect whether the visible message projection contains an unfinished tool arc.
 *
 * A queued rewrite changes provider-visible bytes, so the caller must wait until
 * every visible assistant tool call has a matching result unless pressure is
 * emergency-level.
 */
export function hasOpenToolArc(messages: readonly unknown[]): boolean {
   const openCalls = new Set<string>();
   for (const value of messages) {
      if (!isRecord(value)) continue;
      if (value.role === "assistant" && Array.isArray(value.content)) {
         for (const part of value.content) {
            if (!isRecord(part)) continue;
            if (
               (part.type === "toolCall" || part.type === "tool_use") &&
               typeof part.id === "string" &&
               part.id.length > 0
            ) {
               openCalls.add(part.id);
            }
         }
      }
      if (value.role === "toolResult" && typeof value.toolCallId === "string") {
         openCalls.delete(value.toolCallId);
      }
   }
   return openCalls.size > 0;
}

/** Find the first text-bearing block for a tool result. */
export function resultBlockFor(parsed: ParsedMessages, toolCallId: string): ParsedBlock | undefined {
   const pair = parsed.pairs.get(toolCallId);
   if (!pair) return undefined;
   return parsed.blocks.find((block) => block.id === pair.resultBlockId);
}

/** Find a tool-call block by its durable call id. */
export function callBlockFor(parsed: ParsedMessages, toolCallId: string): ParsedBlock | undefined {
   const pair = parsed.pairs.get(toolCallId);
   if (!pair) return undefined;
   return parsed.blocks.find((block) => block.id === pair.assistantBlockId);
}
