import assert from "node:assert";
import { test } from "node:test";
import { resolveProfileSpawnParams } from "./src/agents/resolve.ts";
import { createDefaultProfile } from "./src/agents/store.ts";

test("resolveProfileSpawnParams for pi harness with null model/effort", () => {
  const prof = createDefaultProfile();
  const res = resolveProfileSpawnParams(prof);
  assert.strictEqual(res.harness, "pi");
  assert.strictEqual(res.model, undefined);
  assert.strictEqual(res.reasoningEffort, undefined);
});

test("resolveProfileSpawnParams for pi harness with specified model/effort", () => {
  const prof = createDefaultProfile();
  prof.pi.model = "anthropic/claude-3-5-sonnet";
  prof.pi.reasoning_effort = "high";
  const res = resolveProfileSpawnParams(prof);
  assert.strictEqual(res.harness, "pi");
  assert.strictEqual(res.model, "anthropic/claude-3-5-sonnet");
  assert.strictEqual(res.reasoningEffort, "high");
});

test("resolveProfileSpawnParams for agy harness", () => {
  const prof = createDefaultProfile();
  prof.harness = "agy";
  prof.agy.model = "gemini-3.6-flash";
  prof.agy.reasoning_effort = "low";
  const res = resolveProfileSpawnParams(prof);
  assert.strictEqual(res.harness, "agy");
  assert.strictEqual(res.model, "gemini-3.6-flash-low");
  assert.strictEqual(res.reasoningEffort, "low");
});
