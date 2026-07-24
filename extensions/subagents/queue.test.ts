import assert from "node:assert/strict";
import test from "node:test";
import { popLastFromPending, rebuildQueuesAfterPop } from "./src/domain.ts";

test("rebuildQueuesAfterPop prefers last steering message", () => {
   const result = rebuildQueuesAfterPop(["steer 1", "steer 2"], ["follow 1"]);
   assert.equal(result.popped, "steer 2");
   assert.deepEqual(result.steering, ["steer 1"]);
   assert.deepEqual(result.followUp, ["follow 1"]);
});

test("rebuildQueuesAfterPop pops last follow-up when steering is empty", () => {
   const result = rebuildQueuesAfterPop([], ["follow 1", "follow 2"]);
   assert.equal(result.popped, "follow 2");
   assert.deepEqual(result.steering, []);
   assert.deepEqual(result.followUp, ["follow 1"]);
});

test("rebuildQueuesAfterPop returns undefined when both steering and followUp are empty", () => {
   const result = rebuildQueuesAfterPop([], []);
   assert.equal(result.popped, undefined);
   assert.deepEqual(result.steering, []);
   assert.deepEqual(result.followUp, []);
});

test("popLastFromPending pops last element", () => {
   const res1 = popLastFromPending(["a", "b", "c"]);
   assert.equal(res1.popped, "c");
   assert.deepEqual(res1.remaining, ["a", "b"]);

   const res2 = popLastFromPending([]);
   assert.equal(res2.popped, undefined);
   assert.deepEqual(res2.remaining, []);
});
