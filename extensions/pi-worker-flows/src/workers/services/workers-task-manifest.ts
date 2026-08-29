import type { Task, TaskStatus, TaskTranscriptContent, TaskTranscriptEntry } from "../domain.js";

export const WORKERS_TASK_MANIFEST_VERSION = 1;

/**
 * Mutable bounds and retention policy for persisted Task manifests.
 *
 * Exported as a mutable object so tests can temporarily tighten limits and
 * reset them with {@link resetManifestLimits}.
 */
export const WORKERS_TASK_MANIFEST_LIMITS = {
   /** Registry-level cap on tracked jobs. */
   maxTrackedJobs: 64,

   /** Terminal jobs older than this are eligible for pruning. */
   maxTerminalAgeMs: 30 * 24 * 60 * 60 * 1000,

   /** Maximum string length inside any normalized payload. */
   maxPersistedStringChars: 8192,

   /** Maximum array length inside any normalized payload. */
   maxPersistedArrayLength: 64,

   /** Maximum nesting depth inside any normalized payload. */
   maxPersistedNestingDepth: 8,

   /** Soft ceiling for a single persisted Task record. */
   maxPersistedJobBytes: 65536,

   /** Hard ceiling for the whole serialized manifest. */
   maxPersistedManifestBytes: 1024 * 1024,

   /** Debounce window for coalescing registry-change writes. */
   persistDebounceMs: 50
};

/** Reset all manifest limits and retention constants to their defaults. */
export function resetManifestLimits(): void {
   WORKERS_TASK_MANIFEST_LIMITS.maxTrackedJobs = 64;
   WORKERS_TASK_MANIFEST_LIMITS.maxTerminalAgeMs = 30 * 24 * 60 * 60 * 1000;
   WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars = 8192;
   WORKERS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength = 64;
   WORKERS_TASK_MANIFEST_LIMITS.maxPersistedNestingDepth = 8;
   WORKERS_TASK_MANIFEST_LIMITS.maxPersistedJobBytes = 65536;
   WORKERS_TASK_MANIFEST_LIMITS.maxPersistedManifestBytes = 1024 * 1024;
   WORKERS_TASK_MANIFEST_LIMITS.persistDebounceMs = 50;
}

function byteLength(value: unknown): number {
   return Buffer.byteLength(JSON.stringify(value, undefined, 2), "utf8");
}

/** Sizes and truncation counts surfaced in a persisted manifest. */
export interface ManifestSummary {
   readonly totalJobs: number;
   readonly truncatedJobs: number;
   readonly droppedStringChars: number;
   readonly droppedArrayItems: number;
   readonly droppedJobs: number;
}

/** Persisted representation of the jobs tracked for a parent session. */
export interface WorkersTaskIndex {
   readonly version: number;
   readonly parentSessionFile?: string;
   readonly writtenAt?: number;
   /** Distinguishes a valid empty index from a missing/corrupt one. */
   readonly source?: "valid" | "missing";
   /** Highest reserved task sequence used by the parent session, independent of retained tasks. */
   readonly reservedTaskSeq?: number;
   readonly summary?: ManifestSummary;
   readonly jobs: ReadonlyArray<Task>;
}

type JsonPrimitive = string | number | boolean | null;
/** JSON-safe value produced by the manifest normalizer. */
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };

interface NormalizeContext {
   readonly depth: number;
   readonly seen: Set<unknown>;
   readonly path: string;
}

interface NormalizationState {
   truncated: boolean;
   droppedStringChars: number;
   droppedArrayItems: number;
}

const TRUNCATED_KEY = "__truncated";

function persistedStringFits(value: string, maxLength: number): boolean {
   // The reader measures JavaScript string length. Also keep the encoded value
   // within the same bound so a multi-byte prefix cannot overflow its UTF-8
   // persistence budget at a Unicode boundary.
   return value.length <= maxLength && Buffer.byteLength(value, "utf8") <= maxLength;
}

function takePrefixWithinBound(value: string, maxLength: number): string {
   if (maxLength <= 0) return "";
   let end = 0;
   let bytes = 0;
   for (const character of value) {
      const characterLength = character.length;
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (end + characterLength > maxLength || bytes + characterBytes > maxLength) break;
      end += characterLength;
      bytes += characterBytes;
   }
   return value.slice(0, end);
}

function boundedMetadataText(full: string, maxLength: number, compact: string): string {
   if (persistedStringFits(full, maxLength)) return full;
   if (persistedStringFits(compact, maxLength)) return compact;
   return takePrefixWithinBound(compact, maxLength);
}

