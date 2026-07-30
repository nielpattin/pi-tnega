import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeFakeHarborRuntime } from "./helpers/fake-backends.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { HarborJobPersistence } from "../src/services/HarborJobPersistence.js";
import {
   configureAndRecoverJobs,
   flushPendingWrites,
   startJobPersistenceListener
} from "../src/services/HarborJobRecovery.js";
import type { Job } from "../src/domain.js";
import { runTool } from "../src/runtime.js";

function makeTempSessionDir(prefix = "harbor-recovery-") {
   const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
   const parentFile = path.join(base, "2026-01-15T123456Z_parent-session-id.jsonl");
   return { base, parentFile, childDir: parentFile.slice(0, -".jsonl".length) };
}

function buildPersistedJob(overrides: Partial<Job> & Pick<Job, "id" | "status">): Job {
   return {
      ownerSessionId: "parent",
      name: overriddenOrDefault(overrides.name, overrides.id),
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

function overriddenOrDefault<T>(value: T | undefined | null, fallback: T): T {
   return value !== undefined && value !== null ? value : fallback;
}

function writeIndex(childDir: string, jobs: ReadonlyArray<Job>, extra?: object) {
   fs.mkdirSync(childDir, { recursive: true });
   const index = {
      version: 1,
      parentSessionFile: path.join(path.dirname(childDir), path.basename(childDir) + ".jsonl"),
      writtenAt: Date.now(),
      ...extra,
      jobs
   };
   fs.writeFileSync(path.join(childDir, "harbor-jobs.json"), JSON.stringify(index, undefined, 2), "utf8");
}

describe("Harbor job recovery", () => {
   it("restores terminal jobs with names, results, errors, timestamps, and metadata intact", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const stored = [
         buildPersistedJob({
            id: "task-1",
            status: "completed",
            name: "investigate-copy-all",
            resultData: { found: true },
            rawText: "raw completed text",
            transcript: [{ type: "assistant", text: "done" }],
            sessionFile: path.join(childDir, "task-1-session.jsonl"),
            sessionId: "child-1"
         }),
         buildPersistedJob({
            id: "task-2",
            status: "failed",
            name: "explode",
            errorText: "boom",
            settledAt: 1234567890000
         }),
         buildPersistedJob({
            id: "task-3",
            status: "cancelled",
            name: "cancelled-job",
            async: true
         })
      ];
      writeIndex(childDir, stored);

      try {
         const runtime = makeFakeHarborRuntime();
         await runtime.runPromise(configureAndRecoverJobs(parentFile));
         await runtime.runPromise(flushPendingWrites());

         const jobs = await runtime.runPromise(JobRegistry.use((r) => r.list()));
         expect(jobs).toHaveLength(3);

         const t1 = jobs.find((j) => j.id === "task-1")!;
         expect(t1.status).toBe("completed");
         expect(t1.name).toBe("investigate-copy-all");
         expect(t1.resultData).toEqual({ found: true });
         expect(t1.rawText).toBe("raw completed text");
         expect(t1.transcript).toEqual([{ type: "assistant", text: "done" }]);
         expect(t1.sessionFile).toBe(path.join(childDir, "task-1-session.jsonl"));
         expect(t1.sessionId).toBe("child-1");

         const t2 = jobs.find((j) => j.id === "task-2")!;
         expect(t2.status).toBe("failed");
         expect(t2.errorText).toBe("boom");
         expect(t2.settledAt).toBe(1234567890000);

         const t3 = jobs.find((j) => j.id === "task-3")!;
         expect(t3.status).toBe("cancelled");
         expect(t3.async).toBe(true);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("converts pending and running jobs to failed/interrupted on restart", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const stored = [
         buildPersistedJob({
            id: "task-1",
            status: "pending",
            name: "pending-job",
            resultData: { shouldBeDropped: true }
         }),
         buildPersistedJob({
            id: "task-2",
            status: "running",
            name: "running-job",
            startedAt: 1234567880000,
            rawText: "partial output",
            sessionFile: path.join(childDir, "task-2-session.jsonl")
         })
      ];
      writeIndex(childDir, stored);

      try {
         const runtime = makeFakeHarborRuntime();
         await runtime.runPromise(configureAndRecoverJobs(parentFile));

         const jobs = await runtime.runPromise(JobRegistry.use((r) => r.list()));
         expect(jobs).toHaveLength(2);

         for (const job of jobs) {
            expect(job.status).toBe("failed");
            expect(job.errorText).toMatch(/restarted before this job settled/);
            expect(job.errorText).toMatch(/not resumed/);
            expect(job.resultData).toBeUndefined();
            expect(job.settledAt).toBeDefined();
            expect(job.waitInterest).toBe(0);
            expect(job.killInterest).toBe(0);
         }

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("continues task-N IDs above the maximum recovered ID", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const stored = [
         buildPersistedJob({ id: "task-1", status: "completed", name: "one" }),
         buildPersistedJob({ id: "task-5", status: "completed", name: "five" })
      ];
      writeIndex(childDir, stored);

      try {
         const runtime = makeFakeHarborRuntime();
         await runtime.runPromise(configureAndRecoverJobs(parentFile));

         const job = await runtime.runPromise(
            TaskManager.use((s) => s.spawnTask({ task: "next after recovery", name: "next" }))
         );
         expect(job.id).toBe("task-6");

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("starts safely and preserves a corrupt manifest by renaming it", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      fs.mkdirSync(childDir, { recursive: true });
      const indexPath = path.join(childDir, "harbor-jobs.json");
      fs.writeFileSync(indexPath, "{ this is not valid json", "utf8");

      try {
         const runtime = makeFakeHarborRuntime();
         await runtime.runPromise(configureAndRecoverJobs(parentFile));

         const jobs = await runtime.runPromise(JobRegistry.use((r) => r.list()));
         expect(jobs).toHaveLength(0);

         const preserved = fs.readdirSync(childDir).find((f) => f.startsWith("harbor-jobs.json.corrupt-"));
         expect(preserved).toBeDefined();
         expect(fs.existsSync(indexPath)).toBe(false);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("writes the index atomically under concurrent updates", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      fs.mkdirSync(childDir, { recursive: true });

      try {
         const runtime = makeFakeHarborRuntime();
         const persistence = await runtime.runPromise(HarborJobPersistence);
         await runtime.runPromise(persistence.configure(parentFile));

         const arrays: Job[][] = [];
         for (let i = 0; i < 20; i++) {
            arrays.push([
               buildPersistedJob({
                  id: `task-${i + 1}`,
                  status: "completed",
                  name: `job-${i + 1}`
               })
            ]);
         }

         await Promise.all(arrays.map((jobs) => runtime.runPromise(persistence.persist(jobs))));
         await runtime.runPromise(persistence.flush());

         const indexPath = path.join(childDir, "harbor-jobs.json");
         const text = fs.readFileSync(indexPath, "utf8");
         const parsed = JSON.parse(text);
         expect(parsed.version).toBe(1);
         expect(parsed.jobs).toHaveLength(1);
         const nameNumber = Number(parsed.jobs[0].name.slice("job-".length));
         expect(nameNumber).toBeGreaterThanOrEqual(1);
         expect(nameNumber).toBeLessThanOrEqual(20);

         // No partial temp files should be left behind.
         const leftovers = fs.readdirSync(childDir).filter((f) => f.startsWith("harbor-jobs.json.tmp-"));
         expect(leftovers).toHaveLength(0);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("scopes recovery strictly to the current parent session folder", async () => {
      const a = makeTempSessionDir("harbor-recovery-a-");
      const b = makeTempSessionDir("harbor-recovery-b-");
      writeIndex(a.childDir, [buildPersistedJob({ id: "task-1", status: "completed", name: "only-in-a" })]);

      try {
         const runtime = makeFakeHarborRuntime();
         const persistence = await runtime.runPromise(HarborJobPersistence);

         await runtime.runPromise(persistence.configure(a.parentFile));
         const fromA = await runtime.runPromise(persistence.load());
         expect(fromA.jobs).toHaveLength(1);
         expect(fromA.jobs[0].id).toBe("task-1");

         await runtime.runPromise(persistence.configure(b.parentFile));
         const fromB = await runtime.runPromise(persistence.load());
         expect(fromB.jobs).toHaveLength(0);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(a.childDir), { recursive: true, force: true });
         fs.rmSync(path.dirname(b.childDir), { recursive: true, force: true });
      }
   });

   it("keeps recovered terminal jobs visible in the dashboard job list", async () => {
      const { parentFile, childDir } = makeTempSessionDir();
      const stored = [
         buildPersistedJob({ id: "task-1", status: "completed", name: "visible-done" }),
         buildPersistedJob({ id: "task-2", status: "failed", name: "visible-fail" }),
         buildPersistedJob({ id: "task-3", status: "running", name: "interrupted", async: true })
      ];
      writeIndex(childDir, stored);

      try {
         const runtime = makeFakeHarborRuntime();
         await runtime.runPromise(configureAndRecoverJobs(parentFile));

         const jobs = await runtime.runPromise(JobRegistry.use((r) => r.list()));
         expect(jobs.map((j) => j.name).sort()).toEqual(
            ["interrupted", "visible-done", "visible-fail"].sort()
         );
         expect(jobs.filter((j) => j.status === "failed")).toHaveLength(2);
         expect(jobs.filter((j) => j.status === "completed")).toHaveLength(1);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });

   it("persists registry transitions through the change listener", async () => {
      const { parentFile, childDir } = makeTempSessionDir();

      try {
         const runtime = makeFakeHarborRuntime();
         await runtime.runPromise(startJobPersistenceListener());
         await runtime.runPromise(HarborJobPersistence.use((p) => p.configure(parentFile)));

         const job = await runtime.runPromise(
            TaskManager.use((s) => s.spawnTask({ task: "listener test", name: "listener" }))
         );

         await runtime.runPromise(flushPendingWrites());

         const indexPath = path.join(childDir, "harbor-jobs.json");
         const text = fs.readFileSync(indexPath, "utf8");
         const parsed = JSON.parse(text);
         expect(parsed.jobs.some((j: Job) => j.id === job.id && j.name === "listener")).toBe(true);

         await runtime.dispose();
      } finally {
         fs.rmSync(path.dirname(childDir), { recursive: true, force: true });
      }
   });
});
