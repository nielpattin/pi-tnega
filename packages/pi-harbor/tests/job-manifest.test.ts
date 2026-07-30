import { describe, it, expect, beforeEach } from "vitest";
import {
   buildPersistedIndex,
   computeReservedTaskSeq,
   HARBOR_JOB_MANIFEST_LIMITS,
   normalizePersistedJob,
   parsePersistedIndex,
   resetManifestLimits,
   type JsonValue
} from "../src/services/HarborJobManifest.js";
import type { Job, JobTranscriptEntry } from "../src/domain.js";

function buildJob(overrides: Partial<Job> & Pick<Job, "id" | "status">): Job {
   return {
      ownerSessionId: "parent",
      name: overrides.name ?? overrides.id,
      kind: "agent",
      agent: "task",
      async: false,
      model: undefined,
      thinking: undefined,
      cwd: process.cwd(),
      origin: "standard",
      promptOrCommand: "test prompt",
      createdAt: Date.now(),
      waitInterest: 0,
      killInterest: 0,
      sessionFile: undefined,
      sessionId: undefined,
      ...overrides
   } as Job;
}

describe("HarborJobManifest normalization", () => {
   beforeEach(() => {
      resetManifestLimits();
   });

   it("round-trips a normal structured resultData unchanged", () => {
      const result = {
         ok: true,
         data: {
            items: [
               { id: 1, name: "alpha" },
               { id: 2, name: "beta" }
            ]
         }
      };
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: result
      });

      const normalized = normalizePersistedJob(job);

      expect(normalized.truncated).toBe(false);
      expect(normalized.job.resultData).toEqual(result);
   });

   it("normalizes cyclic resultData without throwing", () => {
      const cyclic: Record<string, unknown> = { value: 1 };
      cyclic.self = cyclic;

      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: cyclic
      });

      expect(() => normalizePersistedJob(job)).not.toThrow();
      const normalized = normalizePersistedJob(job);
      expect(JSON.stringify(normalized.job)).toContain("__truncated");
      expect(JSON.stringify(normalized.job)).toContain("circular reference removed");
   });

   it("normalizes BigInt resultData", () => {
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: { count: 12345678901234567890n }
      });

      const normalized = normalizePersistedJob(job);
      expect(JSON.stringify(normalized.job)).toBeDefined();
      expect(JSON.stringify(normalized.job)).toContain("BigInt removed");
   });

   it("normalizes a getter that throws", () => {
      const bad = {
         get boom() {
            throw new Error("cannot access boom");
         },
         safe: true
      };

      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: bad
      });

      const normalized = normalizePersistedJob(job);
      const data = normalized.job.resultData as Record<string, unknown>;
      expect(data.safe).toBe(true);
      expect(data.boom).toEqual({ __truncated: "getter threw: cannot access boom" });
   });

   it("normalizes unsupported values with explicit metadata", () => {
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: {
            fn: function unsupported() {},
            sym: Symbol("test"),
            nil: null
         }
      });

      const normalized = normalizePersistedJob(job);
      const data = normalized.job.resultData as Record<string, unknown>;
      expect(data.nil).toBeNull();
      expect(JSON.stringify(data.fn)).toContain("Function value removed");
      expect(JSON.stringify(data.sym)).toContain("Symbol value removed");
   });

   it("truncates huge strings and reports dropped characters", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 16;
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: { text: "a".repeat(100) }
      });

      const normalized = normalizePersistedJob(job);

      const data = normalized.job.resultData as { text: string };
      expect(data.text.length).toBeLessThan(100);
      expect(data.text).toContain("[truncated");
      expect(normalized.droppedStringChars).toBeGreaterThan(0);
   });

   it("keeps every persisted truncation suffix within the reader's Unicode bound", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 64;
      const input = "😀é界".repeat(200);
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: { text: input },
         rawText: input,
         errorText: input
      });

      const normalized = normalizePersistedJob(job);
      const resultText = (normalized.job.resultData as { text: string }).text;
      expect(resultText.length).toBeLessThanOrEqual(HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars);
      expect(Buffer.byteLength(resultText, "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars
      );
      expect(resultText).toContain("truncated");
      const dropped = /\[truncated (\d+) characters\]/.exec(resultText);
      expect(dropped).not.toBeNull();
      expect(normalized.droppedStringChars).toBeGreaterThanOrEqual(Number(dropped?.[1]));
      expect(normalized.job.rawText!.length).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars
      );
      expect(Buffer.byteLength(normalized.job.rawText!, "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars
      );
      expect(parsePersistedIndex(JSON.parse(JSON.stringify(buildPersistedIndex([job]).index)))).toBeDefined();
   });

   it("keeps compact and recovery truncation sentinels parser-valid", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 64;
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes = 600;
      const job = buildJob({
         id: "task-1",
         status: "completed",
         promptOrCommand: "prompt ".repeat(2000),
         errorText: "error ".repeat(2000),
         resultData: { text: "result ".repeat(2000) },
         rawText: "raw ".repeat(2000),
         transcript: [{ type: "assistant", text: "transcript ".repeat(2000) }]
      });

      const { index } = buildPersistedIndex([job]);
      const text = JSON.stringify(index, undefined, 2);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes
      );
      expect(parsePersistedIndex(JSON.parse(text) as Record<string, unknown>)).toBeDefined();
      expect(text).toContain("truncated");
   });

   it("truncates huge arrays and reports omitted items", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength = 3;
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
      });

      const normalized = normalizePersistedJob(job);
      const data = normalized.job.resultData as { items: JsonValue[] };

      expect(data.items.length).toBe(4); // 3 kept + 1 marker
      expect(JSON.stringify(data.items)).toContain("7 array items omitted");
      expect(normalized.droppedArrayItems).toBe(7);
   });

   it("truncates deeply nested values at the configured depth", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth = 3;
      const deep: Record<string, unknown> = { level: 1 };
      let current: Record<string, unknown> = deep;
      for (let i = 2; i <= 10; i++) {
         const next: Record<string, unknown> = { level: i };
         current.child = next;
         current = next;
      }

      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: deep
      });

      const normalized = normalizePersistedJob(job);
      expect(JSON.stringify(normalized.job)).toContain("max nesting depth exceeded");
   });

   it("keeps child sessionFile and sessionId references intact", () => {
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: { ok: true },
         sessionFile: "/tmp/parent/session/task-1.jsonl",
         sessionId: "child-session-uuid"
      });

      const normalized = normalizePersistedJob(job);

      expect(normalized.job.sessionFile).toBe("/tmp/parent/session/task-1.jsonl");
      expect(normalized.job.sessionId).toBe("child-session-uuid");
   });

   it("summarizes rawText instead of persisting the full stream", () => {
      const rawText = "line\n".repeat(500); // 2500 chars
      const job = buildJob({
         id: "task-1",
         status: "completed",
         rawText
      });

      const normalized = normalizePersistedJob(job);

      expect(normalized.job.rawText).toBeDefined();
      expect(normalized.job.rawText!.length).toBeLessThan(rawText.length);
      expect(normalized.job.rawText!).toContain("earlier characters omitted");
      expect(normalized.job.rawText!.endsWith("line\n")).toBe(true);
   });

   it("persists only a bounded transcript preview", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedTranscriptEntries = 3;
      const transcript: JobTranscriptEntry[] = [];
      for (let i = 0; i < 10; i++) {
         transcript.push({ type: "assistant", text: `chunk ${i}`, timestamp: i });
      }

      const job = buildJob({
         id: "task-1",
         status: "completed",
         transcript
      });

      const normalized = normalizePersistedJob(job);

      expect(normalized.job.transcript).toHaveLength(3);
      expect((normalized.job.transcript![2] as { text: string }).text).toBe("chunk 9");
      expect(normalized.droppedTranscriptEntries).toBe(7);
   });

   it("truncates long transcript text inside preview entries", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 20;
      const transcript: JobTranscriptEntry[] = [
         { type: "assistant", text: "a".repeat(1000) }
      ];

      const job = buildJob({
         id: "task-1",
         status: "completed",
         transcript
      });

      const normalized = normalizePersistedJob(job);
      const entry = normalized.job.transcript![0] as { text: string };
      expect(entry.text.length).toBeLessThan(1000);
      expect(entry.text).toContain("[truncated");
   });

   it("replaces a single job that exceeds the per-job byte limit", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes = 80;
      const job = buildJob({
         id: "task-1",
         status: "completed",
         resultData: { text: "a".repeat(10_000) }
      });

      const normalized = normalizePersistedJob(job);

      expect(JSON.stringify(normalized.job.resultData)).toContain("per-job byte limit exceeded");
   });

   it("drops oldest terminal jobs to keep the manifest under the total byte ceiling", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes = 2000;
      const jobs: Job[] = [];
      for (let i = 1; i <= 20; i++) {
         jobs.push(
            buildJob({
               id: `task-${i}`,
               status: "completed",
               settledAt: i * 1000,
               resultData: { summary: `job number ${i}` }
            })
         );
      }

      const { index, summary } = buildPersistedIndex(jobs, "/tmp/parent.jsonl");

      const size = JSON.stringify(index).length;
      expect(size).toBeLessThanOrEqual(HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes);
      expect(summary.droppedJobs).toBeGreaterThan(0);
      expect(index.jobs.some((job) => job.id === "task-1")).toBe(false);
   });

   it("keeps protected and running Unicode-heavy jobs within the UTF-8 manifest ceiling", () => {
      const jobs: Job[] = [];
      const unicode = "😀é界".repeat(4_000);
      for (let i = 1; i <= 64; i++) {
         const terminal = i % 2 === 0;
         jobs.push(
            buildJob({
               id: `task-${i}`,
               status: terminal ? "completed" : "running",
               createdAt: i,
               startedAt: terminal ? i + 1 : i + 1,
               settledAt: terminal ? i + 2 : undefined,
               waitInterest: terminal ? 1 : 0,
               killInterest: terminal ? 1 : 0,
               promptOrCommand: unicode,
               rawText: unicode,
               errorText: unicode,
               resultData: { output: unicode },
               transcript: [{ type: "assistant", text: unicode }]
            })
         );
      }

      const first = buildPersistedIndex(jobs, "/tmp/parent.jsonl");
      const second = buildPersistedIndex(jobs, "/tmp/parent.jsonl");
      const firstText = JSON.stringify(first.index, undefined, 2);
      const secondText = JSON.stringify(second.index, undefined, 2);

      expect(Buffer.byteLength(firstText, "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes
      );
      expect(firstText).toBe(secondText);
      expect(first.index.jobs).toHaveLength(64);
      expect(first.index.reservedTaskSeq).toBe(64);
      expect(first.summary.truncatedJobs).toBeGreaterThan(0);
      expect(first.summary.droppedJobs).toBe(0);
      expect(JSON.stringify(first.index)).toContain("__truncated");

      const recovered = parsePersistedIndex(JSON.parse(firstText) as Record<string, unknown>);
      expect(recovered?.jobs).toHaveLength(64);
      expect(recovered?.reservedTaskSeq).toBe(64);
      expect(first.index.jobs.every((job) => job.rawText === undefined && job.transcript === undefined)).toBe(true);
   });

   it("uses a valid deterministic drop fallback with explicit accounting", () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes = 4096;
      const jobs: Job[] = [];
      for (let i = 1; i <= 64; i++) {
         jobs.push(
            buildJob({
               id: `task-${i}`,
               status: i % 2 === 0 ? "completed" : "running",
               createdAt: i,
               settledAt: i,
               waitInterest: i % 2 === 0 ? 1 : 0,
               killInterest: i % 2 === 0 ? 1 : 0,
               promptOrCommand: "界😀".repeat(4_000),
               resultData: { output: "界😀".repeat(4_000) }
            })
         );
      }

      const { index, summary } = buildPersistedIndex(jobs, "/tmp/parent.jsonl");
      const text = JSON.stringify(index, undefined, 2);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes
      );
      expect(summary.droppedJobs).toBe(jobs.length - index.jobs.length);
      expect(summary.droppedJobs).toBeGreaterThan(0);
      expect(index.reservedTaskSeq).toBe(64);
      expect(parsePersistedIndex(JSON.parse(text) as Record<string, unknown>)).toBeDefined();
      expect(JSON.stringify(index)).toContain("__truncated");
   });

   it("preserves reservedTaskSeq independently of pruned jobs", () => {
      const jobs: Job[] = [
         buildJob({ id: "task-5", status: "completed", settledAt: 1000 }),
         buildJob({ id: "task-3", status: "completed", settledAt: 2000 }),
         buildJob({ id: "task-1", status: "completed", settledAt: 3000 })
      ];

      const { index } = buildPersistedIndex(jobs);
      expect(index.reservedTaskSeq).toBe(5);
      expect(computeReservedTaskSeq(jobs)).toBe(5);
   });

   it("parses a persisted index without losing normalization metadata", () => {
      const { index } = buildPersistedIndex(
         [buildJob({ id: "task-1", status: "completed", resultData: { ok: true } })],
         "/tmp/parent.jsonl"
      );
      const text = JSON.stringify(index);
      const parsed = parsePersistedIndex(JSON.parse(text) as Record<string, unknown>);

      expect(parsed).toBeDefined();
      expect(parsed!.jobs[0]!.id).toBe("task-1");
      expect(parsed!.reservedTaskSeq).toBe(1);
      expect(parsed!.summary).toBeDefined();
   });

   it("requires the complete finite summary and truncation metadata shape", () => {
      const base = buildJob({ id: "task-1", status: "completed", resultData: { ok: true } });
      const summary = {
         totalJobs: 1,
         truncatedJobs: 0,
         droppedStringChars: 0,
         droppedArrayItems: 0,
         droppedTranscriptEntries: 0,
         droppedJobs: 0
      };

      expect(parsePersistedIndex({ version: 1, jobs: [base], summary } as Record<string, unknown>)).toBeDefined();
      expect(parsePersistedIndex({ version: 1, jobs: [base], summary: { ...summary, droppedJobs: Infinity } } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [base], summary: { ...summary, droppedJobs: "0" } } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [base], summary: { ...summary, extra: 0 } } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [base], summary: { totalJobs: 1 } } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, resultData: { __truncated: 1 } }] } as Record<string, unknown>)).toBeUndefined();
   });

   it("rejects a top-level jobs field that is not an array", () => {
      const parsed = parsePersistedIndex({
         version: 1,
         parentSessionFile: "/tmp/parent.jsonl",
         jobs: { task: "not an array" }
      } as Record<string, unknown>);
      expect(parsed).toBeUndefined();
   });

   it("parses every persisted transcript entry and content variant", () => {
      const base = buildJob({ id: "task-1", status: "completed" });
      const transcript = [
         { type: "user", text: "prompt", timestamp: 1 },
         { type: "thinking", text: "reasoning", timestamp: 2 },
         { type: "assistant", text: "answer", timestamp: 3 },
         {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read",
            arguments: { path: "README.md" },
            timestamp: 4
         },
         {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            content: [
               { type: "text", text: "contents" },
               { type: "image", mimeType: "image/png" }
            ],
            isError: false,
            timestamp: 5
         }
      ];

      const parsed = parsePersistedIndex({ version: 1, jobs: [{ ...base, transcript }] } as Record<string, unknown>);

      expect(parsed?.jobs[0]?.transcript).toEqual(transcript);
   });

   it("rejects an unknown persisted transcript entry type", () => {
      const base = buildJob({ id: "task-1", status: "completed" });
      const parsed = parsePersistedIndex({
         version: 1,
         jobs: [{ ...base, transcript: [{ type: "notice", text: "unexpected" }] }]
      } as Record<string, unknown>);
      expect(parsed).toBeUndefined();
   });

   it.each([
      ["missing text", { type: "assistant" }],
      ["invalid timestamp", { type: "assistant", text: "x", timestamp: Infinity }],
      ["wrong content block", {
         type: "tool-result",
         toolCallId: "call-1",
         toolName: "read",
         content: [{ type: "audio", text: "x" }],
         isError: false
      }],
      ["invalid raw shape", {
         type: "tool-call",
         toolCallId: "call-1",
         toolName: "read",
         arguments: {},
         raw: "not an object"
      }]
   ])("rejects a transcript entry with %s", (_name, entry) => {
      const base = buildJob({ id: "task-1", status: "completed" });
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, transcript: [entry] }] } as Record<string, unknown>)).toBeUndefined();
   });

   it("rejects a malformed job entry even when other entries are valid", () => {
      const parsed = parsePersistedIndex({
         version: 1,
         jobs: [
            buildJob({ id: "task-1", status: "completed" }),
            { id: "task-2", status: "invalid-status", ownerSessionId: "parent", promptOrCommand: "x" }
         ]
      } as Record<string, unknown>);
      expect(parsed).toBeUndefined();
   });

   it("rejects non-finite numbers and invalid optional types", () => {
      const base = buildJob({ id: "task-1", status: "completed" });
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, createdAt: NaN }] } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, createdAt: Infinity }] } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, startedAt: NaN }] } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, pid: -Infinity }] } as Record<string, unknown>)).toBeUndefined();
      expect(
         parsePersistedIndex({ version: 1, writtenAt: NaN, jobs: [base] } as Record<string, unknown>)
      ).toBeUndefined();
      expect(
         parsePersistedIndex({ version: 1, reservedTaskSeq: Infinity, jobs: [base] } as Record<string, unknown>)
      ).toBeUndefined();
      expect(
         parsePersistedIndex({
            version: 1,
            jobs: [
               {
                  ...base,
                  transcript: [
                     {
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "read",
                        arguments: { count: NaN }
                     }
                  ]
               }
            ]
         } as Record<string, unknown>)
      ).toBeUndefined();
   });

   it("rejects duplicate job IDs", () => {
      const parsed = parsePersistedIndex({
         version: 1,
         jobs: [
            buildJob({ id: "task-1", status: "completed" }),
            buildJob({ id: "task-1", status: "failed" })
         ]
      } as Record<string, unknown>);
      expect(parsed).toBeUndefined();
   });

   it("rejects invalid harness and origin values", () => {
      const base = buildJob({ id: "task-1", status: "completed" });
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, harness: "unknown" }] } as Record<string, unknown>)).toBeUndefined();
      expect(parsePersistedIndex({ version: 1, jobs: [{ ...base, origin: "bad" }] } as Record<string, unknown>)).toBeUndefined();
   });

   it("rejects unsupported top-level field types and forward manifest versions", () => {
      expect(
         parsePersistedIndex({ version: 1, parentSessionFile: 123, jobs: [] } as Record<string, unknown>)
      ).toBeUndefined();
      expect(
         parsePersistedIndex({ version: "1", jobs: [] } as Record<string, unknown>)
      ).toBeUndefined();
      expect(
         parsePersistedIndex({ version: 2, jobs: [] } as Record<string, unknown>)
      ).toBeUndefined();
   });

   it("enforces per-job and total byte limits using UTF-8 byte length", () => {
      // Choose a per-job limit that fits the structural fields but is exceeded
      // once a large multi-byte resultData is added.
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes = 512;
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes = 1024;

      // Four-byte emojis: 100 characters => 400 bytes for the string alone, so
      // the whole job will exceed the 512-byte per-job limit.
      const huge = "😀".repeat(100);
      const bigJob = buildJob({ id: "task-1", status: "completed", resultData: { huge } });
      const normalized = normalizePersistedJob(bigJob);
      expect(Buffer.byteLength(JSON.stringify(normalized.job), "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedJobBytes
      );
      expect(normalized.truncated).toBe(true);

      // Build a manifest whose character length is below the total limit but
      // whose UTF-8 byte length exceeds it.
      const multibyte = "é".repeat(800); // 800 chars but 1600 bytes
      const multibyteJob = buildJob({ id: "task-1", status: "completed", settledAt: 1, resultData: { multibyte } });
      const { index } = buildPersistedIndex(
         [multibyteJob, buildJob({ id: "task-2", status: "completed", settledAt: 2 })],
         "/tmp/parent.jsonl"
      );
      expect(Buffer.byteLength(JSON.stringify(index), "utf8")).toBeLessThanOrEqual(
         HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes
      );
   });

});
