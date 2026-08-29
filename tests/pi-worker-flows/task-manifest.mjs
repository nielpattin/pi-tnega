import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const manifest = await loadExtension(
   "extensions/pi-worker-flows/src/workers/services/workers-task-manifest.ts"
);

const task = {
   id: "task-1",
   ownerSessionId: "parent",
   name: "explore-contracts",
   worker: "explorer",
   model: "openai-codex/gpt-5.6-luna",
   cwd: "D:/repo/PharmacyCentral",
   promptOrCommand: "Explore the codebase.",
   status: "recoverable",
   createdAt: 1_000,
   startedAt: 1_001,
   settledAt: 1_100,
   errorText: "Agent finished without calling structured_output",
   sessionFile: "D:/repo/sessions/child.jsonl",
   sessionId: "session-1"
};

test("persisted task keeps the worker profile, recoverable status, and session file", () => {
   const { index } = manifest.buildPersistedIndex([task]);
   const parsed = manifest.parsePersistedIndex(index);
   assert.ok(parsed, "index must parse");
   const [roundtrip] = parsed.jobs;
   assert.equal(roundtrip.id, "task-1");
   assert.equal(roundtrip.worker, "explorer");
   assert.equal(roundtrip.status, "recoverable");
   assert.equal(roundtrip.sessionFile, "D:/repo/sessions/child.jsonl");
   assert.equal(roundtrip.errorText, "Agent finished without calling structured_output");
});

test("legacy records with `agent` and `failed` still parse and map to worker", () => {
   const legacy = {
      version: 1,
      jobs: [
         {
            id: "worker-1",
            ownerSessionId: "parent",
            name: "explore",
            agent: "explorer",
            promptOrCommand: "explore",
            status: "failed",
            createdAt: 1,
            startedAt: 1,
            settledAt: 2,
            errorText: "old failure",
            sessionFile: "old.jsonl",
            sessionId: "old"
         }
      ]
   };
   const parsed = manifest.parsePersistedIndex(legacy);
   assert.ok(parsed, "legacy index must parse");
   const [job] = parsed.jobs;
   assert.equal(job.worker, "explorer");
   assert.equal(job.status, "failed");
   assert.equal(job.sessionFile, "old.jsonl");
});

test("stale status values are rejected or handled by the converter", async () => {
   const persistence = await loadExtension(
      "extensions/pi-worker-flows/src/workers/services/workers-task-persistence.ts"
   );
   const { index } = manifest.buildPersistedIndex([task]);
   const parsed = manifest.parsePersistedIndex(index);
   assert.ok(parsed);
   const running = { ...task, status: "running", settledAt: undefined };
   const converted = persistence.convertInterruptedTask(running);
   assert.equal(converted.status, "recoverable");
   assert.equal(converted.sessionFile, "D:/repo/sessions/child.jsonl");
   assert.match(converted.errorText ?? "", /worker_recover/);
});

test("manifest file names are task scoped", async () => {
   const persistence = await loadExtension(
      "extensions/pi-worker-flows/src/workers/services/workers-task-persistence.ts"
   );
   assert.equal(persistence.WORKERS_TASKS_FILE, "workers-tasks.json");
   assert.equal(persistence.WORKERS_LEGACY_TASKS_FILE, "workers-jobs.json");
});
