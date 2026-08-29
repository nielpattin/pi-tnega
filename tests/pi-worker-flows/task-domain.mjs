import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const domain = await loadExtension("extensions/pi-worker-flows/src/workers/domain.ts");

test("worker spec uses the `worker` profile field, not `agent`", () => {
   const specs = domain.normalizeWorkerSpecs({
      workers: [
         { task: "explore contracts", name: "explore-contracts", worker: "explorer" },
         { worker: "planner", name: "plan", task: "plan work" }
      ]
   });
   assert.equal(specs.length, 2);
   assert.deepEqual(specs[0], { task: "explore contracts", name: "explore-contracts", worker: "explorer" });
   assert.equal(specs[0].agent, undefined);
   assert.equal(specs[1].worker, "planner");
});

test("task ids are task-N, not worker-N", () => {
   assert.equal(domain.formatTaskId(1), "task-1");
   assert.equal(domain.formatTaskId(3), "task-3");
});

test("recoverable tasks require recoverable status and a session file", () => {
   assert.equal(domain.canRecoverTask({ status: "recoverable", sessionFile: "s.jsonl" }), true);
   assert.equal(domain.canRecoverTask({ status: "failed", sessionFile: "s.jsonl" }), false);
   assert.equal(domain.canRecoverTask({ status: "recoverable" }), false);
   assert.equal(domain.canRecoverTask({ status: "running", sessionFile: "s.jsonl" }), false);
});

test("pause status is gone; recoverable is settled but not terminal", () => {
   for (const status of ["pending", "running", "completed", "failed", "cancelled"]) {
      assert.equal(domain.isTerminalTaskStatus(status), status === "completed" || status === "failed" || status === "cancelled");
   }
   assert.equal(domain.isTerminalTaskStatus("recoverable"), false);
   assert.equal(domain.isSettledTaskStatus("recoverable"), true);
   assert.equal(domain.isSettledTaskStatus("paused"), false);
   assert.equal(domain.isSettledTaskStatus("running"), false);
});

test("Job type fields do not leak into the task vocabulary", async () => {
   const task = {
      id: "task-1",
      ownerSessionId: "parent",
      name: "explore",
      worker: "explorer",
      promptOrCommand: "explore",
      status: "recoverable",
      createdAt: 1
   };
   assert.equal(task.agent, undefined);
   assert.ok(domain.formatTaskId);
});