function truncateWithSuffix(
   value: string,
   maxLength: number,
   suffixForDropped: (dropped: number) => string,
   compactSuffix: string,
   initialPrefixLength = value.length
): { readonly value: string; readonly kept: string } {
   if (maxLength <= 0) return { value: "", kept: "" };

   let suffix = boundedMetadataText(suffixForDropped(value.length), maxLength, compactSuffix);
   const initialPrefix = takePrefixWithinBound(value, initialPrefixLength);
   let kept = takePrefixWithinBound(initialPrefix, maxLength - suffix.length);
   for (;;) {
      const dropped = value.length - kept.length;
      suffix = boundedMetadataText(suffixForDropped(dropped), maxLength, compactSuffix);
      const candidate = `${kept}${suffix}`;
      if (persistedStringFits(candidate, maxLength)) return { value: candidate, kept };
      if (kept.length === 0) return { value: suffix, kept };
      kept = takePrefixWithinBound(value, kept.length - 1);
   }
}

function truncateString(value: string, maxLength: number, state: NormalizationState): string {
   if (persistedStringFits(value, maxLength)) return value;
   const result = truncateWithSuffix(
      value,
      maxLength,
      (dropped) => `… [truncated ${dropped} characters]`,
      "[truncated]"
   );
   const dropped = value.length - result.kept.length;
   state.truncated = true;
   state.droppedStringChars += dropped;
   return result.value;
}

function boundString(value: string, state: NormalizationState): string {
   return truncateString(value, WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars, state);
}

function boundStringWithoutAccounting(value: string): string {
   return truncateString(value, WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars, createRootNormalizationState());
}

function boundedMarker(message: string): string {
   return boundedMetadataText(message, WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars, "[truncated]");
}

function truncatedMarker(message: string): { readonly [TRUNCATED_KEY]: string } {
   return { [TRUNCATED_KEY]: boundedMarker(message) };
}

function safeTypeName(value: unknown): string {
   if (value === null) return "null";
   if (value === undefined) return "undefined";
   const t = typeof value;
   if (t === "object") {
      const ctor = value?.constructor?.name;
      if (typeof ctor === "string" && ctor !== "Object") return ctor;
      return "object";
   }
   return t;
}

function safeJsonString(value: unknown): string {
   try {
      return String(value);
   } catch {
      return String(safeTypeName(value));
   }
}

/**
 * Convert an arbitrary value into a JSON-safe value, replacing cycles, BigInt,
 * unsupported values, getter errors, and oversize strings/arrays/depth with
 * explicit `__truncated` markers.
 */
export function toPersistableValue(value: unknown, ctx: NormalizeContext, state: NormalizationState): JsonValue {
   try {
      if (value === null) return null;

      if (value === undefined) {
         state.truncated = true;
         return truncatedMarker("undefined value removed");
      }

      const t = typeof value;
      if (t === "boolean" || t === "number") return value as JsonValue;

      if (t === "string") {
         return boundString(value as string, state);
      }

      if (t === "bigint") {
         state.truncated = true;
         return truncatedMarker(`BigInt removed: ${safeJsonString(value)}`);
      }

      if (t === "symbol" || t === "function") {
         state.truncated = true;
         return truncatedMarker(`${t === "symbol" ? "Symbol" : "Function"} value removed`);
      }

      if (typeof (value as Date).toISOString === "function" && value instanceof Date) {
         return boundString((value as Date).toISOString(), state);
      }

      if (ctx.depth >= WORKERS_TASK_MANIFEST_LIMITS.maxPersistedNestingDepth) {
         state.truncated = true;
         return truncatedMarker("max nesting depth exceeded");
      }

      if (typeof value === "object") {
         if (ctx.seen.has(value)) {
            state.truncated = true;
            return truncatedMarker("circular reference removed");
         }
         ctx.seen.add(value);

         try {
            if (Array.isArray(value)) {
               const max = WORKERS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength;
               const out: JsonValue[] = [];
               for (let i = 0; i < Math.min(value.length, max); i++) {
                  out.push(
                     toPersistableValue(
                        value[i],
                        { depth: ctx.depth + 1, seen: ctx.seen, path: `${ctx.path}[${i}]` },
                        state
                     )
                  );
               }
               if (value.length > max) {
                  const dropped = value.length - max;
                  state.truncated = true;
                  state.droppedArrayItems += dropped;
                  out.push(truncatedMarker(`${dropped} array items omitted`));
               }
               return out;
            }

            const out: Record<string, JsonValue> = {};
            const keys = Object.keys(value as object);
            for (const key of keys) {
               const persistedKey = boundString(key, state);
               let entry: unknown;
               try {
                  entry = (value as Record<string, unknown>)[key];
               } catch (err) {
                  state.truncated = true;
                  out[persistedKey] = truncatedMarker(
                     `getter threw: ${err instanceof Error ? err.message : String(err)}`
                  );
                  continue;
               }

               if (entry === undefined) {
                  continue;
               }

               out[persistedKey] = toPersistableValue(
                  entry,
                  { depth: ctx.depth + 1, seen: ctx.seen, path: `${ctx.path}.${key}` },
                  state
               );
            }
            return out;
         } finally {
            ctx.seen.delete(value);
         }
      }

      state.truncated = true;
      return truncatedMarker(`unsupported value removed: ${safeTypeName(value)}`);
   } catch (err) {
      state.truncated = true;
      return truncatedMarker(`normalization failed: ${err instanceof Error ? err.message : String(err)}`);
   }
}

