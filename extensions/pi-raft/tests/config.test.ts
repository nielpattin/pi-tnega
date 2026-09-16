import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RAFT_CONFIG,
  MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
  MAX_EXECUTOR_TIMEOUT_MS,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  loadRaftConfig,
  loadRaftConfigForScope,
  normalizeRaftConfig,
  saveRaftConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];
const originalCompactionEngineEnv = process.env.PI_RAFT_COMPACTION_ENGINE;

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-config-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (originalCompactionEngineEnv === undefined) {
    delete process.env.PI_RAFT_COMPACTION_ENGINE;
  } else {
    process.env.PI_RAFT_COMPACTION_ENGINE = originalCompactionEngineEnv;
  }
});

describe("Raft configuration", () => {
  it("preserves the standard child tool defaults", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.defaultTools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    expect(DEFAULT_RAFT_CONFIG.agents.excludeTools).toEqual([]);
  });

  it("normalizes excluded child tools", () => {
    expect(
      normalizeRaftConfig({ agents: { excludeTools: ["browser", ""] } }).agents.excludeTools,
    ).toEqual(["browser"]);
  });

  it("normalizes models.aliases into fallback chains", () => {
    expect(DEFAULT_RAFT_CONFIG.models.aliases).toEqual({});
    expect(normalizeRaftConfig({}).models.aliases).toEqual({});
    expect(
      normalizeRaftConfig({
        models: {
          aliases: {
            cheap: "google/gemini-2.5-flash",
            budget: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
            broken: "not-a-model",
            empty: [],
          },
        },
      }).models.aliases,
    ).toEqual({
      cheap: ["google/gemini-2.5-flash"],
      budget: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
    });
  });

  it("normalizes declarative component entries", () => {
    expect(DEFAULT_RAFT_CONFIG.components).toEqual([]);
    const config = normalizeRaftConfig({
      components: [
        { id: "cache", component: "cache-service", config: { limit: 12 } },
        { id: "off", component: "observer", disabled: true },
        { id: "missing-component" },
        "invalid",
      ],
    });
    expect(config.components).toEqual([
      { id: "cache", component: "cache-service", config: { limit: 12 } },
      { id: "off", component: "observer", disabled: true },
    ]);
  });

  it("keeps model-visible execution output at Pi read parity by default", () => {
    expect(DEFAULT_RAFT_CONFIG.execution.executor.maxOutputChars).toBe(50_000);
  });

  it("normalizes bounds and approval modes", () => {
    const config = normalizeRaftConfig({
      execution: { executor: { timeoutMs: 1, memoryLimitBytes: Number.MAX_SAFE_INTEGER } },
      safety: { approvals: { write: "auto", agent: "invalid", model: "anthropic/classifier" } },
      appearance: { ui: { widget: "always", maxRows: 100, refreshMs: 1, eventHistory: 0 } },
      agents: { maxConcurrent: 100, maxPerExecution: 5_000, transport: "herdr" },
    });
    expect(config.execution.executor.timeoutMs).toBe(1_000);
    expect(config.execution.executor.memoryLimitBytes).toBe(
      Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
    expect(config.safety.approvals.write).toBe("auto");
    expect(config.safety.approvals.agent).toBe("allow");
    expect(config.safety.approvals.model).toBe("anthropic/classifier");
    expect(config.agents.maxConcurrent).toBe(32);
    expect(config.agents.maxPerExecution).toBe(1_000);
    expect(config.agents.transport).toBe("herdr");
    expect(config.appearance.ui).toMatchObject({
      widget: "always",
      maxRows: 20,
      refreshMs: 100,
      eventHistory: 1,
    });
  });

  it("normalizes exact per-tool risk overrides and defaults to none", () => {
    expect(DEFAULT_RAFT_CONFIG.safety.toolRisks).toEqual({});
    const normalized = normalizeRaftConfig({
      safety: {
        toolRisks: {
          "pi.read": "read",
          "mcp.docs.search": "read",
          "extensions.browser": "network",
          " mcp.docs.lookup ": "write",
          invalid: "danger",
          "": "execute",
          "pi.write": 42,
        },
      },
    });
    expect(normalized.safety.toolRisks).toEqual({
      "pi.read": "read",
      "mcp.docs.search": "read",
      "extensions.browser": "network",
      "mcp.docs.lookup": "write",
    });
  });

  it("persists exact tool risk overrides and prunes cleared ones", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const location = { cwd, agentDir, projectTrusted: true, scope: "global" as const };

    saveRaftConfig(location, {
      safety: { toolRisks: { "pi.bash": "network", "mcp.docs.search": "read" } },
    });
    expect(loadRaftConfig(location).safety.toolRisks).toEqual({
      "pi.bash": "network",
      "mcp.docs.search": "read",
    });

    saveRaftConfig(location, { safety: { toolRisks: { "pi.bash": null } } });
    expect(loadRaftConfig(location).safety.toolRisks).toEqual({ "mcp.docs.search": "read" });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
      safety: { toolRisks: { "mcp.docs.search": "read" } },
    });
  });
  it("normalizes executor timeout ceilings and per-ref floors", () => {
    const normalized = normalizeRaftConfig({
      execution: {
        executor: {
          timeoutMs: 600_000,
          maxTimeoutMs: 3_600_000,
          hostCallTimeouts: { "extensions.subagent": 1_800_000, "": 5_000, "extensions.bad": 0 },
        },
      },
    });
    expect(normalized.execution.executor.timeoutMs).toBe(600_000);
    expect(normalized.execution.executor.maxTimeoutMs).toBe(3_600_000);
    expect(normalized.execution.executor.hostCallTimeouts).toEqual({
      "extensions.subagent": 1_800_000,
    });

    // timeoutMs above the policy max is visibly normalized down to it.
    const clamped = normalizeRaftConfig({
      execution: { executor: { timeoutMs: 7_200_000, maxTimeoutMs: 900_000 } },
    });
    expect(clamped.execution.executor.timeoutMs).toBe(900_000);

    // The policy max itself is bounded by the hard implementation maximum.
    const hard = normalizeRaftConfig({ execution: { executor: { maxTimeoutMs: 99 * 3_600_000 } } });
    expect(hard.execution.executor.maxTimeoutMs).toBe(MAX_EXECUTOR_TIMEOUT_MS);

    // Per-ref floors cannot exceed the policy max.
    const floored = normalizeRaftConfig({
      execution: {
        executor: { maxTimeoutMs: 300_000, hostCallTimeouts: { "extensions.subagent": 3_600_000 } },
      },
    });
    expect(floored.execution.executor.hostCallTimeouts).toEqual({ "extensions.subagent": 300_000 });
  });

  it("normalizes executor runtimes and their memory ceilings", () => {
    const native = normalizeRaftConfig({
      execution: {
        executor: { runtime: "node-process", memoryLimitBytes: Number.MAX_SAFE_INTEGER },
      },
    });
    expect(native.execution.executor.runtime).toBe("node-process");
    expect(native.execution.executor.memoryLimitBytes).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);

    const invalid = normalizeRaftConfig({ execution: { executor: { runtime: "repl" } } });
    expect(invalid.execution.executor.runtime).toBe("quickjs");
  });

  it("normalizes the default result format", () => {
    expect(DEFAULT_RAFT_CONFIG.execution.executor.resultFormat).toBe("auto");
    expect(
      normalizeRaftConfig({ execution: { executor: { resultFormat: "yaml" } } }).execution.executor
        .resultFormat,
    ).toBe("yaml");
    expect(
      normalizeRaftConfig({ execution: { executor: { resultFormat: "json" } } }).execution.executor
        .resultFormat,
    ).toBe("json");
    expect(
      normalizeRaftConfig({ execution: { executor: { resultFormat: "invalid" } } }).execution
        .executor.resultFormat,
    ).toBe("auto");
  });

  it("normalizes the agent cost budget", () => {
    const enabled = normalizeRaftConfig({ agents: { budgetUsd: 0.42 } });
    expect(enabled.agents.budgetUsd).toBe(0.42);
    const negative = normalizeRaftConfig({ agents: { budgetUsd: -5 } });
    expect(negative.agents.budgetUsd).toBe(0);
    const huge = normalizeRaftConfig({ agents: { budgetUsd: Number.MAX_VALUE } });
    expect(huge.agents.budgetUsd).toBe(1_000_000);
    expect(DEFAULT_RAFT_CONFIG.agents.budgetUsd).toBe(0);
  });

  it("normalizes the agent default model and drops empty values", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.model).toBeUndefined();
    const set = normalizeRaftConfig({ agents: { model: "claude-sonnet-4-5" } });
    expect(set.agents.model).toBe("claude-sonnet-4-5");
    const blank = normalizeRaftConfig({ agents: { model: "  " } });
    expect(blank.agents.model).toBeUndefined();
    const nonString = normalizeRaftConfig({ agents: { model: 42 } });
    expect(nonString.agents.model).toBeUndefined();
  });

  it("normalizes the default runner and independent Claude settings", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.runner).toBe("pi");
    expect(DEFAULT_RAFT_CONFIG.agents.claude).toEqual({ binary: "claude" });
    const configured = normalizeRaftConfig({
      agents: { runner: "claude", claude: { binary: "/opt/claude", model: "claude/haiku" } },
    });
    expect(configured.agents.runner).toBe("claude");
    expect(configured.agents.claude).toEqual({ binary: "/opt/claude", model: "claude/haiku" });
    const invalid = normalizeRaftConfig({
      agents: { runner: "other", claude: { binary: " ", model: " " } },
    });
    expect(invalid.agents.runner).toBe("pi");
    expect(invalid.agents.claude).toEqual({ binary: "claude" });
  });

  it("defaults the agent thinking level to medium and validates the value", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.thinking).toBe("medium");
    const set = normalizeRaftConfig({ agents: { thinking: "high" } });
    expect(set.agents.thinking).toBe("high");
    const invalid = normalizeRaftConfig({ agents: { thinking: "turbo" } });
    expect(invalid.agents.thinking).toBe("medium");
    const nonString = normalizeRaftConfig({ agents: { thinking: 42 } });
    expect(nonString.agents.thinking).toBe("medium");
  });

  it("defaults and validates temporal retention windows", () => {
    expect(DEFAULT_RAFT_CONFIG.lifecycle.retention).toEqual({
      orphanedTempRunMs: 6 * 60 * 60 * 1_000,
      oneShotRunMs: 24 * 60 * 60 * 1_000,
    });
    expect(
      normalizeRaftConfig({
        lifecycle: {
          retention: {
            orphanedTempRunMs: 2 * 60 * 60 * 1_000,
            oneShotRunMs: 2 * 24 * 60 * 60 * 1_000,
          },
        },
      }).lifecycle.retention,
    ).toEqual({ orphanedTempRunMs: 2 * 60 * 60 * 1_000, oneShotRunMs: 2 * 24 * 60 * 60 * 1_000 });
    expect(
      normalizeRaftConfig({ lifecycle: { retention: { orphanedTempRunMs: 1 } } }).lifecycle
        .retention.orphanedTempRunMs,
    ).toBe(60 * 60 * 1_000);
  });

  it("normalizes the ESC halt toggle for actors", () => {
    expect(DEFAULT_RAFT_CONFIG.appearance.ui.haltOnEscape).toBe(true);
    const disabled = normalizeRaftConfig({ appearance: { ui: { haltOnEscape: false } } });
    expect(disabled.appearance.ui.haltOnEscape).toBe(false);
    const invalid = normalizeRaftConfig({ appearance: { ui: { haltOnEscape: "off" } } });
    expect(invalid.appearance.ui.haltOnEscape).toBe(true);
  });

  it("normalizes agent-preview visibility and the global debounce", () => {
    expect(DEFAULT_RAFT_CONFIG.appearance.ui.showAgentToolPreview).toBe(true);
    expect(DEFAULT_RAFT_CONFIG.appearance.ui.updateDebounceMs).toBe(100);
    expect(
      normalizeRaftConfig({
        appearance: { ui: { showAgentToolPreview: false, updateDebounceMs: 0 } },
      }).appearance.ui,
    ).toMatchObject({ showAgentToolPreview: false, updateDebounceMs: 0 });
    expect(
      normalizeRaftConfig({ appearance: { ui: { updateDebounceMs: -10 } } }).appearance.ui
        .updateDebounceMs,
    ).toBe(0);
    expect(
      normalizeRaftConfig({ appearance: { ui: { updateDebounceMs: 99_999 } } }).appearance.ui
        .updateDebounceMs,
    ).toBe(2_000);
    expect(
      normalizeRaftConfig({
        appearance: { ui: { showAgentToolPreview: "off", updateDebounceMs: "fast" } },
      }).appearance.ui,
    ).toMatchObject({ showAgentToolPreview: true, updateDebounceMs: 100 });
  });

  it("defaults, validates, merges, and persists tool display", () => {
    expect(DEFAULT_RAFT_CONFIG.appearance.ui.toolDisplay).toBe("compact");
    expect(
      normalizeRaftConfig({ appearance: { ui: { toolDisplay: "full" } } }).appearance.ui
        .toolDisplay,
    ).toBe("full");
    expect(
      normalizeRaftConfig({ appearance: { ui: { toolDisplay: "minimal" } } }).appearance.ui
        .toolDisplay,
    ).toBe("compact");
    expect(normalizeRaftConfig({ appearance: { ui: { toolDisplay: "compact" } } })).toMatchObject({
      appearance: { ui: { toolDisplay: "compact" } },
    });

    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const location = { cwd, agentDir, projectTrusted: true };

    saveRaftConfig(
      { ...location, scope: "global" },
      { appearance: { ui: { toolDisplay: "compact" } } },
    );
    saveRaftConfig(
      { ...location, scope: "project" },
      { appearance: { ui: { toolDisplay: "full" } } },
    );

    expect(loadRaftConfigForScope(location, "global").appearance.ui.toolDisplay).toBe("compact");
    expect(loadRaftConfig(location).appearance.ui.toolDisplay).toBe("full");
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
      appearance: { ui: { toolDisplay: "compact" } },
    });
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "raft.json"), "utf8"))).toMatchObject({
      appearance: { ui: { toolDisplay: "full" } },
    });
  });

  it("accepts legacy ui keys as fallback for renamed settings", () => {
    expect(
      normalizeRaftConfig({ appearance: { ui: { showNestedToolCalls: false } } }).appearance.ui
        .showAgentToolPreview,
    ).toBe(false);
    expect(
      normalizeRaftConfig({
        appearance: { ui: { showNestedToolCalls: false, showAgentToolPreview: true } },
      }).appearance.ui.showAgentToolPreview,
    ).toBe(true);
    expect(
      normalizeRaftConfig({ appearance: { ui: { nestedToolDebounceMs: 42 } } }).appearance.ui
        .updateDebounceMs,
    ).toBe(42);
    expect(
      normalizeRaftConfig({ appearance: { ui: { nestedToolDebounceMs: 42, updateDebounceMs: 7 } } })
        .appearance.ui.updateDebounceMs,
    ).toBe(7);
  });

  it("merges global and trusted project configuration", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "raft.json"),
      JSON.stringify({ safety: { approvals: { network: "allow" } }, agents: { maxConcurrent: 2 } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "raft.json"),
      JSON.stringify({ agents: { transport: "localterm" } }),
    );
    const location = { cwd, agentDir, projectTrusted: true };
    const config = loadRaftConfig(location);
    expect(config.safety.approvals.network).toBe("allow");
    expect(config.agents.maxConcurrent).toBe(2);
    expect(config.agents.transport).toBe("localterm");

    const globalConfig = loadRaftConfigForScope(location, "global");
    expect(globalConfig.agents.maxConcurrent).toBe(2);
    expect(globalConfig.agents.transport).toBe("process");
    expect(loadRaftConfigForScope(location, "project").agents.transport).toBe("localterm");
  });

  it("keeps persisted scope views separate from effective merged configuration", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "raft.json"),
      JSON.stringify({ execution: { executor: { runtime: "node-process" } } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "raft.json"),
      JSON.stringify({ execution: { executor: { runtime: "quickjs" } } }),
    );
    const location = { cwd, agentDir, projectTrusted: true };
    expect(loadRaftConfigForScope(location, "global").execution.executor.runtime).toBe(
      "node-process",
    );
    expect(loadRaftConfigForScope(location, "project").execution.executor.runtime).toBe("quickjs");
    expect(loadRaftConfig(location).execution.executor.runtime).toBe("quickjs");
  });

  it("updates the compaction engine environment across config re-initialization", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const projectConfig = path.join(cwd, ".pi", "raft.json");
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      projectConfig,
      JSON.stringify({ lifecycle: { compaction: { engine: "raft" } } }),
    );

    loadRaftConfig({ cwd, agentDir, projectTrusted: true });
    expect(process.env.PI_RAFT_COMPACTION_ENGINE).toBe("raft");

    fs.writeFileSync(
      projectConfig,
      JSON.stringify({ lifecycle: { compaction: { engine: "pi" } } }),
    );
    loadRaftConfig({ cwd, agentDir, projectTrusted: true });
    expect(process.env.PI_RAFT_COMPACTION_ENGINE).toBeUndefined();
  });

  it("ignores project configuration when the project is untrusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "raft.json"),
      JSON.stringify({ safety: { approvals: { execute: "deny" } } }),
    );
    const config = loadRaftConfig({ cwd, agentDir, projectTrusted: false });
    expect(config.safety.approvals.execute).toBe("allow");
  });

  it("saves partial overrides into the project raft.json when trusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "raft.json"),
      JSON.stringify({ agents: { transport: "localterm" } }),
    );

    const result = saveRaftConfig(
      { cwd, agentDir, projectTrusted: true },
      { agents: { maxConcurrent: 8 } },
    );

    expect(result.scope).toBe("project");
    expect(result.path).toBe(path.join(cwd, ".pi", "raft.json"));
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "raft.json"), "utf8"));
    expect(saved).toEqual({
      configVersion: 5,
      agents: { transport: "localterm", maxConcurrent: 8 },
    });
    const config = loadRaftConfigForScope({ cwd, agentDir, projectTrusted: true }, "project");
    expect(config.agents.maxConcurrent).toBe(8);
    expect(config.agents.transport).toBe("localterm");
  });

  it("saves explicit global overrides from a trusted project", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const projectPath = path.join(cwd, ".pi", "raft.json");
    fs.writeFileSync(projectPath, JSON.stringify({}));

    const result = saveRaftConfig(
      { cwd, agentDir, projectTrusted: true, scope: "global" },
      { execution: { executor: { timeoutMs: 45_000 } } },
    );

    expect(result).toEqual({ scope: "global", path: path.join(agentDir, "raft.json") });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toEqual({
      execution: { executor: { timeoutMs: 45_000 } },
      configVersion: 5,
    });
    expect(JSON.parse(fs.readFileSync(projectPath, "utf8"))).toEqual({});
  });

  it("preserves a newer configuration version written by a future build", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const globalPath = path.join(agentDir, "raft.json");
    const future = { configVersion: 5, futureSection: { enabled: true } };
    fs.writeFileSync(globalPath, JSON.stringify(future));

    // Load path: forward-compatible docs are accepted as-is and never rewritten.
    loadRaftConfig({ cwd, agentDir, projectTrusted: true });
    expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual(future);

    // Save path: version markers written by newer builds survive a save.
    saveRaftConfig(
      { cwd, agentDir, projectTrusted: true, scope: "global" },
      { execution: { executor: { timeoutMs: 10_000 } } },
    );
    expect(JSON.parse(fs.readFileSync(globalPath, "utf8"))).toEqual({
      execution: { executor: { timeoutMs: 10_000 } },
      ...future,
    });
  });

  it("saves into the global raft.json when the project is untrusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const result = saveRaftConfig(
      { cwd, agentDir, projectTrusted: false },
      { execution: { executor: { timeoutMs: 30_000 } } },
    );

    expect(result.scope).toBe("global");
    expect(result.path).toBe(path.join(agentDir, "raft.json"));
    expect(fs.existsSync(path.join(cwd, ".pi", "raft.json"))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"));
    expect(saved).toEqual({ execution: { executor: { timeoutMs: 30_000 } }, configVersion: 5 });
  });

  it("rejects explicit project saves for untrusted projects", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");

    expect(() =>
      saveRaftConfig({ cwd, agentDir, projectTrusted: false, scope: "project" }, {}),
    ).toThrow("Cannot save project Raft configuration for an untrusted project");
    expect(fs.existsSync(path.join(cwd, ".pi", "raft.json"))).toBe(false);
  });

  it("saves array overrides by replacing the array while preserving siblings", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "raft.json"),
      JSON.stringify({
        tools: { mcp: { cache: { enabled: false, revalidate: "changed" } } },
        agents: { transport: "tmux", defaultTools: ["read", "bash"] },
      }),
    );

    saveRaftConfig(
      { cwd, agentDir, projectTrusted: true },
      {
        tools: { mcp: { cache: { revalidate: "all", revalidateBudgetMs: 65_000 } } },
        agents: { defaultTools: ["read", "edit", "grep"] },
      },
    );

    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "raft.json"), "utf8"));
    // Arrays are replaced, not concatenated; sibling object keys are preserved.
    expect(saved.agents).toEqual({ transport: "tmux", defaultTools: ["read", "edit", "grep"] });
    expect(saved.tools.mcp.cache).toEqual({
      enabled: false,
      revalidate: "all",
      revalidateBudgetMs: 65_000,
    });
    const config = loadRaftConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.agents.defaultTools).toEqual(["read", "edit", "grep"]);
    expect(config.tools.mcp.cache).toEqual({
      enabled: false,
      revalidate: "all",
      revalidateBudgetMs: 65_000,
    });
    expect(config.agents.transport).toBe("tmux");
  });

  it("defaults the agent timeout to 60 minutes and clamps to the 24-hour bound", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.timeoutMs).toBe(3_600_000);
    expect(normalizeRaftConfig({}).agents.timeoutMs).toBe(3_600_000);
    expect(normalizeRaftConfig({ agents: { timeoutMs: 99_999_999 } }).agents.timeoutMs).toBe(
      86_400_000,
    );
    expect(normalizeRaftConfig({ agents: { timeoutMs: 1_200_000 } }).agents.timeoutMs).toBe(
      1_200_000,
    );
  });

  it("accepts arbitrary non-negative safe agent depths", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.maxDepth).toBe(2);
    expect(normalizeRaftConfig({ agents: { maxDepth: 64 } }).agents.maxDepth).toBe(64);
    expect(normalizeRaftConfig({ agents: { maxDepth: -1 } }).agents.maxDepth).toBe(0);
    expect(normalizeRaftConfig({ agents: { maxDepth: Number.MAX_VALUE } }).agents.maxDepth).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("normalizes the per-child token limit and treats zero as disabled", () => {
    expect(DEFAULT_RAFT_CONFIG.agents.maxTokensPerChild).toBe(0);
    const set = normalizeRaftConfig({ agents: { maxTokensPerChild: 50_000 } });
    expect(set.agents.maxTokensPerChild).toBe(50_000);
    const negative = normalizeRaftConfig({ agents: { maxTokensPerChild: -5 } });
    expect(negative.agents.maxTokensPerChild).toBe(0);
    const huge = normalizeRaftConfig({ agents: { maxTokensPerChild: Number.MAX_VALUE } });
    expect(huge.agents.maxTokensPerChild).toBe(100_000_000);
  });
});

describe("MCP descriptor cache configuration", () => {
  it("defaults to an enabled cache with changed revalidation", () => {
    const config = normalizeRaftConfig({});
    expect(config.tools.mcp.cache).toEqual({
      enabled: true,
      revalidate: "changed",
      revalidateBudgetMs: 60_000,
    });
  });

  it("parses explicit cache overrides", () => {
    const config = normalizeRaftConfig({
      tools: { mcp: { cache: { enabled: false, revalidate: "all", revalidateBudgetMs: 65_000 } } },
    });
    expect(config.tools.mcp.cache).toEqual({
      enabled: false,
      revalidate: "all",
      revalidateBudgetMs: 65_000,
    });
  });

  it("clamps the budget and falls back on an unknown revalidation policy", () => {
    const config = normalizeRaftConfig({
      tools: { mcp: { cache: { revalidate: "sometimes", revalidateBudgetMs: 250 } } },
    });
    expect(config.tools.mcp.cache.revalidate).toBe("changed");
    expect(config.tools.mcp.cache.revalidateBudgetMs).toBe(1_000);
  });
});
