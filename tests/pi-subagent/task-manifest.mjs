import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const manifest = await loadExtension(
   "extensions/pi-subagent/src/services/task-manifest.ts"
);

const task = {
   id: "task-1",
   ownerSessionId: "parent",
   name: "explore-contracts",
   profile: "explorer",
   model: "openai-codex/gpt-5.6-luna",
   cwd: "D:/repo/PharmacyCentral",
   promptOrCommand: "Explore the codebase.",
   status: "failed",
   createdAt: Date.now(),
   startedAt: Date.now(),
   settledAt: Date.now(),
   errorText: "Agent exited with an error",
   sessionFile: "D:/repo/sessions/child.jsonl",
   paneId: "w9:p3",
   sessionId: "session-1"
};

test("persisted task keeps the agent profile, failed status, and session file", () => {
   const { index } = manifest.buildPersistedIndex([task]);
   const parsed = manifest.parsePersistedIndex(index);
   assert.ok(parsed, "index must parse");
   const [roundtrip] = parsed.jobs;
   assert.equal(roundtrip.id, "task-1");
   assert.equal(roundtrip.profile, "explorer");
   assert.equal(roundtrip.status, "failed");
   assert.equal(roundtrip.sessionFile, "D:/repo/sessions/child.jsonl");
   assert.equal(roundtrip.paneId, "w9:p3");
   assert.equal(roundtrip.errorText, "Agent exited with an error");
});

test("persisted task round-trips run usage stats", () => {
   const withUsage = { ...task, usage: { cost: 0.5, toolCalls: 3, contextTokens: 9000 } };
   const { index } = manifest.buildPersistedIndex([withUsage]);
   const parsed = manifest.parsePersistedIndex(index);
   assert.ok(parsed, "index must parse");
   assert.deepEqual(parsed.jobs[0].usage, { cost: 0.5, toolCalls: 3, contextTokens: 9000 });
   const broken = structuredClone(index);
   broken.jobs[0].usage = { cost: "free", toolCalls: 3, contextTokens: 9000 };
   assert.equal(manifest.parsePersistedIndex(broken), undefined);
});


test("interrupted tasks are marked failed", async () => {
   const persistence = await loadExtension(
      "extensions/pi-subagent/src/services/task-persistence.ts"
   );
   const { index } = manifest.buildPersistedIndex([task]);
   const parsed = manifest.parsePersistedIndex(index);
   assert.ok(parsed);
   const running = { ...task, status: "running", settledAt: undefined };
   const converted = persistence.markInterruptedTaskFailed(running);
   assert.equal(converted.status, "failed");
   assert.equal(converted.sessionFile, "D:/repo/sessions/child.jsonl");
   assert.match(converted.errorText ?? "", /marked failed/);
});

test("manifest file names are task scoped", async () => {
   const persistence = await loadExtension(
      "extensions/pi-subagent/src/services/task-persistence.ts"
   );
   assert.equal(persistence.AGENTS_TASKS_FILE, "agents-tasks.json");
   });