function createRootNormalizationState(): NormalizationState {
   return { truncated: false, droppedStringChars: 0, droppedArrayItems: 0 };
}

/** Result of normalizing a single Task for persistence. */
export interface NormalizedTaskResult {
   readonly task: Task;
   readonly truncated: boolean;
   readonly droppedStringChars: number;
   readonly droppedArrayItems: number;
}

/**
 * Create a bounded, JSON-safe persisted copy of a Task while keeping child
 * session references and the captured worker system prompt.
 */
export function normalizePersistedTask(task: Task): NormalizedTaskResult {
   const state = createRootNormalizationState();

   const normalizedResultData =
      task.resultData !== undefined
         ? (toPersistableValue(task.resultData, { depth: 0, seen: new Set(), path: "resultData" }, state) as unknown)
         : undefined;

   const normalizedErrorText = task.errorText !== undefined ? boundString(task.errorText, state) : undefined;
   const normalizedTranscript =
      task.transcript === undefined
         ? undefined
         : (toPersistableValue(
              task.transcript,
              { depth: 0, seen: new Set(), path: "transcript" },
              state
           ) as unknown as ReadonlyArray<TaskTranscriptEntry>);

   const normalized: Task = {
      id: boundString(task.id, state),
      ownerSessionId: boundString(task.ownerSessionId, state),
      name: task.name === null || task.name === undefined ? task.name : boundString(task.name, state),
      worker: task.worker === undefined ? undefined : boundString(task.worker, state),
      model: task.model === undefined ? undefined : boundString(task.model, state),
      thinking: task.thinking === undefined ? undefined : boundString(task.thinking, state),
      cwd: task.cwd === undefined ? undefined : boundString(task.cwd, state),
      context: task.context === undefined ? undefined : boundString(task.context, state),
      contextTokens: task.contextTokens,
      batchId: task.batchId === undefined ? undefined : boundString(task.batchId, state),
      batchSize: task.batchSize,
      promptOrCommand: boundString(task.promptOrCommand, state),
      systemPrompt: task.systemPrompt === undefined ? undefined : boundString(task.systemPrompt, state),
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      settledAt: task.settledAt,
      resultData: normalizedResultData,
      errorText: normalizedErrorText,
      transcript: normalizedTranscript,
      sessionFile: task.sessionFile === undefined ? undefined : boundString(task.sessionFile, state),
      sessionId: task.sessionId === undefined ? undefined : boundString(task.sessionId, state)
   };

   if (byteLength(normalized) > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedJobBytes) {
      state.truncated = true;
      let reduced: Task = {
         ...normalized,
         resultData: truncatedMarker("per-Task byte limit exceeded"),
         systemPrompt: undefined,
         promptOrCommand: normalized.promptOrCommand.slice(0, Math.min(normalized.promptOrCommand.length, 80))
      };
      // Recompute after reductions; if the prompt still pushes the record over
      // the limit, drop it entirely so the persisted Task remains structural.
      if (byteLength(reduced) > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedJobBytes) {
         reduced = { ...reduced, promptOrCommand: "" };
      }
      return {
         task: reduced,
         truncated: true,
         droppedStringChars: state.droppedStringChars,
         droppedArrayItems: state.droppedArrayItems
      };
   }

   return {
      task: normalized,
      truncated: state.truncated,
      droppedStringChars: state.droppedStringChars,
      droppedArrayItems: state.droppedArrayItems
   };
}

function isTerminalStatus(status: TaskStatus): boolean {
   return status === "completed" || status === "failed" || status === "cancelled";
}

function jobAgeMs(task: Task, now: number): number {
   const anchor = task.settledAt ?? task.createdAt;
   return now - anchor;
}

/**
 * Drop terminal jobs until the collection is at or below the target size,
 * preferring the oldest terminal jobs. Also removes terminal jobs that exceed
 * the configured age cap so retention remains finite for background jobs.
 */
