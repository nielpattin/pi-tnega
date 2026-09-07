import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const domain = await loadExtension("extensions/pi-subagent/src/domain.ts");

test("agent specs normalize explicit profile fields", () => {
   const specs = domain.normalizeAgentSpecs({
      agents: [
         { task: "explore contracts", name: "explore-contracts", profile: "explorer" },
         { profile: "planner", name: "plan", task: "plan work" }
      ]
   });
   assert.equal(specs.length, 2);
   assert.deepEqual(specs[0], { task: "explore contracts", name: "explore-contracts", profile: "explorer" });
   assert.equal(specs[1].profile, "planner");
});

test("task ids use unique UUIDv7 values with a task prefix", () => {
   const first = domain.formatTaskId();
   const second = domain.formatTaskId();
   const pattern = /^task-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
   assert.match(first, pattern);
   assert.match(second, pattern);
   assert.notEqual(first, second);
});
