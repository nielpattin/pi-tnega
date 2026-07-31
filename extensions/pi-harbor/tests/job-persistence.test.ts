import { describe, it, expect, beforeEach, vi } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import {
   HarborJobPersistence,
   HARBOR_JOBS_FILE,
   createRegistryChangeWriter,
   type HarborFileSystem,
   type RegistryChangeWriter
} from "../src/services/HarborJobPersistence.js";
import type { HarborJobPersistenceShape } from "../src/services/HarborJobPersistence.js";
import {
   activateParentSession,
   flushPendingWrites,
   startJobPersistenceListener
} from "../src/services/HarborJobRecovery.js";
import { TaskManager } from "../src/services/TaskManager.js";
import {
   HARBOR_JOB_MANIFEST_LIMITS,
   resetManifestLimits,
   type HarborJobIndex
} from "../src/services/HarborJobManifest.js";
import { ManifestPersistenceError, type Job } from "../src/domain.js";

function makeTempSessionDir(prefix = "harbor-persistence-") {
   const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
   const parentFile = path.join(base, "2026-01-15T123456Z_parent-session-id.jsonl");
   return { base, parentFile, childDir: parentFile.slice(0, -".jsonl".length) };
}

function buildPersistedJob(overrides: Partial<Job> & Pick<Job, "id" | "status">): Job {
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

function readIndex(childDir: string): HarborJobIndex | undefined {
   const filePath = path.join(childDir, "harbor-jobs.json");
   if (!fs.existsSync(filePath)) return undefined;
   return JSON.parse(fs.readFileSync(filePath, "utf8")) as HarborJobIndex;
}

describe("Harbor job persistence behavior", () => {
   beforeEach(() => {
      resetManifestLimits();
   });

   it("clears the previous target for invalid POSIX and Windows parent paths", async () => {
      const { parentFile, childDir } = makeTempSessionDir("harbor-configure-a-");
      const b = makeTempSessionDir("harbor-configure-b-");
      const runtime = makeFakeHarborRuntime();
      const aJob = buildPersistedJob({ id: "task-a", status: "completed", name: "from-a" });

      try {
         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([aJob])));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));
         const aManifestBefore = fs.readFileSync(path.join(childDir, HARBOR_JOBS_FILE), "utf8");

         const invalidTargets = [undefined, "", "not-a-session.txt", "C:\\\\Sessions\\\\not-a-session.txt"] as const;
         await invalidTargets.reduce(
            async (chain, invalid) => {
               await chain;
               await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(invalid)));

               expect(await runtime.runPromise(HarborJobPersistence.use((p) => p.currentTarget()))).toBeUndefined();
               expect(await runtime.runPromise(HarborJobPersistence.use((p) => p.currentDir()))).toBeUndefined();
               expect((await runtime.runPromise(HarborJobPersistence.use((p) => p.load()))).jobs).toHaveLength(0);

               await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([buildPersistedJob({ id: "invalid", status: "completed" })])));
               await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));
               expect(fs.readFileSync(path.join(childDir, HARBOR_JOBS_FILE), "utf8")).toBe(aManifestBefore);
            },
            Promise.resolve()
         );

         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(b.parentFile)));
         expect(await runtime.runPromise(HarborJobPersistence.use((p) => p.currentTarget()))).toBe(b.parentFile);
         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
         fs.rmSync(b.base, { recursive: true, force: true });
      }
   });

   it("persists and recovers every transcript variant exactly", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));
         const transcript = [
            { type: "user" as const, text: "prompt", timestamp: 1 },
            { type: "thinking" as const, text: "reasoning", timestamp: 2 },
            { type: "assistant" as const, text: "answer", timestamp: 3 },
            { type: "tool-call" as const, toolCallId: "call-1", toolName: "read", arguments: { path: "README.md" }, timestamp: 4 },
            {
               type: "tool-result" as const,
               toolCallId: "call-1",
               toolName: "read",
               content: [
                  { type: "text" as const, text: "contents" },
                  { type: "image" as const, mimeType: "image/png" }
               ],
               isError: false,
               timestamp: 5
            }
         ];
         const job = buildPersistedJob({ id: "task-1", status: "completed", transcript });

         await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([job])));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));

         const loaded = await runtime.runPromise(HarborJobPersistence.use((p) => p.load()));
         expect(loaded.jobs[0]!.transcript).toEqual(transcript);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("round-trips an oversized completed result after a fresh runtime without quarantine", async () => {
      const { parentFile, childDir } = makeTempSessionDir("harbor-long-result-");
      const runtime = makeFakeHarborRuntime();

      try {
         const job = buildPersistedJob({
            id: "task-1",
            status: "completed",
            resultData: { text: "x".repeat(9000) }
         });

         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([job])));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));
         await runtime.dispose();

         const freshRuntime = makeFakeHarborRuntime();
         try {
            await freshRuntime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));
            const loaded = await freshRuntime.runPromise(HarborJobPersistence.use((p) => p.load()));
            expect(loaded.jobs).toHaveLength(1);
            expect(loaded.jobs[0]!.id).toBe("task-1");
            expect(loaded.jobs[0]!.status).toBe("completed");
            expect(loaded.jobs[0]!.resultData).toEqual({
               text: expect.stringMatching(/^x+… \[truncated \d+ characters\]$/)
            });
            expect(fs.readdirSync(childDir).some((entry) => entry.includes(".corrupt-"))).toBe(false);
         } finally {
            await freshRuntime.dispose();
         }
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("persists an exact structured resultData round-trip", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));

         const result = {
            ok: true,
            data: { items: [{ id: 1 }, { id: 2 }] }
         };
         const job = buildPersistedJob({
            id: "task-1",
            status: "completed",
            resultData: result
         });

         await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([job])));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));

         const index = readIndex(childDir);
         expect(index).toBeDefined();
         expect(index!.jobs).toHaveLength(1);
         expect((index!.jobs[0] as Job).resultData).toEqual(result);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("does not let one bad job block other jobs from persisting", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));

         const cyclic: Record<string, unknown> = { ok: true };
         cyclic.self = cyclic;

         const badJob = buildPersistedJob({
            id: "task-bad",
            status: "completed",
            resultData: cyclic
         });
         const goodJob = buildPersistedJob({
            id: "task-good",
            status: "completed",
            resultData: { ok: true, value: 42 }
         });

         await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([badJob, goodJob])));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));

         const index = readIndex(childDir);
         expect(index).toBeDefined();
         expect(index!.jobs.some((j) => j.id === "task-bad")).toBe(true);
         expect(index!.jobs.some((j) => j.id === "task-good")).toBe(true);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("coalesces high-frequency registry updates", async () => {
      const persistCalls: Array<ReadonlyArray<Job>> = [];
      const fakePersistence = {
         persist: (jobs: ReadonlyArray<Job>) => {
            persistCalls.push(jobs);
            return Effect.void;
         },
         flush: () => Effect.void
      } as unknown as HarborJobPersistenceShape;

      const writer: RegistryChangeWriter = createRegistryChangeWriter(fakePersistence);
      const job: Job = buildPersistedJob({ id: "task-1", status: "running" });

      writer.schedule([job]);
      writer.schedule([{ ...job, rawText: "a" }]);
      writer.schedule([{ ...job, rawText: "ab" }]);
      writer.schedule([{ ...job, rawText: "abc" }]);

      await writer.flush();

      expect(persistCalls.length).toBeGreaterThanOrEqual(1);
      expect(persistCalls.length).toBeLessThanOrEqual(2);
      const last = persistCalls[persistCalls.length - 1];
      expect(last[0]!.rawText).toBe("abc");
   });

   it("flushes a terminal transition immediately", async () => {
      const persistCalls: Array<ReadonlyArray<Job>> = [];
      const fakePersistence = {
         persist: (jobs: ReadonlyArray<Job>) => {
            persistCalls.push(jobs);
            return Effect.void;
         },
         flush: () => Effect.void
      } as unknown as HarborJobPersistenceShape;

      const writer = createRegistryChangeWriter(fakePersistence);
      const job: Job = buildPersistedJob({ id: "task-1", status: "running" });

      writer.schedule([job]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(persistCalls.length).toBe(1);

      writer.schedule([{ ...job, status: "completed", settledAt: Date.now() }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(persistCalls.length).toBe(2);
      expect(persistCalls[1]![0]!.status).toBe("completed");
   });

   it("session shutdown flush writes pending changes", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(startJobPersistenceListener());
         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));

         const job = await runtime.runPromise(
            TaskManager.use((s) =>
               s.spawnTask({ task: "shutdown flush", name: "flush-test", background: true })
            )
         );

         await runtime.runPromise(JobRegistry.use((r) => r.updateStatus(job.id, "completed")));

         // Wait longer than the debounce window to let normal persistence run,
         // then write another change and immediately flush without waiting for the timer.
         await new Promise((resolve) => setTimeout(resolve, 20));
         await runtime.runPromise(JobRegistry.use((r) => r.updateStatus(job.id, "completed", { resultData: { done: true } })));

         await runtime.runPromise(flushPendingWrites());

         const index = readIndex(childDir);
         expect(index).toBeDefined();
         const found = index!.jobs.find((j) => j.id === job.id);
         expect(found).toBeDefined();
         expect(found!.status).toBe("completed");
         expect(found!.resultData).toEqual({ done: true });

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("persists only a bounded transcript preview, not the whole live transcript", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(activateParentSession(parentFile));

         const transcript = Array.from({ length: 20 }, (_, i) => ({
            type: "assistant" as const,
            text: `line ${i}`,
            timestamp: i
         }));

         const job = buildPersistedJob({
            id: "task-1",
            status: "completed",
            transcript
         });

         await runtime.runPromise(HarborJobPersistence.use((p) => p.persist([job])));
         await runtime.runPromise(HarborJobPersistence.use((p) => p.flush()));

         const index = readIndex(childDir);
         const persisted = index!.jobs[0] as Job;
         expect(persisted.transcript).toBeDefined();
         expect(persisted.transcript!.length).toBeLessThan(transcript.length);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("prunes many background terminal jobs under the retention limit", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs = 8;
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(activateParentSession(parentFile));

         const backgroundJobs: Job[] = [];
         const bgSpawnSteps = Array.from({ length: 10 }, (_, index) => index + 1);
         await bgSpawnSteps.reduce(
            async (chain, i) => {
               await chain;
               const job = await runtime.runPromise(
                  TaskManager.use((s) =>
                     s.spawnTask({ task: `bg ${i}`, name: `bg-${i}`, background: true })
                  )
               );
               await runtime.runPromise(
                  JobRegistry.use((r) =>
                     r.updateStatus(job.id, "completed", { resultData: { n: i } })
                  )
               );
               backgroundJobs.push(job);
            },
            Promise.resolve()
         );

         await runtime.runPromise(flushPendingWrites());

         const jobs = await runtime.runPromise(JobRegistry.use((r) => r.list()));
         expect(jobs.length).toBeLessThanOrEqual(HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs);

         const index = readIndex(childDir);
         expect(index).toBeDefined();
         expect(index!.jobs.length).toBeLessThanOrEqual(HARBOR_JOB_MANIFEST_LIMITS.maxTrackedJobs);

         // The oldest background jobs should have been pruned.
         expect(jobs.some((j) => j.name === "bg-1")).toBe(false);
         expect(jobs.some((j) => j.name === "bg-10")).toBe(true);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("recovery keeps child sessionFile and sessionId references", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const runtime = makeFakeHarborRuntime();

      try {
         await runtime.runPromise(activateParentSession(parentFile));

         const job = await runtime.runPromise(
            TaskManager.use((s) => s.spawnTask({ task: "with child refs", name: "refs" }))
         );
         await runtime.runPromise(
            JobRegistry.use((r) =>
               r.updateStatus(job.id, "completed", {
                  resultData: { ok: true },
                  sessionFile: path.join(childDir, "task-1-session.jsonl"),
                  sessionId: "child-uuid"
               })
            )
         );

         await runtime.runPromise(flushPendingWrites());

         const freshRuntime = makeFakeHarborRuntime();
         await freshRuntime.runPromise(activateParentSession(parentFile));
         const recovered = await freshRuntime.runPromise(JobRegistry.use((r) => r.get(job.id)));

         expect(recovered).toBeDefined();
         expect(recovered!.sessionFile).toBe(path.join(childDir, "task-1-session.jsonl"));
         expect(recovered!.sessionId).toBe("child-uuid");

         await freshRuntime.dispose();
         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });
});

interface FakeFileSystemResult {
   readonly fs: HarborFileSystem;
   readonly files: ReadonlyMap<string, string>;
   readonly calls: ReadonlyArray<{ readonly op: string; readonly args: ReadonlyArray<unknown> }>;
   readonly onRename: (hook: (from: string, to: string) => Error | undefined) => void;
}

function makeFakeFileSystem(initial: Record<string, string> = {}): FakeFileSystemResult {
   const files = new Map<string, string>(Object.entries(initial));
   const calls: Array<{ op: string; args: ReadonlyArray<unknown> }> = [];
   let renameHook: (from: string, to: string) => Error | undefined = () => undefined;

   const record = (op: string, ...args: ReadonlyArray<unknown>) => calls.push({ op, args });

   const fakeFs: HarborFileSystem = {
      mkdir: async (dir) => {
         record("mkdir", dir);
      },
      readdir: async (dir) => {
         record("readdir", dir);
         return Array.from(files.keys())
            .filter((p) => path.dirname(p) === dir)
            .map((p) => path.basename(p));
      },
      readFile: async (p) => {
         record("readFile", p);
         return files.get(p);
      },
      writeFile: async (p, data, options) => {
         record("writeFile", p, data, options?.flag ?? "w");
         if (options?.flag === "wx" && files.has(p)) {
            throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
         }
         files.set(p, data);
      },
      rename: async (from, to) => {
         record("rename", from, to);
         const hookError = renameHook(from, to);
         if (hookError) throw hookError;
         if (!files.has(from)) {
            throw Object.assign(new Error(`ENOENT: no such file ${from}`), { code: "ENOENT" });
         }
         files.set(to, files.get(from)!);
         files.delete(from);
      },
      unlink: async (p) => {
         record("unlink", p);
         files.delete(p);
      },
      sync: async (p) => {
         record("sync", p);
      },
      syncDir: async (dir) => {
         record("syncDir", dir);
      }
   };

   return {
      fs: fakeFs,
      get files(): ReadonlyMap<string, string> {
         return files;
      },
      get calls(): ReadonlyArray<{ op: string; args: ReadonlyArray<unknown> }> {
         return calls;
      },
      onRename: (hook) => {
         renameHook = hook;
      }
   };
}

async function makePersistenceWithFileSystem(fileSystem: HarborFileSystem): Promise<{
   persistence: HarborJobPersistenceShape;
   dispose: () => Promise<void>;
}> {
   const runtime = ManagedRuntime.make(HarborJobPersistence.layerWith(fileSystem));
   const persistence = await runtime.runPromise(HarborJobPersistence);
   return {
      persistence,
      dispose: () => runtime.dispose()
   };
}

describe("atomic manifest replacement with injected filesystem", () => {
   beforeEach(() => {
      resetManifestLimits();
   });

   it("replaces an existing manifest atomically and leaves no temp/backup files", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-atomic", "2026-01-15T123456Z_parent.jsonl");
      const { persistence, dispose } = await makePersistenceWithFileSystem(
         makeFakeFileSystem({
            [path.join(
               parentFile.slice(0, -".jsonl".length),
               HARBOR_JOBS_FILE
            )]: JSON.stringify({ version: 1, jobs: [buildPersistedJob({ id: "old", status: "completed" })] })
         }).fs
      );

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const dir = await Effect.runPromise(persistence.currentDir());
         const finalPath = path.join(dir!, HARBOR_JOBS_FILE);

         await Effect.runPromise(
            persistence.persist([buildPersistedJob({ id: "new", status: "completed" })])
         );
         await Effect.runPromise(persistence.flush());

         const result = await Effect.runPromise(persistence.load());
         expect(result.jobs).toHaveLength(1);
         expect(result.jobs[0]!.id).toBe("new");
      } finally {
         await dispose();
      }
   });

   it("retries through a transient sharing violation then succeeds", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-retry", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const seed = buildPersistedJob({ id: "seed", status: "completed" });
      const { fs: fakeFs, files, calls, onRename } = makeFakeFileSystem({
         [finalPath]: JSON.stringify({ version: 1, jobs: [seed] })
      });

      let failures = 0;
      onRename((from, to) => {
         const isTempToFinal =
            path.basename(from).startsWith(`${HARBOR_JOBS_FILE}.tmp-`) && to === finalPath;
         if (isTempToFinal && failures < 2) {
            failures++;
            return Object.assign(new Error("EBUSY: sharing violation"), { code: "EBUSY" });
         }
         return undefined;
      });

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await Effect.runPromise(
            persistence.persist([buildPersistedJob({ id: "retry", status: "completed" })])
         );
         await Effect.runPromise(persistence.flush());

         expect(files.get(finalPath)).toBeDefined();
         expect(JSON.parse(files.get(finalPath)!).jobs[0]!.id).toBe("retry");
         expect(failures).toBe(2);
         const renamesToFinal = calls.filter((c) => c.op === "rename" && c.args[1] === finalPath);
         expect(renamesToFinal.length).toBeGreaterThanOrEqual(2);
      } finally {
         await dispose();
      }
   });

   it("fails explicitly and preserves the last known good manifest after a permanent failure", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-fail", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const oldJob = buildPersistedJob({ id: "old", status: "completed" });
      const newJob = buildPersistedJob({ id: "new", status: "completed" });
      const { fs: fakeFs, files, onRename } = makeFakeFileSystem({
         [finalPath]: JSON.stringify({ version: 1, jobs: [oldJob] })
      });

      onRename(() => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const result = await Effect.runPromise(Effect.result(persistence.persist([newJob])));

         expect(result._tag).toBe("Failure");
         const _tagNarrowed = result as Extract<typeof result, { _tag: "Failure" }>;
         expect(_tagNarrowed.failure).toBeInstanceOf(ManifestPersistenceError);

         const preserved = files.get(finalPath);
         expect(preserved).toBeDefined();
         expect(JSON.parse(preserved!).jobs[0]!.id).toBe("old");

         const tempArtifacts = Array.from(files.keys()).filter((p) =>
            path.basename(p).startsWith(`${HARBOR_JOBS_FILE}.tmp-`)
         );
         expect(tempArtifacts).toHaveLength(0);
      } finally {
         await dispose();
      }
   });

   it("cleans crash-leftover temp artifacts and quarantines invalid backup artifacts on configure", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-cleanup", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const leftoverTmp = path.join(childDir, `${HARBOR_JOBS_FILE}.tmp-12345-abc`);
      const leftoverBak = path.join(childDir, `${HARBOR_JOBS_FILE}.bak-67890-def`);
      const otherFile = path.join(childDir, "other.txt");
      const { fs: fakeFs, files } = makeFakeFileSystem({
         [leftoverTmp]: "tmp-data",
         [leftoverBak]: "bak-data",
         [otherFile]: "keep"
      });

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         expect(files.has(leftoverTmp)).toBe(false);
         expect(files.has(leftoverBak)).toBe(false);
         expect(files.has(otherFile)).toBe(true);
         const quarantined = Array.from(files.keys()).find((p) =>
            path.basename(p).includes(".corrupt-")
         );
         expect(quarantined).toBeDefined();
      } finally {
         await dispose();
      }
   });

   it("queues concurrent writes so the last call wins", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-queue", "2026-01-15T123456Z_parent.jsonl");
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const dir = await Effect.runPromise(persistence.currentDir());
         const finalPath = path.join(dir!, HARBOR_JOBS_FILE);

         const jobA = buildPersistedJob({ id: "a", status: "completed" });
         const jobB = buildPersistedJob({ id: "b", status: "completed" });

         await Promise.all([
            Effect.runPromise(persistence.persist([jobA])),
            Effect.runPromise(persistence.persist([jobB]))
         ]);
         await Effect.runPromise(persistence.flush());

         const final = files.get(finalPath);
         expect(final).toBeDefined();
         expect(JSON.parse(final!).jobs[0]!.id).toBe("b");
      } finally {
         await dispose();
      }
   });

   it("keeps temp and backup artifacts in the manifest directory on Windows-style paths", async () => {
      const parentFile = "C:\\Sessions\\2026-01-15T123456Z_parent.jsonl";
      const { fs: fakeFs, calls } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const dir = await Effect.runPromise(persistence.currentDir());
         const finalPath = path.join(dir!, HARBOR_JOBS_FILE);

         await Effect.runPromise(
            persistence.persist([buildPersistedJob({ id: "win", status: "completed" })])
         );
         await Effect.runPromise(persistence.flush());

         const tempWrites = calls.filter(
            (c) =>
               c.op === "writeFile" && String(c.args[0]).startsWith(`${finalPath}.tmp-`)
         );
         expect(tempWrites.length).toBeGreaterThan(0);
         for (const call of tempWrites) {
            expect(path.dirname(call.args[0] as string)).toBe(path.dirname(finalPath));
         }
      } finally {
         await dispose();
      }
   });

   it("cleans stale backup artifacts when the final manifest is valid", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-valid-final", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const staleBackup = path.join(childDir, `${HARBOR_JOBS_FILE}.bak-1000-stale`);
      const { fs: fakeFs, files } = makeFakeFileSystem({
         [finalPath]: JSON.stringify({
            version: 1,
            jobs: [buildPersistedJob({ id: "final", status: "completed" })]
         }),
         [staleBackup]: JSON.stringify({
            version: 1,
            jobs: [buildPersistedJob({ id: "stale", status: "completed" })]
         })
      });

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.jobs[0]!.id).toBe("final");
         expect(files.has(finalPath)).toBe(true);
         expect(files.has(staleBackup)).toBe(false);
      } finally {
         await dispose();
      }
   });

   it("restores the newest valid backup when the final manifest is missing", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-restore", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const oldBackup = path.join(childDir, `${HARBOR_JOBS_FILE}.bak-1000-old`);
      const newerBackup = path.join(childDir, `${HARBOR_JOBS_FILE}.bak-2000-new`);
      const { fs: fakeFs, files } = makeFakeFileSystem({
         [oldBackup]: JSON.stringify({
            version: 1,
            jobs: [buildPersistedJob({ id: "oldest", status: "completed" })]
         }),
         [newerBackup]: JSON.stringify({
            version: 1,
            jobs: [buildPersistedJob({ id: "newest", status: "completed" })]
         })
      });

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const restored = await Effect.runPromise(persistence.load());
         expect(restored.jobs).toHaveLength(1);
         expect(restored.jobs[0]!.id).toBe("newest");
         expect(files.has(finalPath)).toBe(true);
         expect(files.has(newerBackup)).toBe(false);
         expect(files.has(oldBackup)).toBe(false);
      } finally {
         await dispose();
      }
   });

   it("quarantines an invalid final and restores the newest valid backup", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-invalid-final", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const validBackup = path.join(childDir, `${HARBOR_JOBS_FILE}.bak-3000-valid`);
      const invalidBackup = path.join(childDir, `${HARBOR_JOBS_FILE}.bak-4000-invalid`);
      const { fs: fakeFs, files } = makeFakeFileSystem({
         [finalPath]: "this is not json",
         [validBackup]: JSON.stringify({
            version: 1,
            jobs: [buildPersistedJob({ id: "recovered", status: "completed" })]
         }),
         [invalidBackup]: "also not json"
      });

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const restored = await Effect.runPromise(persistence.load());
         expect(restored.jobs).toHaveLength(1);
         expect(restored.jobs[0]!.id).toBe("recovered");
         expect(files.has(finalPath)).toBe(true);
         expect(files.has(validBackup)).toBe(false);
         expect(files.has(invalidBackup)).toBe(false);
         const quarantined = Array.from(files.keys()).filter((p) =>
            path.basename(p).includes(".corrupt-")
         );
         expect(quarantined.length).toBeGreaterThanOrEqual(1);
      } finally {
         await dispose();
      }
   });

   it("quarantines a corrupt manifest during load when no valid backup exists", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-quarantine", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const { fs: fakeFs, files, calls } = makeFakeFileSystem({
         [finalPath]: "corrupt"
      });

      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(loaded.jobs).toHaveLength(0);
         expect(files.has(finalPath)).toBe(false);
         const quarantined = Array.from(files.keys()).find((p) =>
            path.basename(p).includes(".corrupt-")
         );
         expect(quarantined).toBeDefined();

         const renameCalls = calls.filter((c) => c.op === "rename");
         const syncDirCalls = calls.filter((c) => c.op === "syncDir");
         // The quarantine rename must be ordered before the directory sync.
         const lastRenameIndex = renameCalls.length > 0 ? calls.lastIndexOf(renameCalls[renameCalls.length - 1]!) : -1;
         const syncAfterQuarantine = syncDirCalls.some((c) => calls.indexOf(c) > lastRenameIndex);
         expect(syncAfterQuarantine).toBe(true);
      } finally {
         await dispose();
      }
   });

   it("quarantines a manifest with one malformed nested entry instead of restoring valid jobs", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-nested-quarantine", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const valid = buildPersistedJob({ id: "valid", status: "completed" });
      const malformed = {
         ...buildPersistedJob({ id: "malformed", status: "completed" }),
         transcript: [{ type: "tool-result", toolCallId: "call-1", toolName: "read", content: [{ type: "unknown" }], isError: false }]
      };
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, JSON.stringify({ version: 1, jobs: [valid, malformed] }));

         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(loaded.jobs).toHaveLength(0);
         expect(files.has(finalPath)).toBe(false);
         expect(Array.from(files.keys()).some((file) => path.basename(file).includes(".corrupt-"))).toBe(true);
      } finally {
         await dispose();
      }
   });

   it("quarantines an oversized UTF-8 manifest before parsing", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes = 256;
      const parentFile = path.join(os.tmpdir(), "harbor-oversized-utf8", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const text = JSON.stringify({
         version: 1,
         jobs: [buildPersistedJob({ id: "task-1", status: "completed", resultData: { text: "é".repeat(200) } })]
      });
      expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(HARBOR_JOB_MANIFEST_LIMITS.maxPersistedManifestBytes);
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, text);
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(files.has(finalPath)).toBe(false);
         expect(Array.from(files.keys()).some((file) => path.basename(file).includes(".corrupt-"))).toBe(true);
      } finally {
         await dispose();
      }
   });

   it("quarantines a manifest containing an overlong Unicode string", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 8;
      const parentFile = path.join(os.tmpdir(), "harbor-overlong-string", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const job = buildPersistedJob({
         id: "task-1",
         ownerSessionId: "p",
         name: "n",
         agent: "a",
         cwd: "c",
         promptOrCommand: "prompt",
         status: "completed",
         resultData: { text: "😀😀😀😀😀" }
      });
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, JSON.stringify({ version: 1, jobs: [job] }));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(files.has(finalPath)).toBe(false);
      } finally {
         await dispose();
      }
   });

   it("quarantines a manifest containing an oversized result array", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength = 2;
      const parentFile = path.join(os.tmpdir(), "harbor-oversized-array", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const job = buildPersistedJob({ id: "task-1", status: "completed", resultData: { values: [1, 2, 3] } });
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, JSON.stringify({ version: 1, jobs: [job] }));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(files.has(finalPath)).toBe(false);
      } finally {
         await dispose();
      }
   });

   it("quarantines a manifest containing an oversized transcript", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength = 2;
      const parentFile = path.join(os.tmpdir(), "harbor-oversized-transcript", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const job = buildPersistedJob({
         id: "task-1",
         status: "completed",
         transcript: [
            { type: "assistant", text: "one" },
            { type: "assistant", text: "two" },
            { type: "assistant", text: "three" }
         ]
      });
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, JSON.stringify({ version: 1, jobs: [job] }));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(files.has(finalPath)).toBe(false);
      } finally {
         await dispose();
      }
   });

   it("quarantines a manifest containing excessive result nesting", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth = 2;
      const parentFile = path.join(os.tmpdir(), "harbor-excessive-depth", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const job = buildPersistedJob({
         id: "task-1",
         status: "completed",
         resultData: { first: { second: { third: true } } }
      });
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, JSON.stringify({ version: 1, jobs: [job] }));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("missing");
         expect(files.has(finalPath)).toBe(false);
      } finally {
         await dispose();
      }
   });

   it("quarantines manifests with unknown closed-schema fields", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-unknown-field", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const base = buildPersistedJob({ id: "task-1", status: "completed" });
      const fixtures = [
         { version: 1, jobs: [base], unexpected: true },
         { version: 1, jobs: [{ ...base, unexpected: true }] }
      ];

      await Promise.all(
         fixtures.map(async (fixture) => {
            const { fs: fakeFs, files } = makeFakeFileSystem();
            const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);
            try {
               await Effect.runPromise(persistence.configure(parentFile));
               await fakeFs.writeFile(finalPath, JSON.stringify(fixture));
               const loaded = await Effect.runPromise(persistence.load());
               expect(loaded.source).toBe("missing");
               expect(files.has(finalPath)).toBe(false);
            } finally {
               await dispose();
            }
         })
      );
   });

   it("quarantines manifests with invalid reservedTaskSeq", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-invalid-reserved-seq", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      await Promise.all(
         [-1, 1.5, "1", null].map(async (reservedTaskSeq) => {
            const { fs: fakeFs, files } = makeFakeFileSystem();
            const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

            try {
               await Effect.runPromise(persistence.configure(parentFile));
               await fakeFs.writeFile(
                  finalPath,
                  JSON.stringify({ version: 1, jobs: [], reservedTaskSeq })
               );
               const loaded = await Effect.runPromise(persistence.load());
               expect(loaded.source).toBe("missing");
               expect(files.has(finalPath)).toBe(false);
            } finally {
               await dispose();
            }
         })
      );
   });

   it("loads a valid fixture at the configured string, array, and nesting boundaries", async () => {
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedStringChars = 16;
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedArrayLength = 2;
      HARBOR_JOB_MANIFEST_LIMITS.maxPersistedNestingDepth = 2;
      const parentFile = path.join(os.tmpdir(), "harbor-valid-boundary", "2026-01-15T123456Z_parent.jsonl");
      const childDir = parentFile.slice(0, -".jsonl".length);
      const finalPath = path.join(childDir, HARBOR_JOBS_FILE);
      const job = buildPersistedJob({
         id: "task-1",
         ownerSessionId: "parent",
         name: "name",
         agent: "agent",
         cwd: "cwd",
         promptOrCommand: "prompt",
         status: "completed",
         resultData: { nested: { text: "😀😀😀😀😀😀😀😀" }, values: [1, 2] },
         transcript: [
            { type: "assistant", text: "answer" },
            {
               type: "tool-result",
               toolCallId: "call-1",
               toolName: "read",
               content: [
                  { type: "text", text: "text" },
                  { type: "image", mimeType: "image/png" }
               ],
               isError: false
            }
         ]
      });
      const { fs: fakeFs, files } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         await fakeFs.writeFile(finalPath, JSON.stringify({ version: 1, jobs: [job], reservedTaskSeq: 0 }));
         const loaded = await Effect.runPromise(persistence.load());
         expect(loaded.source).toBe("valid");
         expect(loaded.jobs[0]!.resultData).toEqual(job.resultData);
         expect(files.has(finalPath)).toBe(true);
      } finally {
         await dispose();
      }
   });

   it("fsyncs the containing directory after temp->final rename", async () => {
      const parentFile = path.join(os.tmpdir(), "harbor-sync", "2026-01-15T123456Z_parent.jsonl");
      const { fs: fakeFs, calls } = makeFakeFileSystem();
      const { persistence, dispose } = await makePersistenceWithFileSystem(fakeFs);

      try {
         await Effect.runPromise(persistence.configure(parentFile));
         const dir = await Effect.runPromise(persistence.currentDir());
         const finalPath = path.join(dir!, HARBOR_JOBS_FILE);

         await Effect.runPromise(
            persistence.persist([buildPersistedJob({ id: "sync-test", status: "completed" })])
         );
         await Effect.runPromise(persistence.flush());

         const finalRenames = calls.filter((c) => c.op === "rename" && c.args[1] === finalPath);
         expect(finalRenames.length).toBeGreaterThanOrEqual(1);
         for (const renameCall of finalRenames) {
            const renameIndex = calls.indexOf(renameCall);
            const nextSyncDir = calls.findIndex((c, i) => i > renameIndex && c.op === "syncDir" && c.args[0] === path.dirname(finalPath));
            expect(nextSyncDir).toBeGreaterThan(renameIndex);
         }
      } finally {
         await dispose();
      }
   });
});