export function pruneTerminalTasksForRetention(
   jobs: ReadonlyArray<Task>,
   now: number,
   targetSize: number = WORKERS_TASK_MANIFEST_LIMITS.maxTrackedJobs
): Task[] {
   const maxAge = WORKERS_TASK_MANIFEST_LIMITS.maxTerminalAgeMs;

   const removable: Task[] = [];
   for (const task of jobs) {
      if (isTerminalStatus(task.status)) {
         removable.push(task);
      }
   }

   removable.sort((a, b) => {
      const aTime = a.settledAt ?? a.createdAt;
      const bTime = b.settledAt ?? b.createdAt;
      if (aTime !== bTime) return aTime - bTime;
      return a.createdAt - b.createdAt;
   });

   const removedByAge = removable.filter((task) => jobAgeMs(task, now) > maxAge);
   const removedByCapacity = removable.slice(0, Math.max(0, jobs.length - Math.min(targetSize, jobs.length)));

   const removedIds = new Set<string>([
      ...removedByAge.map((task) => task.id),
      ...removedByCapacity.map((task) => task.id)
   ]);

   return jobs.filter((task) => !removedIds.has(task.id));
}

/**
 * Compute the highest worker sequence number used by a set of jobs so id
 * monotonicity survives manifest pruning.
 */
export function computeReservedTaskSeq(jobs: ReadonlyArray<Task>): number {
   let max = 0;
   for (const task of jobs) {
      const match = /^(?:worker-|task-)(\d+)$/.exec(task.id);
      if (match) {
         const n = Number(match[1]);
         if (n > max) max = n;
      }
   }
   return max;
}

/** Normalized manifest index together with its truncation summary. */
export interface NormalizedIndexResult {
   readonly index: WorkersTaskIndex;
   readonly summary: ManifestSummary;
}

function indexByteSize(index: WorkersTaskIndex): number {
   // This is the exact serialization used by WorkersTaskPersistence. Keeping the
   // indentation here prevents a compact-size check from producing an oversized
   // pretty-printed file on disk.
   return byteLength(index);
}

function truncationText(label: string, omitted: number): string {
   const full = `[__truncated: ${label}; ${Math.max(0, omitted)} characters omitted]`;
   return boundedMetadataText(full, WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars, "[__truncated]");
}

function compactTaskSummaries(task: Task): {
   readonly task: Task;
   readonly droppedStringChars: number;
   readonly changed: boolean;
} {
   let droppedStringChars = 0;
   let changed = false;

   const resultData =
      task.resultData === undefined
         ? undefined
         : (() => {
              changed = true;
              try {
                 droppedStringChars += JSON.stringify(task.resultData).length;
              } catch {
                 // The normalizer has already made this value JSON-safe.
              }
              return truncatedMarker("resultData summary omitted");
           })();

   const compactText = (value: string | undefined, label: string): string | undefined => {
      if (value === undefined || value.length <= 256) return value;
      changed = true;
      const result = truncateWithSuffix(
         value,
         WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars,
         (dropped) => truncationText(label, dropped),
         "[__truncated]",
         128
      );
      droppedStringChars += value.length - result.kept.length;
      return result.value;
   };

   const errorText = compactText(task.errorText, "errorText");
   const promptOrCommand = compactText(task.promptOrCommand, "promptOrCommand") ?? truncationText("promptOrCommand", 0);
   if (promptOrCommand !== task.promptOrCommand) changed = true;

   return {
      task: { ...task, resultData, errorText, promptOrCommand },
      droppedStringChars,
      changed
   };
}

/**
 * The final per-Task form keeps every field needed to identify and restart a Task
 * while replacing all optional payloads with small, parser-valid summaries.
 */
function minimalRecoveryTask(task: Task): {
   readonly task: Task;
   readonly droppedStringChars: number;
   readonly changed: boolean;
} {
   const hasResult = task.resultData !== undefined;
   const hasError = task.errorText !== undefined;
   const prompt = truncationText("promptOrCommand", task.promptOrCommand.length);
   return {
      task: {
         id: task.id,
         ownerSessionId: task.ownerSessionId,
         name: task.name,
         worker: task.worker,
         model: task.model,
         thinking: task.thinking,
         cwd: task.cwd,
         context: task.context,
         contextTokens: task.contextTokens,
         batchId: task.batchId,
         batchSize: task.batchSize,
         promptOrCommand: prompt,
         systemPrompt: task.systemPrompt,
         status: task.status,
         createdAt: task.createdAt,
         startedAt: task.startedAt,
         settledAt: task.settledAt,
         resultData: hasResult ? truncatedMarker("resultData summary omitted") : undefined,
         errorText: hasError ? truncationText("errorText", task.errorText?.length ?? 0) : undefined,
         sessionFile: task.sessionFile,
         sessionId: task.sessionId
      },
      droppedStringChars: task.promptOrCommand.length + (task.errorText?.length ?? 0),
      changed: true
   };
}

