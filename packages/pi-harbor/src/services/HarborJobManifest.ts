import type { HarnessName, Job, JobKind, JobStatus, JobTranscriptContent, JobTranscriptEntry } from "../domain.js";

export const HARBOR_JOB_MANIFEST_VERSION = 1;

/**
 * Mutable bounds and retention policy for persisted job manifests.
 *
 * Exported as a mutable object so tests can temporarily tighten limits and
 * reset them with {@link resetManifestLimits}.
 */
export const HARBOR_JOB_MANIFEST_LIMITS = {
   /** Registry-level cap on tracked jobs. */
   maxTrackedJobs: 64,

   /** Terminal jobs older than this are eligible for pruning. */
   maxTerminalAgeMs: 30 * 24 * 60 * 60 * 1000,

   /** How many transcript entries to keep in the persisted preview. */
   maxPersistedTranscriptEntries: 5,

   /** How many characters of the in-memory rawText to persist for a preview. */
   maxPersistedRawTextChars: 1024,

   /** Maximum string length inside any normalized payload. */
   maxPersistedStringChars: 8192,

   /** Maximum array length inside any normalized payload. */
   maxPersistedArrayLength: 64,

   /** Maximum nesting depth inside any normalized payload. */
   maxPersistedNestingDepth: 8,

   /** Soft ceiling for a single persisted job record. */
   maxPersistedJobBytes: 65536,

   /** Hard ceiling for the whole serialized manifest. */
   maxPersistedManifestBytes: 1024 * 1024,

   /** Debounce window for coalescing registry-change writes. */
   persistDebounceMs: 50
};

/** Reset all manifest limits and retention constants to their defaults. */
export function resetManifestLimits(): void {
   HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs = 64;
   HARBOR_JOB_MANIFEST_LIMITS.maxTerminalAgeMs = 30 * 24 * 60 * 60 * 1000;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedTranscriptEntries = 5;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedRawTextChars = 1024;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 8192;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength = 64;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth = 8;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes = 65536;
   HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes = 1024 * 1024;
   HARBOR_JOB_MANIFEST_LIMITS.persistDebounceMs = 50;
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
   readonly droppedTranscriptEntries: number;
   readonly droppedJobs: number;
}

