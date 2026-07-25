import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createDefaultConfig,
  createDefaultProfile,
  loadAgentsConfig,
  saveAgentsConfig,
  switchHarness,
} from "./src/agents/store.ts";

test("store defaults: fresh config has pi harness with inherit blanks", () => {
  const cfg = createDefaultConfig();
  assert.strictEqual(cfg.version, 1);
  assert.strictEqual(cfg.profiles.fast.harness, "pi");
  assert.strictEqual(cfg.profiles.fast.pi.model, null);
  assert.strictEqual(cfg.profiles.fast.pi.reasoning_effort, null);
  assert.strictEqual(cfg.profiles.fast.agy.model, "gemini-3.6-flash");
  assert.strictEqual(cfg.profiles.fast.agy.reasoning_effort, "low");

  assert.strictEqual(cfg.profiles.good.harness, "pi");
  assert.strictEqual(cfg.profiles.good.pi.model, null);
  assert.strictEqual(cfg.profiles.good.pi.reasoning_effort, null);
});

test("harness switch pi -> agy and agy -> pi preserves inactive side", () => {
  let prof = createDefaultProfile();
  prof.pi.model = "anthropic/claude-3-5-sonnet";
  prof.pi.reasoning_effort = "high";

  // pi -> agy
  prof = switchHarness(prof, "agy");
  assert.strictEqual(prof.harness, "agy");
  assert.strictEqual(prof.pi.model, "anthropic/claude-3-5-sonnet");
  assert.strictEqual(prof.agy.model, "gemini-3.6-flash");
  assert.strictEqual(prof.agy.reasoning_effort, "low");

  // Modify agy side
  prof.agy.model = "gemini-3.6-pro";
  prof.agy.reasoning_effort = "medium";

  // agy -> pi
  prof = switchHarness(prof, "pi");
  assert.strictEqual(prof.harness, "pi");
  assert.strictEqual(prof.pi.model, "anthropic/claude-3-5-sonnet");
  assert.strictEqual(prof.pi.reasoning_effort, "high");
  assert.strictEqual(prof.agy.model, "gemini-3.6-pro");
  assert.strictEqual(prof.agy.reasoning_effort, "medium");
});

test("load/save agents.json roundtrip", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));
  const filePath = path.join(tmpDir, "agents.json");

  try {
    const cfg = createDefaultConfig();
    cfg.profiles.fast.harness = "agy";
    cfg.profiles.fast.agy.model = "gemini-3.6-flash";
    cfg.profiles.fast.agy.reasoning_effort = "high";
    cfg.profiles.good.pi.model = "openai/gpt-4o";

    saveAgentsConfig(cfg, filePath);

    const loaded = loadAgentsConfig(filePath);
    assert.strictEqual(loaded.profiles.fast.harness, "agy");
    assert.strictEqual(loaded.profiles.fast.agy.model, "gemini-3.6-flash");
    assert.strictEqual(loaded.profiles.fast.agy.reasoning_effort, "high");
    assert.strictEqual(loaded.profiles.good.harness, "pi");
    assert.strictEqual(loaded.profiles.good.pi.model, "openai/gpt-4o");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