/**
 * Build a persisted manifest index from the registry snapshot. Optional data is
 * reduced for every Task before any Task is dropped. Every candidate is measured
 * using UTF-8 bytes after each reduction and the deterministic drop fallback is
 * applied only when the reduced index still exceeds the hard ceiling.
 */
export function buildPersistedIndex(jobs: ReadonlyArray<Task>, parentSessionFile?: string): NormalizedIndexResult {
   const normalizedJobs: Task[] = [];
   const truncatedJobIds = new Set<string>();
   let droppedStringChars = 0;
   let droppedArrayItems = 0;

   for (const task of jobs) {
      const normalized = normalizePersistedTask(task);
      normalizedJobs.push(normalized.task);
      if (normalized.truncated) truncatedJobIds.add(task.id);
      droppedStringChars += normalized.droppedStringChars;
      droppedArrayItems += normalized.droppedArrayItems;
   }

   const retainedIds = new Set(pruneTerminalTasksForRetention(jobs, Date.now()).map((task) => task.id));
   let retainedForSize = normalizedJobs.filter((task) => retainedIds.has(task.id));
   let droppedJobs = normalizedJobs.length - retainedForSize.length;
   let summary: ManifestSummary = {
      totalJobs: retainedForSize.length,
      truncatedJobs: truncatedJobIds.size,
      droppedStringChars,
      droppedArrayItems,
      droppedJobs
   };

   const makeIndex = (): WorkersTaskIndex => ({
      version: WORKERS_TASK_MANIFEST_VERSION,
      parentSessionFile: parentSessionFile === undefined ? undefined : boundStringWithoutAccounting(parentSessionFile),
      reservedTaskSeq: computeReservedTaskSeq(jobs),
      summary,
      jobs: retainedForSize
   });

   let index = makeIndex();
   const maxManifestBytes = WORKERS_TASK_MANIFEST_LIMITS.maxPersistedManifestBytes;

   const applyReduction = (
      reduction: (task: Task) => { readonly task: Task; readonly droppedStringChars: number; readonly changed: boolean }
   ) => {
      const nextJobs: Task[] = [];
      for (const task of retainedForSize) {
         const next = reduction(task);
         nextJobs.push(next.task);
         if (next.changed) truncatedJobIds.add(task.id);
         droppedStringChars += next.droppedStringChars;
      }
      retainedForSize = nextJobs;
      summary = {
         ...summary,
         totalJobs: retainedForSize.length,
         truncatedJobs: truncatedJobIds.size,
         droppedStringChars
      };
      index = makeIndex();
      indexByteSize(index);
   };

   // Measure before and after every whole-registry reduction. Recovery-critical
   // configuration fields remain exact; jobs are dropped only after this pass.
   if (indexByteSize(index) > maxManifestBytes) applyReduction(compactTaskSummaries);
   if (indexByteSize(index) > maxManifestBytes) applyReduction(minimalRecoveryTask);

   const compareDropPriority = (a: Task, b: Task): number => {
      const aTerminal = isTerminalStatus(a.status);
      const bTerminal = isTerminalStatus(b.status);
      if (aTerminal !== bTerminal) return aTerminal ? -1 : 1;
      const aTime = a.settledAt ?? a.createdAt;
      const bTime = b.settledAt ?? b.createdAt;
      if (aTime !== bTime) return aTime - bTime;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
   };

   while (indexByteSize(index) > maxManifestBytes && retainedForSize.length > 0) {
      const ordered = retainedForSize.toSorted(compareDropPriority);
      const victim = ordered[0];
      retainedForSize = retainedForSize.filter((task) => task.id !== victim.id);
      droppedJobs++;
      summary = { ...summary, totalJobs: retainedForSize.length, droppedJobs };
      index = makeIndex();
      indexByteSize(index);
   }

   // At the hard fallback boundary, retaining an oversized Task record is worse
   // than retaining no jobs. The empty index remains parseable and reserves all
   // worker IDs through the original snapshot's sequence maximum.
   if (indexByteSize(index) > maxManifestBytes) {
      retainedForSize = [];
      droppedJobs = normalizedJobs.length;
      summary = { ...summary, totalJobs: 0, droppedJobs };
      index = makeIndex();
      indexByteSize(index);
   }

   return { index, summary };
}

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
   "pending",
   "running",
   "completed",
   "recoverable",
   "failed",
   "cancelled"
]);

/** JSON value accepted in persisted tool arguments, resultData, and raw event data. */
export type PersistedJsonValue = JsonValue;

function isRecord(value: unknown): value is Record<string, unknown> {
   return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
   return Object.keys(record).every((key) => keys.has(key));
}

function parseOptionalString(value: unknown): string | undefined {
   return isPersistedString(value) ? value : undefined;
}