/** Persisted representation of the jobs tracked for a parent session. */
export interface HarborJobIndex {
   readonly version: number;
   readonly parentSessionFile?: string;
   readonly writtenAt?: number;
   /** Distinguishes a valid empty index from a missing/corrupt one. */
   readonly source?: "valid" | "missing";
   /** Highest task sequence number used by the parent session, independent of retained jobs. */
   readonly reservedTaskSeq?: number;
   readonly summary?: ManifestSummary;
   readonly jobs: ReadonlyArray<Job>;
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

function takeSuffixWithinBound(value: string, maxLength: number): string {
   if (maxLength <= 0) return "";
   const characters = Array.from(value);
   let result = "";
   let bytes = 0;
   for (let i = characters.length - 1; i >= 0; i--) {
      const character = characters[i]!;
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (result.length + character.length > maxLength || bytes + characterBytes > maxLength) break;
      result = character + result;
      bytes += characterBytes;
   }
   return result;
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

function truncateTailWithSuffix(
   value: string,
   maxLength: number,
   suffixForDropped: (dropped: number) => string,
   compactSuffix: string
): { readonly value: string; readonly kept: string } {
   if (maxLength <= 0) return { value: "", kept: "" };

   let suffix = boundedMetadataText(suffixForDropped(value.length), maxLength, compactSuffix);
   let kept = takeSuffixWithinBound(value, maxLength - suffix.length);
   for (;;) {
      const dropped = value.length - kept.length;
      suffix = boundedMetadataText(suffixForDropped(dropped), maxLength, compactSuffix);
      const candidate = `${suffix}${kept}`;
      if (persistedStringFits(candidate, maxLength)) return { value: candidate, kept };
      if (kept.length === 0) return { value: suffix, kept };
      kept = takeSuffixWithinBound(value, kept.length - 1);
   }
}

function boundString(value: string, state: NormalizationState): string {
   return truncateString(value, HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars, state);
}

function boundStringWithoutAccounting(value: string): string {
   return truncateString(value, HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars, createRootNormalizationState());
}

function boundedMarker(message: string): string {
   return boundedMetadataText(message, HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars, "[truncated]");
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

      if (ctx.depth >= HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth) {
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
               const max = HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength;
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

function summarizeRawText(rawText: string | undefined, state: NormalizationState): string | undefined {
   if (rawText === undefined || rawText.length === 0) return undefined;
   const max = HARBOR_JOB_MANIFEST_LIMITS.maxPersistedRawTextChars;
   if (rawText.length <= max) return boundString(rawText, state);

   const kept = takeSuffixWithinBound(rawText, max);
   const omitted = rawText.length - kept.length;
   const result = truncateTailWithSuffix(
      kept,
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars,
      () => `… [${omitted} earlier characters omitted]\\n`,
      "[truncated]"
   );
   state.truncated = true;
   state.droppedStringChars += omitted + (kept.length - result.kept.length);
   return result.value;
}

function boundTranscriptContent(
   content: ReadonlyArray<JobTranscriptContent>,
   state: NormalizationState
): ReadonlyArray<JobTranscriptContent> {
   const max = HARBOR_JOB_MANIFEST_LIMITS.maxPersistedTranscriptEntries;
   return content.slice(0, max).map((item) => {
      if (item.type === "text") {
         return { type: "text", text: boundString(item.text, state) };
      }
      return { type: "image", mimeType: boundString(item.mimeType, state) };
   });
}

function previewTranscript(
   transcript: ReadonlyArray<JobTranscriptEntry> | undefined,
   state: NormalizationState
): ReadonlyArray<JobTranscriptEntry> | undefined {
   if (transcript === undefined || transcript.length === 0) return undefined;
   const max = HARBOR_JOB_MANIFEST_LIMITS.maxPersistedTranscriptEntries;
   const kept = transcript.length <= max ? transcript : transcript.slice(transcript.length - max);
   if (transcript.length > max) {
      state.truncated = true;
      // Dropped entries are surfaced in the per-job summary through other metrics;
      // we track them explicitly here as dropped array items for simplicity.
      state.droppedArrayItems += transcript.length - max;
   }

   return kept.map((entry) => {
      switch (entry.type) {
         case "user":
         case "thinking":
         case "assistant":
            return {
               type: entry.type,
               text: boundString(entry.text, state),
               timestamp: entry.timestamp
            };
         case "tool-call":
            return {
               type: "tool-call",
               toolCallId: boundString(entry.toolCallId, state),
               toolName: boundString(entry.toolName, state),
               arguments: toPersistableValue(
                  entry.arguments,
                  { depth: 0, seen: new Set(), path: "arguments" },
                  state
               ) as unknown,
               timestamp: entry.timestamp
            };
         case "tool-result": {
            return {
               type: "tool-result",
               toolCallId: boundString(entry.toolCallId, state),
               toolName: boundString(entry.toolName, state),
               content: boundTranscriptContent(entry.content, state),
               isError: entry.isError,
               timestamp: entry.timestamp
            };
         }
         default:
            return entry;
      }
   });
}

/** Result of normalizing a single job for persistence. */
export interface NormalizedJobResult {
   readonly job: Job;
   readonly truncated: boolean;
   readonly droppedStringChars: number;
   readonly droppedArrayItems: number;
   readonly droppedTranscriptEntries: number;
}

/**
 * Create a bounded, JSON-safe persisted copy of a job, keeping child session
 * references but replacing rawText with a preview and transcripts with the
 * most recent entries.
 */
export function normalizePersistedJob(job: Job): NormalizedJobResult {
   const state = createRootNormalizationState();

   const normalizedResultData =
      job.resultData !== undefined
         ? (toPersistableValue(job.resultData, { depth: 0, seen: new Set(), path: "resultData" }, state) as unknown)
         : undefined;

   const normalizedErrorText = job.errorText !== undefined ? boundString(job.errorText, state) : undefined;

   const rawTextSummary = summarizeRawText(job.rawText, state);

   const transcriptPreview = previewTranscript(job.transcript, state);
   const droppedTranscriptEntries =
      job.transcript !== undefined && transcriptPreview !== undefined
         ? job.transcript.length - transcriptPreview.length
         : 0;

   const normalized: Job = {
      id: boundString(job.id, state),
      ownerSessionId: boundString(job.ownerSessionId, state),
      name: job.name === null || job.name === undefined ? job.name : boundString(job.name, state),
      kind: job.kind,
      harness: job.harness,
      agent: job.agent === undefined ? undefined : boundString(job.agent, state),
      async: job.async,
      model: job.model === undefined ? undefined : boundString(job.model, state),
      thinking: job.thinking === undefined ? undefined : boundString(job.thinking, state),
      cwd: job.cwd === undefined ? undefined : boundString(job.cwd, state),
      origin: job.origin,
      promptOrCommand: boundString(job.promptOrCommand, state),
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      settledAt: job.settledAt,
      pid: job.pid,
      exitCode: job.exitCode,
      signal: job.signal,
      resultData: normalizedResultData,
      errorText: normalizedErrorText,
      rawText: rawTextSummary,
      transcript: transcriptPreview,
      waitInterest: 0,
      killInterest: 0,
      sessionFile: job.sessionFile === undefined ? undefined : boundString(job.sessionFile, state),
      sessionId: job.sessionId === undefined ? undefined : boundString(job.sessionId, state)
   };

   if (byteLength(normalized) > HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes) {
      state.truncated = true;
      let reduced: Job = {
         ...normalized,
         resultData: truncatedMarker("per-job byte limit exceeded"),
         rawText: undefined,
         transcript: undefined,
         promptOrCommand: normalized.promptOrCommand.slice(0, Math.min(normalized.promptOrCommand.length, 80))
      };
      // Recompute after reductions; if the prompt still pushes the record over
      // the limit, drop it entirely so the persisted job remains structural.
      if (byteLength(reduced) > HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes) {
         reduced = { ...reduced, promptOrCommand: "" };
      }
      return {
         job: reduced,
         truncated: true,
         droppedStringChars: state.droppedStringChars,
         droppedArrayItems: state.droppedArrayItems,
         droppedTranscriptEntries
      };
   }

   return {
      job: normalized,
      truncated: state.truncated || droppedTranscriptEntries > 0,
      droppedStringChars: state.droppedStringChars,
      droppedArrayItems: state.droppedArrayItems,
      droppedTranscriptEntries
   };
}

function isTerminalStatus(status: JobStatus): boolean {
   return status === "completed" || status === "failed" || status === "cancelled";
}

function jobAgeMs(job: Job, now: number): number {
   const anchor = job.settledAt ?? job.createdAt;
   return now - anchor;
}

/**
 * Drop terminal jobs until the collection is at or below the target size,
 * preferring the oldest terminal jobs. Also removes terminal jobs that exceed
 * the configured age cap so retention remains finite for background jobs.
 */
export function pruneTerminalJobsForRetention(
   jobs: ReadonlyArray<Job>,
   now: number,
   targetSize: number = HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs
): Job[] {
   const maxAge = HARBOR_JOB_MANIFEST_LIMITS.maxTerminalAgeMs;

   const removable: Job[] = [];
   for (const job of jobs) {
      if (isTerminalStatus(job.status) && job.waitInterest === 0 && job.killInterest === 0) {
         removable.push(job);
      }
   }

   removable.sort((a, b) => {
      const aTime = a.settledAt ?? a.createdAt;
      const bTime = b.settledAt ?? b.createdAt;
      if (aTime !== bTime) return aTime - bTime;
      return a.createdAt - b.createdAt;
   });

   const removedByAge = removable.filter((job) => jobAgeMs(job, now) > maxAge);
   const removedByCapacity = removable.slice(0, Math.max(0, jobs.length - Math.min(targetSize, jobs.length)));

   const removedIds = new Set<string>([
      ...removedByAge.map((job) => job.id),
      ...removedByCapacity.map((job) => job.id)
   ]);

   return jobs.filter((job) => !removedIds.has(job.id));
}

/**
 * Compute the highest task sequence number used by a set of jobs so id
 * monotonicity survives manifest pruning.
 */
export function computeReservedTaskSeq(jobs: ReadonlyArray<Job>): number {
   let max = 0;
   for (const job of jobs) {
      const match = /^task-(\d+)$/.exec(job.id);
      if (match) {
         const n = Number(match[1]);
         if (n > max) max = n;
      }
   }
   return max;
}

/** Normalized manifest index together with its truncation summary. */
export interface NormalizedIndexResult {
   readonly index: HarborJobIndex;
   readonly summary: ManifestSummary;
}

function indexByteSize(index: HarborJobIndex): number {
   // This is the exact serialization used by HarborJobPersistence. Keeping the
   // indentation here prevents a compact-size check from producing an oversized
   // pretty-printed file on disk.
   return byteLength(index);
}

function truncationText(label: string, omitted: number): string {
   const full = `[__truncated: ${label}; ${Math.max(0, omitted)} characters omitted]`;
   return boundedMetadataText(full, HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars, "[__truncated]");
}

function removeJobPreviews(job: Job): {
   readonly job: Job;
   readonly rawChars: number;
   readonly transcriptEntries: number;
} {
   return {
      job: {
         ...job,
         rawText: undefined,
         transcript: undefined
      },
      rawChars: job.rawText?.length ?? 0,
      transcriptEntries: job.transcript?.length ?? 0
   };
}

function compactJobSummaries(job: Job): {
   readonly job: Job;
   readonly droppedStringChars: number;
   readonly changed: boolean;
} {
   let droppedStringChars = 0;
   let changed = false;

   const resultData =
      job.resultData === undefined
         ? undefined
         : (() => {
              changed = true;
              try {
                 droppedStringChars += JSON.stringify(job.resultData).length;
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
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars,
         (dropped) => truncationText(label, dropped),
         "[__truncated]",
         128
      );
      droppedStringChars += value.length - result.kept.length;
      return result.value;
   };

   const errorText = compactText(job.errorText, "errorText");
   const promptOrCommand = compactText(job.promptOrCommand, "promptOrCommand") ?? truncationText("promptOrCommand", 0);
   if (promptOrCommand !== job.promptOrCommand) changed = true;

   return {
      job: {
         ...job,
         resultData,
         errorText,
         promptOrCommand,
         rawText: undefined,
         transcript: undefined
      },
      droppedStringChars,
      changed
   };
}

/**
 * The final per-job form keeps every field needed to identify and restart a job
 * while replacing all optional payloads with small, parser-valid summaries.
 */
function minimalRecoveryJob(job: Job): {
   readonly job: Job;
   readonly droppedStringChars: number;
   readonly changed: boolean;
} {
   const hasResult = job.resultData !== undefined;
   const hasError = job.errorText !== undefined;
   const prompt = truncationText("promptOrCommand", job.promptOrCommand.length);
   return {
      job: {
         id: job.id,
         ownerSessionId: job.ownerSessionId,
         name: job.name,
         kind: job.kind,
         harness: job.harness,
         agent: job.agent,
         async: job.async,
         model: job.model,
         thinking: job.thinking,
         cwd: job.cwd,
         origin: job.origin,
         promptOrCommand: prompt,
         status: job.status,
         createdAt: job.createdAt,
         startedAt: job.startedAt,
         settledAt: job.settledAt,
         pid: job.pid,
         exitCode: job.exitCode,
         signal: job.signal,
         resultData: hasResult ? truncatedMarker("resultData summary omitted") : undefined,
         errorText: hasError ? truncationText("errorText", job.errorText?.length ?? 0) : undefined,
         rawText: undefined,
         transcript: undefined,
         waitInterest: 0,
         killInterest: 0,
         sessionFile: job.sessionFile,
         sessionId: job.sessionId
      },
      droppedStringChars: job.promptOrCommand.length + (job.errorText?.length ?? 0),
      changed: true
   };
}

/**
 * Build a persisted manifest index from the registry snapshot. Optional data is
 * reduced for every job before any job is dropped. Every candidate is measured
 * using UTF-8 bytes after each reduction and the deterministic drop fallback is
 * applied only when the reduced index still exceeds the hard ceiling.
 */
export function buildPersistedIndex(jobs: ReadonlyArray<Job>, parentSessionFile?: string): NormalizedIndexResult {
   const normalizedJobs: Job[] = [];
   const truncatedJobIds = new Set<string>();
   let droppedStringChars = 0;
   let droppedArrayItems = 0;
   let droppedTranscriptEntries = 0;

   for (const job of jobs) {
      const normalized = normalizePersistedJob(job);
      normalizedJobs.push(normalized.job);
      if (normalized.truncated) truncatedJobIds.add(job.id);
      droppedStringChars += normalized.droppedStringChars;
      droppedArrayItems += normalized.droppedArrayItems;
      droppedTranscriptEntries += normalized.droppedTranscriptEntries;
   }

   // Retention uses the live snapshot, not normalized interest counters. The
   // counters are intentionally not recoverable, but they must protect a
   // terminal job from ordinary age/capacity pruning while it is in use.
   const retainedIds = new Set(pruneTerminalJobsForRetention(jobs, Date.now()).map((job) => job.id));
   let retainedForSize = normalizedJobs.filter((job) => retainedIds.has(job.id));
   let droppedJobs = normalizedJobs.length - retainedForSize.length;
   const interestById = new Map(jobs.map((job) => [job.id, job.waitInterest > 0 || job.killInterest > 0]));

   let summary: ManifestSummary = {
      totalJobs: retainedForSize.length,
      truncatedJobs: truncatedJobIds.size,
      droppedStringChars,
      droppedArrayItems,
      droppedTranscriptEntries,
      droppedJobs
   };

   const makeIndex = (): HarborJobIndex => ({
      version: HARBOR_JOB_MANIFEST_VERSION,
      parentSessionFile: parentSessionFile === undefined ? undefined : boundStringWithoutAccounting(parentSessionFile),
      reservedTaskSeq: computeReservedTaskSeq(jobs),
      summary,
      jobs: retainedForSize
   });

   let index = makeIndex();
   const maxManifestBytes = HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes;

   const applyReduction = (
      reduction: (job: Job) => { readonly job: Job; readonly droppedStringChars: number; readonly changed: boolean },
      includePreviewCounts = false
   ) => {
      const nextJobs: Job[] = [];
      for (const job of retainedForSize) {
         if (includePreviewCounts) {
            const preview = removeJobPreviews(job);
            nextJobs.push(preview.job);
            if (preview.rawChars > 0 || preview.transcriptEntries > 0) truncatedJobIds.add(job.id);
            droppedStringChars += preview.rawChars;
            droppedTranscriptEntries += preview.transcriptEntries;
            continue;
         }
         const next = reduction(job);
         nextJobs.push(next.job);
         if (next.changed) truncatedJobIds.add(job.id);
         droppedStringChars += next.droppedStringChars;
      }
      retainedForSize = nextJobs;
      summary = {
         ...summary,
         totalJobs: retainedForSize.length,
         truncatedJobs: truncatedJobIds.size,
         droppedStringChars,
         droppedTranscriptEntries
      };
      index = makeIndex();
      indexByteSize(index);
   };

   // Measure before and after every whole-registry reduction. This first pass
   // removes bounded previews, then compacts payload summaries. Recovery-critical
   // configuration fields remain exact; jobs are dropped only after this pass.
   if (indexByteSize(index) > maxManifestBytes) {
      applyReduction((job) => ({ job, droppedStringChars: 0, changed: false }), true);
   }
   if (indexByteSize(index) > maxManifestBytes) applyReduction(compactJobSummaries);
   if (indexByteSize(index) > maxManifestBytes) applyReduction(minimalRecoveryJob);

   const compareDropPriority = (a: Job, b: Job): number => {
      const aProtected = interestById.get(a.id) === true;
      const bProtected = interestById.get(b.id) === true;
      if (aProtected !== bProtected) return aProtected ? 1 : -1;
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
      retainedForSize = retainedForSize.filter((job) => job.id !== victim.id);
      droppedJobs++;
      summary = { ...summary, totalJobs: retainedForSize.length, droppedJobs };
      index = makeIndex();
      indexByteSize(index);
   }

   // At the hard fallback boundary, retaining an oversized job record is worse
   // than retaining no jobs. The empty index remains parseable and reserves all
   // task IDs through the original snapshot's sequence maximum.
   if (indexByteSize(index) > maxManifestBytes) {
      retainedForSize = [];
      droppedJobs = normalizedJobs.length;
      summary = { ...summary, totalJobs: 0, droppedJobs };
      index = makeIndex();
      indexByteSize(index);
   }

   return { index, summary };
}

const JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["pending", "running", "completed", "failed", "cancelled"]);
const JOB_KINDS: ReadonlySet<JobKind> = new Set(["agent", "bash"]);
const JOB_HARNESSES: ReadonlySet<HarnessName> = new Set(["pi", "agy"]);
const JOB_ORIGINS = new Set<"standard" | "vibe" | "btw">(["standard", "vibe", "btw"]);

/** JSON value accepted in persisted tool arguments, resultData, and raw event data. */
export type PersistedJsonValue = JsonValue;

/** Content blocks emitted by the persisted tool-result serializer. */
export type PersistedTranscriptContent =
   | { readonly type: "text"; readonly text: string }
   | { readonly type: "image"; readonly mimeType: string };

/** Exact transcript entry variants emitted by the manifest serializer. */
export type PersistedTranscriptEntry =
   | { readonly type: "user" | "thinking" | "assistant"; readonly text: string; readonly timestamp?: number }
   | {
        readonly type: "tool-call";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly arguments: PersistedJsonValue;
        readonly timestamp?: number;
     }
   | {
        readonly type: "tool-result";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly content: ReadonlyArray<PersistedTranscriptContent>;
        readonly isError: boolean;
        readonly timestamp?: number;
     };

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
   return typeof value === "string" && value.length <= HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
   return typeof value === "boolean" ? value : undefined;
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
      if (value.length > HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength) return undefined;
      if (depth >= HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth) return undefined;
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
   } else if (depth >= HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth) {
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

function parsePersistedTranscriptContent(value: unknown): PersistedTranscriptContent | undefined {
   if (!isRecord(value) || !isPersistedString(value.type)) return undefined;
   if (value.type === "text") {
      if (!hasOnlyKeys(value, new Set(["type", "text"])) || !isPersistedString(value.text)) return undefined;
      return { type: "text", text: value.text };
   }
   if (value.type === "image") {
      if (!hasOnlyKeys(value, new Set(["type", "mimeType"])) || !isPersistedString(value.mimeType)) return undefined;
      return { type: "image", mimeType: value.mimeType };
   }
   return undefined;
}

function parsePersistedTranscriptEntry(value: unknown): PersistedTranscriptEntry | undefined {
   if (!isRecord(value) || !isPersistedString(value.type)) return undefined;

   if (value.type === "user" || value.type === "thinking" || value.type === "assistant") {
      if (!hasOnlyKeys(value, new Set(["type", "text", "timestamp"]))) return undefined;
      if (!isPersistedString(value.text)) return undefined;
      const timestamp = parseOptionalTimestamp(value);
      if ("timestamp" in value && timestamp === undefined) return undefined;
      return { type: value.type, text: value.text, timestamp };
   }

   if (value.type === "tool-call") {
      if (!hasOnlyKeys(value, new Set(["type", "toolCallId", "toolName", "arguments", "timestamp"]))) return undefined;
      if (!isPersistedString(value.toolCallId) || !isPersistedString(value.toolName)) return undefined;
      if (!("arguments" in value)) return undefined;
      const argumentsValue = parsePersistedJsonValue(value.arguments);
      if (argumentsValue === undefined) return undefined;
      const timestamp = parseOptionalTimestamp(value);
      if ("timestamp" in value && timestamp === undefined) return undefined;
      return {
         type: "tool-call",
         toolCallId: value.toolCallId,
         toolName: value.toolName,
         arguments: argumentsValue,
         timestamp
      };
   }

   if (value.type === "tool-result") {
      if (!hasOnlyKeys(value, new Set(["type", "toolCallId", "toolName", "content", "isError", "timestamp"])))
         return undefined;
      if (!isPersistedString(value.toolCallId) || !isPersistedString(value.toolName)) return undefined;
      if (
         !Array.isArray(value.content) ||
         value.content.length > HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength ||
         typeof value.isError !== "boolean"
      )
         return undefined;
      const content: PersistedTranscriptContent[] = [];
      for (const block of value.content) {
         const parsed = parsePersistedTranscriptContent(block);
         if (parsed === undefined) return undefined;
         content.push(parsed);
      }
      const timestamp = parseOptionalTimestamp(value);
      if ("timestamp" in value && timestamp === undefined) return undefined;
      return {
         type: "tool-result",
         toolCallId: value.toolCallId,
         toolName: value.toolName,
         content,
         isError: value.isError,
         timestamp
      };
   }

   return undefined;
}

function parseManifestSummary(value: unknown): ManifestSummary | undefined {
   if (!isRecord(value)) return undefined;
   const keys = new Set([
      "totalJobs",
      "truncatedJobs",
      "droppedStringChars",
      "droppedArrayItems",
      "droppedTranscriptEntries",
      "droppedJobs"
   ]);
   if (!hasOnlyKeys(value, keys)) return undefined;

   const values: Record<string, number> = {};
   for (const key of keys) {
      const number = parseFiniteNumber(value[key]);
      if (number === undefined || number < 0 || !Number.isInteger(number)) return undefined;
      values[key] = number;
   }
   return {
      totalJobs: values.totalJobs,
      truncatedJobs: values.truncatedJobs,
      droppedStringChars: values.droppedStringChars,
      droppedArrayItems: values.droppedArrayItems,
      droppedTranscriptEntries: values.droppedTranscriptEntries,
      droppedJobs: values.droppedJobs
   };
}

/**
 * Strictly parse a single persisted job record into the in-memory {@link Job}
 * shape. The record is rejected if any required field is missing or any present
 * optional field has an unsupported type or value.
 */
export function parsePersistedJobEntry(raw: unknown): Job | undefined {
   if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
   const record = raw as Record<string, unknown>;
   const jobKeys = new Set([
      "id",
      "ownerSessionId",
      "name",
      "kind",
      "harness",
      "agent",
      "async",
      "model",
      "thinking",
      "cwd",
      "origin",
      "promptOrCommand",
      "status",
      "createdAt",
      "startedAt",
      "settledAt",
      "pid",
      "exitCode",
      "signal",
      "resultData",
      "errorText",
      "rawText",
      "transcript",
      "waitInterest",
      "killInterest",
      "sessionFile",
      "sessionId"
   ]);
   if (!hasOnlyKeys(record, jobKeys)) return undefined;
   if (Object.keys(record).some((key) => !isPersistedString(key))) return undefined;
   try {
      if (
         Buffer.byteLength(JSON.stringify(record, undefined, 2), "utf8") >
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes
      )
         return undefined;
   } catch {
      return undefined;
   }

   if (!isPersistedString(record.id) || record.id.length === 0) return undefined;
   if (!isPersistedString(record.ownerSessionId)) return undefined;
   if (!isPersistedString(record.promptOrCommand)) return undefined;

   if (typeof record.kind !== "string" || !JOB_KINDS.has(record.kind as JobKind)) return undefined;
   if (typeof record.status !== "string" || !JOB_STATUSES.has(record.status as JobStatus)) return undefined;

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

   if (record.harness !== undefined && !JOB_HARNESSES.has(record.harness as HarnessName)) return undefined;
   if (record.origin !== undefined && !JOB_ORIGINS.has(record.origin as "standard" | "vibe" | "btw")) return undefined;

   const startedAt = parseFiniteNumber(record.startedAt);
   if (record.startedAt !== undefined && startedAt === undefined) return undefined;

   const settledAt = parseFiniteNumber(record.settledAt);
   if (record.settledAt !== undefined && settledAt === undefined) return undefined;

   const pid = parseFiniteNumber(record.pid);
   if (record.pid !== undefined && pid === undefined) return undefined;

   const exitCode = parseFiniteNumber(record.exitCode);
   if (record.exitCode !== undefined && exitCode === undefined) return undefined;

   if (record.agent !== undefined && !isPersistedString(record.agent)) return undefined;
   if (record.async !== undefined && typeof record.async !== "boolean") return undefined;
   if (record.model !== undefined && !isPersistedString(record.model)) return undefined;
   if (record.thinking !== undefined && !isPersistedString(record.thinking)) return undefined;
   if (record.cwd !== undefined && !isPersistedString(record.cwd)) return undefined;
   if (record.signal !== undefined && !isPersistedString(record.signal)) return undefined;
   if (record.errorText !== undefined && !isPersistedString(record.errorText)) return undefined;
   if (record.rawText !== undefined && !isPersistedString(record.rawText)) return undefined;
   if (record.sessionFile !== undefined && !isPersistedString(record.sessionFile)) return undefined;
   if (record.sessionId !== undefined && !isPersistedString(record.sessionId)) return undefined;
   if (record.waitInterest !== undefined && parseFiniteNumber(record.waitInterest) === undefined) return undefined;
   if (record.killInterest !== undefined && parseFiniteNumber(record.killInterest) === undefined) return undefined;

   let transcript: ReadonlyArray<JobTranscriptEntry> | undefined;
   if (record.transcript !== undefined) {
      if (
         !Array.isArray(record.transcript) ||
         record.transcript.length > HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength
      )
         return undefined;
      const parsedTranscript: JobTranscriptEntry[] = [];
      for (const rawEntry of record.transcript) {
         const parsedEntry = parsePersistedTranscriptEntry(rawEntry);
         if (parsedEntry === undefined) return undefined;
         parsedTranscript.push(parsedEntry as JobTranscriptEntry);
      }
      transcript = parsedTranscript;
   }

   const resultData = record.resultData === undefined ? undefined : parsePersistedJsonValue(record.resultData);
   if (record.resultData !== undefined && resultData === undefined) return undefined;

   return {
      id: record.id,
      ownerSessionId: record.ownerSessionId,
      name,
      kind: record.kind as JobKind,
      harness: (record.harness as HarnessName) ?? undefined,
      agent: parseOptionalString(record.agent),
      async: parseOptionalBoolean(record.async),
      model: parseOptionalString(record.model),
      thinking: parseOptionalString(record.thinking),
      cwd: parseOptionalString(record.cwd),
      origin: (record.origin as "standard" | "vibe" | "btw") ?? undefined,
      promptOrCommand: record.promptOrCommand,
      status: record.status as JobStatus,
      createdAt,
      startedAt,
      settledAt,
      pid,
      exitCode,
      signal: parseOptionalString(record.signal),
      resultData,
      errorText: parseOptionalString(record.errorText),
      rawText: parseOptionalString(record.rawText),
      transcript,
      waitInterest: 0,
      killInterest: 0,
      sessionFile: parseOptionalString(record.sessionFile),
      sessionId: parseOptionalString(record.sessionId)
   };
}

/**
 * Fail-closed parser for the persisted manifest index. Any structural mismatch,
 * invalid job, or duplicate job ID rejects the entire manifest so load can
 * quarantine it instead of silently recovering a partial/empty index.
 */
export function parsePersistedIndex(record: Record<string, unknown>): HarborJobIndex | undefined {
   if (!isRecord(record)) return undefined;
   const indexKeys = new Set(["version", "parentSessionFile", "writtenAt", "reservedTaskSeq", "summary", "jobs"]);
   if (!hasOnlyKeys(record, indexKeys)) return undefined;
   if (Object.keys(record).some((key) => !isPersistedString(key))) return undefined;
   if (typeof record.version !== "number" || !Number.isFinite(record.version)) return undefined;
   // Version 1 is the only supported boundary. Do not guess at forward migrations.
   if (record.version !== HARBOR_JOB_MANIFEST_VERSION) return undefined;

   if (record.parentSessionFile !== undefined && !isPersistedString(record.parentSessionFile)) return undefined;
   if (record.writtenAt !== undefined && parseFiniteNumber(record.writtenAt) === undefined) return undefined;
   if (record.reservedTaskSeq !== undefined) {
      const reservedTaskSeq = parseFiniteNumber(record.reservedTaskSeq);
      if (reservedTaskSeq === undefined || reservedTaskSeq < 0 || !Number.isInteger(reservedTaskSeq)) return undefined;
   }

   if (!Array.isArray(record.jobs) || record.jobs.length > HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength)
      return undefined;

   const summary = record.summary === undefined ? undefined : parseManifestSummary(record.summary);
   if (record.summary !== undefined && summary === undefined) return undefined;

   const jobs: Job[] = [];
   const seenIds = new Set<string>();
   for (const raw of record.jobs) {
      const parsed = parsePersistedJobEntry(raw);
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
      reservedTaskSeq: record.reservedTaskSeq as number | undefined,
      summary,
      jobs
   };
}
