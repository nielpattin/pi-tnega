import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const planPrompt = await readFile("extensions/pi-subagent/prompts/plan.md", "utf8");
const implementPrompt = await readFile("extensions/pi-subagent/prompts/implement.md", "utf8");

test("plan prompt defines scored task decomposition and execution modes", () => {
   assert.match(planPrompt, /complexity score/i);
   assert.match(planPrompt, /dependencies/i);
   assert.match(planPrompt, /parallel.*waterfall|waterfall.*parallel/is);
   assert.match(planPrompt, /max.*4|4.*agent/is);
   assert.match(planPrompt, /parent.*update.*todo|update.*todo.*parent/is);
});

test("implementation prompt dispatches scored ready tasks and owns plan progress", () => {
   assert.match(implementPrompt, /one worker.*task|one task.*worker/is);
   assert.match(implementPrompt, /min\(4|maximum of 4|max.*4/is);
   assert.match(implementPrompt, /parallel|batch/i);
   assert.match(implementPrompt, /waterfall/i);
   assert.match(implementPrompt, /parent.*update.*plan|update.*plan.*parent/is);
   assert.match(implementPrompt, /critic/i);
});