function isPersistedString(value: unknown): value is string {
   return typeof value === "string" && value.length <= WORKERS_TASK_MANIFEST_LIMITS.maxPersistedStringChars;
}

function parseFiniteNumber(value: unknown): number | undefined {
   if (typeof value !== "number") return undefined;
   if (!Number.isFinite(value)) return undefined;
   return value;
}

function parseOptionalTimestamp(record: Record<string, unknown>): number | undefined {
   if (!("timestamp" in record)) return undefined;
   return parseFiniteNumber(record.timestamp);
}

function parsePersistedJsonValue(value: unknown, depth = 0): JsonValue | undefined {
   if (value === null || typeof value === "boolean") return value;
   if (typeof value === "string") return isPersistedString(value) ? value : undefined;
   if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

   if (Array.isArray(value)) {
      if (value.length > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength) return undefined;
      if (depth >= WORKERS_TASK_MANIFEST_LIMITS.maxPersistedNestingDepth) return undefined;
      const parsed: JsonValue[] = [];
      for (const item of value) {
         const next = parsePersistedJsonValue(item, depth + 1);
         // JSON parsed from disk cannot contain undefined. Keep this explicit so
         // direct callers of the parser fail closed as well.
         if (next === undefined) return undefined;
         parsed.push(next);
      }
      return parsed;
   }

   if (!isRecord(value)) return undefined;
   const keys = Object.keys(value);
   if (keys.some((key) => !isPersistedString(key))) return undefined;
   if (TRUNCATED_KEY in value) {
      if (keys.length !== 1 || !isPersistedString(value[TRUNCATED_KEY])) return undefined;
   } else if (depth >= WORKERS_TASK_MANIFEST_LIMITS.maxPersistedNestingDepth) {
      return undefined;
   }

   const parsed: Record<string, JsonValue> = {};
   for (const key of keys) {
      const next = parsePersistedJsonValue(value[key], depth + 1);
      if (next === undefined) return undefined;
      parsed[key] = next;
   }
   return parsed;
}

function parseTranscriptContent(value: unknown): ReadonlyArray<TaskTranscriptContent> | undefined {
   if (!Array.isArray(value) || value.length > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength) return undefined;
   const content: TaskTranscriptContent[] = [];
   for (const item of value) {
      if (!isRecord(item) || typeof item.type !== "string") return undefined;
      if (item.type === "text" && isPersistedString(item.text)) {
         if (!hasOnlyKeys(item, new Set(["type", "text"]))) return undefined;
         content.push({ type: "text", text: item.text });
      } else if (item.type === "image" && isPersistedString(item.mimeType)) {
         if (!hasOnlyKeys(item, new Set(["type", "mimeType"]))) return undefined;
         content.push({ type: "image", mimeType: item.mimeType });
      } else {
         return undefined;
      }
   }
   return content;
}

function parseTranscript(value: unknown): ReadonlyArray<TaskTranscriptEntry> | undefined {
   if (!Array.isArray(value) || value.length > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength) return undefined;
   const entries: TaskTranscriptEntry[] = [];
   for (const item of value) {
      if (!isRecord(item) || typeof item.type !== "string") return undefined;
      const timestamp = parseOptionalTimestamp(item);
      if ("timestamp" in item && timestamp === undefined) return undefined;

      if (item.type === "user" || item.type === "thinking" || item.type === "assistant" || item.type === "error") {
         if (!hasOnlyKeys(item, new Set(["type", "text", "timestamp"])) || !isPersistedString(item.text)) {
            return undefined;
         }
         entries.push({ type: item.type, text: item.text, timestamp } as TaskTranscriptEntry);
         continue;
      }

      if (item.type === "tool-call") {
         if (
            !hasOnlyKeys(item, new Set(["type", "toolCallId", "toolName", "arguments", "raw", "timestamp"])) ||
            !isPersistedString(item.toolCallId) ||
            !isPersistedString(item.toolName)
         )
            return undefined;
         const argumentsValue = parsePersistedJsonValue(item.arguments);
         if (argumentsValue === undefined) return undefined;
         const raw = item.raw === undefined ? undefined : parsePersistedJsonValue(item.raw);
         if (item.raw !== undefined && raw === undefined) return undefined;
         entries.push({
            type: "tool-call",
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            arguments: argumentsValue,
            raw,
            timestamp
         });
         continue;
      }

      if (item.type === "tool-result") {
         if (
            !hasOnlyKeys(item, new Set(["type", "toolCallId", "toolName", "content", "isError", "raw", "timestamp"])) ||
            !isPersistedString(item.toolCallId) ||
            !isPersistedString(item.toolName) ||
            typeof item.isError !== "boolean"
         )
            return undefined;
         const content = parseTranscriptContent(item.content);
         if (content === undefined) return undefined;
         const raw = item.raw === undefined ? undefined : parsePersistedJsonValue(item.raw);
         if (item.raw !== undefined && raw === undefined) return undefined;
         entries.push({
            type: "tool-result",
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            content,
            isError: item.isError,
            raw,
            timestamp
         });
         continue;
      }

      return undefined;
   }
   return entries;
}

function parseManifestSummary(value: unknown): ManifestSummary | undefined {
   if (!isRecord(value)) return undefined;
   const keys = new Set(["totalJobs", "truncatedJobs", "droppedStringChars", "droppedArrayItems", "droppedJobs"]);
   const acceptedKeys = new Set([...keys, "droppedTranscriptEntries"]);
   if (!hasOnlyKeys(value, acceptedKeys)) return undefined;

   const values: Record<string, number> = {};
   for (const key of keys) {
      const number = parseFiniteNumber(value[key]);
      if (number === undefined || number < 0 || !Number.isInteger(number)) return undefined;
      values[key] = number;
   }
   if ("droppedTranscriptEntries" in value) {
      const legacyCount = parseFiniteNumber(value.droppedTranscriptEntries);
      if (legacyCount === undefined || legacyCount < 0 || !Number.isInteger(legacyCount)) return undefined;
   }
   return {
      totalJobs: values.totalJobs,
      truncatedJobs: values.truncatedJobs,
      droppedStringChars: values.droppedStringChars,
      droppedArrayItems: values.droppedArrayItems,
      droppedJobs: values.droppedJobs
   };
}

/**
 * Strictly parse a single persisted Task record into the in-memory {@link Task}
 * shape. The record is rejected if any required field is missing or any present
 * optional field has an unsupported type or value.
 */
export function parsePersistedTaskEntry(raw: unknown): Task | undefined {
   if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
   const record = raw as Record<string, unknown>;
   const taskKeys = new Set([
      "id",
      "ownerSessionId",
      "name",
      "agent",
      "worker",
      "async",
      "model",
      "thinking",
      "cwd",
      "context",
      "contextTokens",
      "origin",
      "batchId",
      "batchSize",
      "promptOrCommand",
      "systemPrompt",
      "status",
      "createdAt",
      "startedAt",
      "settledAt",
      "resultData",
      "errorText",
      // rawText remains accepted for manifests written before semantic trace persistence.
      "rawText",
      "transcript",
      "sessionFile",
      "sessionId"
   ]);
   if (!hasOnlyKeys(record, taskKeys)) return undefined;
   if (Object.keys(record).some((key) => !isPersistedString(key))) return undefined;
   try {
      if (
         Buffer.byteLength(JSON.stringify(record, undefined, 2), "utf8") >
         WORKERS_TASK_MANIFEST_LIMITS.maxPersistedJobBytes
      )
         return undefined;
   } catch {
      return undefined;
   }

   if (!isPersistedString(record.id) || record.id.length === 0) return undefined;
   if (!isPersistedString(record.ownerSessionId)) return undefined;
   if (!isPersistedString(record.promptOrCommand)) return undefined;

   if (typeof record.status !== "string" || !TASK_STATUSES.has(record.status as TaskStatus)) return undefined;

   const createdAt = parseFiniteNumber(record.createdAt);
   if (createdAt === undefined) return undefined;

   let name: string | null = null;
   if (record.name !== undefined) {
      if (record.name === null) {
         name = null;
      } else if (isPersistedString(record.name)) {
         name = record.name;
      } else {
         return undefined;
      }
   }

   if (record.origin !== undefined && !isPersistedString(record.origin)) return undefined;

   const startedAt = parseFiniteNumber(record.startedAt);
   if (record.startedAt !== undefined && startedAt === undefined) return undefined;

   const settledAt = parseFiniteNumber(record.settledAt);
   if (record.settledAt !== undefined && settledAt === undefined) return undefined;

   if (record.agent !== undefined && !isPersistedString(record.agent)) return undefined;
   if (record.worker !== undefined && !isPersistedString(record.worker)) return undefined;
   if (record.async !== undefined && typeof record.async !== "boolean") return undefined;
   if (record.model !== undefined && !isPersistedString(record.model)) return undefined;
   if (record.thinking !== undefined && !isPersistedString(record.thinking)) return undefined;
   if (record.cwd !== undefined && !isPersistedString(record.cwd)) return undefined;
   if (record.context !== undefined && !isPersistedString(record.context)) return undefined;
   const contextTokens = parseFiniteNumber(record.contextTokens);
   if (record.contextTokens !== undefined && contextTokens === undefined) return undefined;
   if (record.batchId !== undefined && !isPersistedString(record.batchId)) return undefined;
   const batchSize = parseFiniteNumber(record.batchSize);
   if (record.batchSize !== undefined && (batchSize === undefined || batchSize < 1 || !Number.isInteger(batchSize)))
      return undefined;
   if (record.errorText !== undefined && !isPersistedString(record.errorText)) return undefined;
   if (record.systemPrompt !== undefined && !isPersistedString(record.systemPrompt)) return undefined;
   if (record.sessionFile !== undefined && !isPersistedString(record.sessionFile)) return undefined;
   if (record.sessionId !== undefined && !isPersistedString(record.sessionId)) return undefined;

   const resultData = record.resultData === undefined ? undefined : parsePersistedJsonValue(record.resultData);
   if (record.resultData !== undefined && resultData === undefined) return undefined;
   const transcript = record.transcript === undefined ? undefined : parseTranscript(record.transcript);
   if (record.transcript !== undefined && transcript === undefined) return undefined;

   const status =
      record.status === "recoverable" && typeof record.sessionFile !== "string"
         ? "failed"
         : (record.status as TaskStatus);

   return {
      id: normalizePersistedTaskId(record.id),
      ownerSessionId: record.ownerSessionId,
      name,
      worker: parseOptionalString(record.worker) ?? parseOptionalString(record.agent),
      model: parseOptionalString(record.model),
      thinking: parseOptionalString(record.thinking),
      cwd: parseOptionalString(record.cwd),
      context: parseOptionalString(record.context),
      contextTokens,
      batchId: parseOptionalString(record.batchId),
      batchSize,
      promptOrCommand: record.promptOrCommand,
      systemPrompt: parseOptionalString(record.systemPrompt),
      status,
      createdAt,
      startedAt,
      settledAt,
      resultData,
      errorText: parseOptionalString(record.errorText),
      transcript,
      sessionFile: parseOptionalString(record.sessionFile),
      sessionId: parseOptionalString(record.sessionId)
   };
}

/** Map a legacy persisted `worker-<seq>` id to the task vocabulary. */
export function normalizePersistedTaskId(id: string): string {
   return id.replace(/^worker-(\d+)$/, "task-$1");
}

/**
 * Fail-closed parser for the persisted manifest index. Any structural mismatch,
 * invalid Task, or duplicate Task ID rejects the entire manifest so load can
 * quarantine it instead of silently recovering a partial/empty index.
 */
export function parsePersistedIndex(record: Record<string, unknown>): WorkersTaskIndex | undefined {
   if (!isRecord(record)) return undefined;
   const indexKeys = new Set([
      "version",
      "parentSessionFile",
      "writtenAt",
      "reservedWorkerSeq",
      "reservedTaskSeq",
      "summary",
      "jobs"
   ]);
   if (!hasOnlyKeys(record, indexKeys)) return undefined;
   if (Object.keys(record).some((key) => !isPersistedString(key))) return undefined;
   if (typeof record.version !== "number" || !Number.isFinite(record.version)) return undefined;
   // Version 1 is the only supported boundary. Do not guess at forward migrations.
   if (record.version !== WORKERS_TASK_MANIFEST_VERSION) return undefined;

   if (record.parentSessionFile !== undefined && !isPersistedString(record.parentSessionFile)) return undefined;
   if (record.writtenAt !== undefined && parseFiniteNumber(record.writtenAt) === undefined) return undefined;
   const rawReservedSeq = record.reservedTaskSeq ?? record.reservedWorkerSeq;
   if (rawReservedSeq !== undefined) {
      const reservedSeq = parseFiniteNumber(rawReservedSeq);
      if (reservedSeq === undefined || reservedSeq < 0 || !Number.isInteger(reservedSeq)) return undefined;
   }
   const reservedTaskSeq = rawReservedSeq === undefined ? undefined : (parseFiniteNumber(rawReservedSeq) ?? undefined);

   if (!Array.isArray(record.jobs) || record.jobs.length > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength)
      return undefined;

   const summary = record.summary === undefined ? undefined : parseManifestSummary(record.summary);
   if (record.summary !== undefined && summary === undefined) return undefined;

   const jobs: Task[] = [];
   const seenIds = new Set<string>();
   for (const raw of record.jobs) {
      const parsed = parsePersistedTaskEntry(raw);
      if (parsed === undefined) return undefined;
      if (seenIds.has(parsed.id)) return undefined;
      seenIds.add(parsed.id);
      jobs.push(parsed);
   }

   return {
      version: record.version,
      parentSessionFile: record.parentSessionFile as string | undefined,
      writtenAt: record.writtenAt as number | undefined,
      source: "valid" as const,
      reservedTaskSeq,
      summary,
      jobs
   };
}
