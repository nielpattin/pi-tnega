import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RAFT_CONFIG, loadRaftConfig, normalizeRaftConfig } from "../src/config.js";
import type { RaftState } from "../src/raft-state.js";
import type { ModelSource } from "../src/ui/model-picker.js";
import { summaryFor } from "../src/ui/settings-values.js";
import {
  RISK_CLASSES,
  TOOL_RISK_ADD_SETTING_ID,
  parseToolRiskEntry,
  toolRiskCandidateRefs,
  toolRiskPartial,
  toolRiskRefs,
} from "../src/ui/settings-values.js";
import {
  buildRaftSettingsItems,
  compactionThresholdPartial,
  executorMemoryLimitOptions,
  RaftSettingsComponent,
  openRaftSettings,
  parseBudgetValue,
  parseFormattedNumericValue,
  populateClaudeModelSource,
} from "../src/ui/settings.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const borderLine = (width: number): string => "─".repeat(width);

const fakeModelSource: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: { "anthropic/claude-sonnet-4-5": 200, "openai/gpt-5.5": 100 },
};

const buildItems = () =>
  buildRaftSettingsItems(theme, DEFAULT_RAFT_CONFIG, () => {}, {
    modelSource: fakeModelSource,
    activeModelKey: "anthropic/claude-sonnet-4-5",
  });

const findSetting = (items: readonly any[], id: string): any => {
  const direct = items.find((item) => item.id === id);
  if (direct) return direct;
  for (const group of items) {
    if (!group.submenu) continue;
    const submenu = group.submenu("", () => {}) as any;
    const nested = submenu?.settingsList?.items as readonly any[] | undefined;
    const found = nested?.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
};

describe("RaftSettingsComponent", () => {
  it("populates Claude models asynchronously without requiring startup discovery", async () => {
    const source: ModelSource = {
      models: [{ provider: "claude", id: "configured" }],
      lastUsed: {},
    };
    let resolveModels!: (models: Array<{ value: string; displayName: string }>) => void;
    const models = new Promise<Array<{ value: string; displayName: string }>>((resolve) => {
      resolveModels = resolve;
    });

    const loading = populateClaudeModelSource(source, () => models);
    expect(source.models.map((model) => model.id)).toEqual(["configured"]);

    resolveModels([{ value: "haiku", displayName: "Haiku" }]);
    await loading;
    expect(source.models).toEqual([{ provider: "claude", id: "haiku", name: "Haiku" }]);
  });

  it("offers executor memory limits through the machine capacity", () => {
    const machineCapacity = 24 * 1024 * 1024 * 1024;
    const values = executorMemoryLimitOptions(machineCapacity);

    expect(values).toContain(512 * 1024 * 1024);
    expect(values.at(-1)).toBe(machineCapacity);
  });

  it("surfaces the unsafe Node process executor and its larger memory range", () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.execution.executor.runtime = "node-process";
    const items = buildRaftSettingsItems(theme, config, () => {}, { modelSource: fakeModelSource });
    const executor = findSetting(items, "execution.executor")!;
    const lines = executor.submenu!("", () => {})
      .render(100)
      .join("\n");

    expect(lines).toContain("node-process");
    expect(lines).toContain("unsafe");
    expect(lines).toContain("trusted-code escape hatch");
  });

  it("renders the pi-core style top and bottom borders with search", () => {
    const component = new RaftSettingsComponent(
      theme,
      buildItems(),
      () => {},
      () => {},
    );
    const lines = component.render(80);

    expect(lines[0]).toBe(borderLine(80));
    expect(lines[lines.length - 1]).toBe(borderLine(80));
    expect(lines.some((line) => line.includes("Type to search"))).toBe(true);
    expect(lines.some((line) => line.includes("Executor"))).toBe(true);
    expect(lines.some((line) => line.includes("MCP"))).toBe(true);
    expect(
      lines.some((line) => line.includes("Editing: Global defaults (~/.pi/agent/raft.json)")),
    ).toBe(true);
  });

  it("toggles save scope with Ctrl+G from the root and active submenus", () => {
    const scopes: string[] = [];
    const component = new RaftSettingsComponent(
      theme,
      buildItems(),
      () => {},
      () => {},
      {
        initialSaveScope: "project",
        projectScopeAvailable: true,
        onSaveScopeChange: (scope) => scopes.push(scope),
      },
    );

    component.handleInput("\x07");
    expect(component.render(100).join("\n")).toContain(
      "Editing: Global defaults (~/.pi/agent/raft.json)",
    );

    const list = component.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "execution.executor",
    );
    list.activateItem();
    component.handleInput("\x07");

    expect(list.submenuComponent).not.toBeNull();
    expect(component.render(100).join("\n")).toContain(
      "Editing: Project overrides (.pi/raft.json)",
    );
    expect(scopes).toEqual(["global", "project"]);
  });

  it("keeps untrusted settings global-only", () => {
    const onSaveScopeChange = vi.fn();
    const component = new RaftSettingsComponent(
      theme,
      buildItems(),
      () => {},
      () => {},
      { initialSaveScope: "global", projectScopeAvailable: false, onSaveScopeChange },
    );

    component.handleInput("\x07");

    expect(component.render(100).join("\n")).toContain(
      "Editing: Global defaults (~/.pi/agent/raft.json)",
    );
    expect(component.render(100).join("\n")).toContain("project scope unavailable");
    expect(onSaveScopeChange).not.toHaveBeenCalled();
  });

  it("renders every section", () => {
    const items = buildItems();
    const component = new RaftSettingsComponent(
      theme,
      items,
      () => {},
      () => {},
    );
    const lines = component.render(80).join("\n");
    const labels = items.map((item) => item.label);

    expect(labels).toEqual([
      "Executor ›",
      "MCP ›",
      "Approvals ›",
      "Agents ›",
      "UI ›",
      "Code previews ›",
      "Lifecycle ›",
    ]);
    expect(items.length).toBe(7);
  });

  it("marks submenu rows with a drill-in marker and leaves inline toggles plain", () => {
    const items = buildItems();
    const labels = items.map((item) => item.label);
    // Every root page opens a section submenu.
    expect(labels).toEqual([
      "Executor ›",
      "MCP ›",
      "Approvals ›",
      "Agents ›",
      "UI ›",
      "Code previews ›",
      "Lifecycle ›",
    ]);
    expect(findSetting(items, "execution.executor")?.label).toBe("Executor ›");

    // Inside a section, submenu fields are marked but inline value toggles are not.
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Default model ›");
    expect(lines).toContain("Max concurrent ›");
    // Inline value-cycle rows stay plain.
    expect(lines).toContain("Transport");
    expect(lines).not.toContain("Transport ›");
    expect(lines).toContain("Enabled");
    expect(lines).not.toContain("Enabled ›");
  });

  it("opening a section submenu renders its fields", () => {
    const items = buildItems();
    const executor = findSetting(items, "execution.executor");
    expect(executor?.submenu).toBeDefined();
    const submenu = executor!.submenu!("", () => {});
    const lines = submenu.render(80).join("\n");
    expect(lines).toContain("Runtime");
    expect(lines).toContain("quickjs");
    expect(lines).toContain("Timeout");
    expect(lines).toContain("Memory limit");
    expect(lines).toContain("Max output chars");
    expect(lines).toContain("Result format");
    expect(lines).toContain("auto");
  });

  it("section submenus offer the same type-to-search filter as the root page", () => {
    const items = buildItems();
    const executor = findSetting(items, "execution.executor")!;
    const submenu = executor.submenu!("", () => {});

    const initial = submenu.render(80).join("\n");
    expect(initial).toContain("Type to search");
    expect(initial).toContain("Runtime");

    for (const char of "memory") submenu.handleInput?.(char);
    const filtered = submenu.render(80).join("\n");
    expect(filtered).toContain("Memory limit");
    expect(filtered).not.toContain("Timeout");
    expect(filtered).not.toContain("Result format");
    expect(filtered).not.toContain("No matching settings");
  });

  it("exposes the compaction engine", () => {
    const items = buildItems();
    const compaction = findSetting(items, "lifecycle.compaction");
    expect(compaction?.currentValue).toBe("raft");
    const lines = compaction!.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Threshold");
    expect(lines).toContain("Pi default");
    expect(lines).toContain("anthropic/claude-sonnet-4-5");
    expect(lines).toContain("Engine");
    expect(lines).toContain("raft");
    expect(lines).toContain("Max occupancy");
    expect(lines).toContain("0.65");
    const section = compaction!.submenu!("", () => {}) as any;
    const target = section.settingsList.items.find(
      (item: { id: string }) => item.id === "lifecycle.compaction.targetContextRatio",
    );
    expect(target.values).toEqual(
      Array.from({ length: 13 }, (_, index) => String((25 + index * 5) / 100)),
    );
  });

  it("persists the active model's compaction threshold as a custom percent", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.lifecycle.compaction.thresholds["openai/gpt-5.5"] = 0.6;
    const items = buildRaftSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource, activeModelKey: "openai/gpt-5.5" },
    );
    const section = findSetting(items, "lifecycle.compaction")!.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "lifecycle.compaction.threshold",
    );
    expect(list.items[list.selectedIndex].currentValue).toBe("60%");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({
      value: "Custom percent…",
      label: "Custom percent…",
    });
    expect(list.submenuComponent.input).toBeDefined();
    expect(list.submenuComponent.input.getValue()).toBe("60");

    list.submenuComponent.input.setValue("");
    list.submenuComponent.handleInput("73");
    list.submenuComponent.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "lifecycle.compaction.threshold",
      value: { mode: "percent", value: 0.73 },
    });
    expect(list.items[list.selectedIndex].currentValue).toBe("73%");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({
      value: "Custom percent…",
      label: "Custom percent…",
    });
    list.submenuComponent.input.setValue("");
    list.submenuComponent.handleInput("5");
    list.submenuComponent.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "lifecycle.compaction.threshold",
      value: { mode: "percent", value: 0.25 },
    });
    expect(list.items[list.selectedIndex].currentValue).toBe("25%");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({
      value: "Custom percent…",
      label: "Custom percent…",
    });
    list.submenuComponent.handleInput("\x1b");
    expect(list.submenuComponent.selectList).toBeDefined();
  });

  it("persists a custom token threshold through the drill-in input", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.lifecycle.compaction.tokenThresholds["openai/gpt-5.5"] = 150_000;
    const items = buildRaftSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource, activeModelKey: "openai/gpt-5.5" },
    );
    const section = findSetting(items, "lifecycle.compaction")!.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "lifecycle.compaction.threshold",
    );
    expect(list.items[list.selectedIndex].currentValue).toBe("150k tokens");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({ value: "Custom tokens…", label: "Custom tokens…" });
    expect(list.submenuComponent.input).toBeDefined();
    expect(list.submenuComponent.input.getValue()).toBe("150000");

    list.submenuComponent.input.setValue("");
    list.submenuComponent.handleInput("5");
    list.submenuComponent.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "lifecycle.compaction.threshold",
      value: { mode: "tokens", value: 1_000 },
    });
    expect(list.items[list.selectedIndex].currentValue).toBe("1k tokens");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({ value: "Custom tokens…", label: "Custom tokens…" });
    list.submenuComponent.input.setValue("");
    list.submenuComponent.handleInput("240000");
    list.submenuComponent.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "lifecycle.compaction.threshold",
      value: { mode: "tokens", value: 240_000 },
    });
    expect(list.items[list.selectedIndex].currentValue).toBe("240k tokens");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({ value: "Custom tokens…", label: "Custom tokens…" });
    list.submenuComponent.handleInput("\x1b");
    expect(list.submenuComponent.selectList).toBeDefined();
  });

  it("builds exclusive compaction threshold partials per mode", () => {
    expect(compactionThresholdPartial("openai/gpt-5.5", { mode: "percent", value: 0.8 })).toEqual({
      lifecycle: {
        compaction: {
          thresholds: { "openai/gpt-5.5": 0.8 },
          tokenThresholds: { "openai/gpt-5.5": null },
        },
      },
    });
    expect(
      compactionThresholdPartial("openai/gpt-5.5", { mode: "tokens", value: 240_000 }),
    ).toEqual({
      lifecycle: {
        compaction: {
          thresholds: { "openai/gpt-5.5": null },
          tokenThresholds: { "openai/gpt-5.5": 240_000 },
        },
      },
    });
    expect(compactionThresholdPartial("openai/gpt-5.5", { mode: "default" })).toEqual({
      lifecycle: {
        compaction: {
          thresholds: { "openai/gpt-5.5": null },
          tokenThresholds: { "openai/gpt-5.5": null },
        },
      },
    });
  });

  it("exposes temporal retention defaults", () => {
    const items = buildItems();
    const retention = findSetting(items, "lifecycle.retention");
    expect(retention?.currentValue).toBe("6h · 1d");
    const lines = retention!.submenu!("", () => {})
      .render(100)
      .join("\n");
    expect(lines).toContain("Orphaned temp runs");
    expect(lines).toContain("6h");
    expect(lines).toContain("One-shot runs");
    expect(lines).toContain("1d");
  });

  it("presents the Tool display row in the UI settings section", () => {
    const component = new RaftSettingsComponent(
      theme,
      buildItems(),
      () => {},
      () => {},
    );

    component.handleInput("ui");
    expect(component.render(80).join("\n")).toContain("→ UI ›");
    component.handleInput("\r");
    const lines = component.render(80).join("\n");
    expect(lines).toContain("Tool display");
    expect(lines).toContain("compact");
    expect(lines).toContain("Agent tool preview");
    expect(lines).toContain("Update debounce");
    expect(lines).toContain("100ms");
  });

  it("surfaces the recursion budget in the Agents section", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("Off");
  });

  it("accepts an arbitrary non-negative agent depth", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildRaftSettingsItems(
      theme,
      structuredClone(DEFAULT_RAFT_CONFIG),
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "agents.maxDepth",
    );
    list.activateItem();

    expect(list.submenuComponent.render(100).join("\n")).toContain(
      "Enter any non-negative integer",
    );
    list.submenuComponent.input.setValue("-1");
    list.submenuComponent.handleInput("\r");
    expect(applied).toEqual([]);
    expect(list.submenuComponent.render(100).join("\n")).toContain(
      "Enter a non-negative safe integer",
    );

    list.submenuComponent.input.setValue("");
    list.submenuComponent.handleInput("64");
    list.submenuComponent.handleInput("\r");

    expect(applied.at(-1)).toEqual({ id: "agents.maxDepth", value: 64 });
    expect(list.items[list.selectedIndex].currentValue).toBe("64");
  });

  it("shows the configured budget as a currency value", () => {
    const items = buildRaftSettingsItems(
      theme,
      { ...DEFAULT_RAFT_CONFIG, agents: { ...DEFAULT_RAFT_CONFIG.agents, budgetUsd: 0.25 } },
      () => {},
      { modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("$0.25");
  });

  it("persists formatted numeric settings while keeping their normalized labels", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildRaftSettingsItems(
      theme,
      structuredClone(DEFAULT_RAFT_CONFIG),
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource },
    );
    const executor = findSetting(items, "execution.executor")!;
    const section = executor.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "execution.executor.memoryLimitBytes",
    );
    list.activateItem();
    list.submenuComponent.selectList.onSelect({
      value: String(128 * 1024 * 1024),
      label: "128 MB",
    });

    expect(applied.at(-1)).toEqual({
      id: "execution.executor.memoryLimitBytes",
      value: 128 * 1024 * 1024,
    });
    expect(list.items[list.selectedIndex].currentValue).toBe("128 MB");
    expect(section.render(100).join("\n")).not.toContain("134217728");
  });

  it("persists labeled thinking levels using their canonical values", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildRaftSettingsItems(
      theme,
      structuredClone(DEFAULT_RAFT_CONFIG),
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "agents.thinking",
    );
    list.activateItem();
    list.submenuComponent.selectList.onSelect({ value: "high", label: "High" });

    expect(applied.at(-1)).toEqual({ id: "agents.thinking", value: "high" });
    expect(list.items[list.selectedIndex].currentValue).toBe("High");
  });

  it("parses every formatted numeric settings style", () => {
    expect(parseFormattedNumericValue("128 MB")).toBe(128 * 1024 * 1024);
    expect(parseFormattedNumericValue("250ms")).toBe(250);
    expect(parseFormattedNumericValue("2m")).toBe(120_000);
    expect(parseFormattedNumericValue("7d")).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(parseFormattedNumericValue("$0.25")).toBe(0.25);
    expect(parseFormattedNumericValue("500k")).toBe(500_000);
    expect(parseFormattedNumericValue("2M")).toBe(2_000_000);
    expect(parseFormattedNumericValue("2,000,000")).toBe(2_000_000);
    expect(parseFormattedNumericValue("Off")).toBe(0);
  });

  it("parses currency-formatted budget values back to numbers", () => {
    expect(parseBudgetValue("$0.25")).toBe(0.25);
    expect(parseBudgetValue("$0.10")).toBe(0.1);
    expect(parseBudgetValue("Off")).toBe(0);
    expect(parseBudgetValue("0.5")).toBe(0.5);
    expect(parseBudgetValue("$5.00")).toBe(5);
  });

  it("surfaces the default thinking level in the Agents section as Medium by default", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("Medium");
  });

  it("shows a configured thinking level in the Agents section", () => {
    const items = buildRaftSettingsItems(
      theme,
      { ...DEFAULT_RAFT_CONFIG, agents: { ...DEFAULT_RAFT_CONFIG.agents, thinking: "high" } },
      () => {},
      { modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("High");
  });

  it("offers auto policies and a dedicated classifier model picker", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.approvals.write = "auto";
    const items = buildRaftSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource },
    );
    const approvals = findSetting(items, "safety.approvals")!;
    const section = approvals.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    const write = list.items.find((item: { id: string }) => item.id === "safety.approvals.write");
    expect(write.currentValue).toBe("auto");
    expect(write.values).toContain("auto");
    expect(section.render(100).join("\n")).toContain("Auto model ›");
    expect(section.render(100).join("\n")).toContain("Inherit");

    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "safety.approvals.model",
    );
    list.activateItem();
    list.submenuComponent.handleInput("\x1b[B");
    list.submenuComponent.handleInput("\r");

    expect(applied.at(-1)).toEqual({
      id: "safety.approvals.model",
      value: "anthropic/claude-sonnet-4-5",
    });
  });

  it("surfaces configured tool risk overrides in the approvals setting", () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.toolRisks = { "pi.read": "read", "extensions.browser": "network" };
    const approvals = findSetting(
      buildRaftSettingsItems(theme, config, () => {}, { modelSource: fakeModelSource }),
      "safety.approvals",
    )!;
    expect(approvals.currentValue).toBe("allow · 2 tool risk overrides");
    expect(approvals.description).toContain("Action risks");
    const section = approvals.submenu!("", () => {}) as any;
    const risks = section.settingsList.items.find(
      (item: { id: string }) => item.id === "safety.toolRisks",
    );
    expect(risks.currentValue).toBe("2 overrides");
  });

  it("reopens the shared agent model picker at its live selection", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex((item: { id: string }) => item.id === "agents.model");

    list.activateItem();
    list.submenuComponent.handleInput("\x1b[B");
    list.submenuComponent.handleInput("\r");
    list.activateItem();

    const reopened = list.submenuComponent.render(100).join("\n");
    const modelLine = reopened
      .split("\n")
      .find((line: string) => line.includes("claude-sonnet-4-5"));
    const inheritLine = reopened.split("\n").find((line: string) => line.includes("Inherit"));
    expect(modelLine).toContain("✓");
    expect(inheritLine).not.toContain("✓");
  });

  it("surfaces the default model in the Agents section as Inherit by default", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("Inherit");
  });

  it("shows the configured default model value in the Agents section", () => {
    const items = buildRaftSettingsItems(
      theme,
      {
        ...DEFAULT_RAFT_CONFIG,
        agents: { ...DEFAULT_RAFT_CONFIG.agents, model: "claude-sonnet-4-5" },
      },
      () => {},
      { modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("claude-sonnet-4-5");
    expect(lines).not.toContain("Default model ›      Inherit");
  });

  it("surfaces the per-child token limit in the Agents section", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Token limit");
    expect(lines).toContain("Off");
  });

  it("shows a configured token limit formatted compactly", () => {
    const items = buildRaftSettingsItems(
      theme,
      {
        ...DEFAULT_RAFT_CONFIG,
        agents: { ...DEFAULT_RAFT_CONFIG.agents, maxTokensPerChild: 500_000 },
      },
      () => {},
      { modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {})
      .render(80)
      .join("\n");
    expect(lines).toContain("Token limit");
    expect(lines).toContain("500k");
  });

  it("reloads Pi only after the kernel settings dialog closes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-kernel-settings-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_RAFT_KERNEL", undefined);
    let closed = false;
    const reloadResources = vi.fn(async () => {
      expect(closed).toBe(true);
    });
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    const state = {
      config,
      kernelReloadRequired: false,
      ensure: vi.fn(async () => {}),
      reloadConfig: vi.fn(() => {
        state.kernelReloadRequired =
          loadRaftConfig({ cwd, agentDir, projectTrusted: true }).execution.executor.kernel !==
          config.execution.executor.kernel;
      }),
      agents: { claudeModels: vi.fn(async () => []) },
    };
    const context = {
      mode: "tui",
      cwd,
      isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => fakeModelSource.models },
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory) => {
          const component = factory({}, theme, {}, () => {}) as RaftSettingsComponent;
          const root = component.settingsList as any;
          root.selectItem("execution.executor");
          root.activateItem();
          const executor = (root.submenuComponent as any).settingsList;
          executor.selectItem("execution.executor.kernel");
          executor.activateItem();
          expect(reloadResources).not.toHaveBeenCalled();
          expect(config.execution.executor.kernel).toBe("typescript");
          closed = true;
        }),
      },
    } as unknown as ExtensionContext;
    try {
      await openRaftSettings(context, { state: state as unknown as RaftState, reloadResources });
      expect(
        loadRaftConfig({ cwd, agentDir, projectTrusted: true }).execution.executor.kernel,
      ).toBe("python");
      expect(reloadResources).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists tool-display changes through the real settings dialog flow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-settings-display-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      const onConfigApplied = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() =>
          Object.assign(config, loadRaftConfig({ cwd, agentDir, projectTrusted: true })),
        ),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as RaftSettingsComponent;
            component.handleInput("ui");
            component.handleInput("\r");
            const ui = ((component.settingsList as any).submenuComponent as any).settingsList;
            ui.selectItem("appearance.ui.toolDisplay");
            ui.activateItem();
          }),
        },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state, onConfigApplied });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        appearance: { ui: { toolDisplay: "full" } },
      });
      expect(config.appearance.ui.toolDisplay).toBe("full");
      expect(onConfigApplied).toHaveBeenCalledOnce();
      // The saved setting id flows through so consumers can gate downstream
      // refresh work (transcript re-render) on display-affecting sections.
      expect(onConfigApplied).toHaveBeenCalledWith("appearance.ui.toolDisplay");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("awaits the provider reconcile before reporting success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-settings-reconcile-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      const order: string[] = [];
      let releaseReload!: () => void;
      const reloadGate = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => {
          order.push("reload-start");
          return reloadGate.then(() => {
            order.push("reload-done");
          });
        }),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const notify = vi.fn((message: string) => {
        if (message.startsWith("Raft settings saved")) order.push("saved");
      });
      let dialogDone = false;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify,
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as RaftSettingsComponent;
            component.handleInput("ui");
            component.handleInput("\r");
            const ui = ((component.settingsList as any).submenuComponent as any).settingsList;
            ui.selectItem("appearance.ui.toolDisplay");
            ui.activateItem();
            const deadline = Date.now() + 2000;
            while (!order.includes("reload-start") && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            expect(order).toContain("reload-start");
            dialogDone = true;
          }),
        },
      } as unknown as ExtensionContext;

      const opened = openRaftSettings(context, { state });
      const settled = await Promise.race([
        opened.then(() => "opened"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(dialogDone).toBe(true);
      // The provider reconcile and success report remain gated by the reload.
      expect(settled).toBe("pending");
      releaseReload();
      await opened;
      expect(order).toEqual(["reload-start", "reload-done", "saved"]);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens trusted projects at global save scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-settings-global-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as RaftSettingsComponent;
            const root = component.settingsList as any;
            root.selectItem("execution.executor");
            root.activateItem();
            const executor = root.submenuComponent.settingsList as any;
            executor.selectItem("execution.executor.runtime");
            executor.activateItem();
          }),
        },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        execution: { executor: { runtime: "node-process" } },
      });
      expect(fs.existsSync(path.join(cwd, ".pi", "raft.json"))).toBe(false);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("switches trusted projects to project overrides with Ctrl+G", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-settings-project-scope-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory(
              { requestRender: vi.fn() },
              theme,
              {},
              () => {},
            ) as RaftSettingsComponent;
            component.handleInput("\x07");
            const root = component.settingsList as any;
            root.selectItem("execution.executor");
            root.activateItem();
            const executor = root.submenuComponent.settingsList as any;
            executor.selectItem("execution.executor.runtime");
            executor.activateItem();
          }),
        },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "raft.json"), "utf8"))).toMatchObject(
        { execution: { executor: { runtime: "node-process" } } },
      );
      expect(fs.existsSync(path.join(agentDir, "raft.json"))).toBe(false);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps global edits visible when a project override remains effective", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-settings-shadowed-global-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "raft.json"),
      JSON.stringify({ execution: { executor: { runtime: "quickjs" } } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "raft.json"),
      JSON.stringify({ execution: { executor: { runtime: "quickjs" } } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const location = { cwd, agentDir, projectTrusted: true };
      const config = loadRaftConfig(location);
      const requestRender = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadRaftConfig(location))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      let globalLines: string[] = [];
      let projectLines: string[] = [];
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory(
              { requestRender },
              theme,
              {},
              () => {},
            ) as RaftSettingsComponent;
            expect(component.render(120).join("\n")).toContain(
              "project overrides may remain active here",
            );

            const globalRoot = component.settingsList as any;
            globalRoot.selectItem("execution.executor");
            globalRoot.activateItem();
            const executor = globalRoot.submenuComponent.settingsList as any;
            executor.selectItem("execution.executor.runtime");
            executor.activateItem();
            const updatedGlobalRoot = component.settingsList as any;
            updatedGlobalRoot.selectItem("execution.executor");
            updatedGlobalRoot.activateItem();
            globalLines = component.render(120);
            expect(config.execution.executor.runtime).toBe("quickjs");

            component.handleInput("\x07");
            const projectRoot = component.settingsList as any;
            projectRoot.selectItem("execution.executor");
            projectRoot.activateItem();
            projectLines = component.render(120);
          }),
        },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(globalLines.find((line) => line.includes("Runtime (TS)"))).toContain("node-process");
      expect(projectLines.find((line) => line.includes("Runtime (TS)"))).toContain("quickjs");
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        execution: { executor: { runtime: "node-process" } },
      });
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "raft.json"), "utf8"))).toMatchObject(
        { execution: { executor: { runtime: "quickjs" } } },
      );
      expect(requestRender).toHaveBeenCalledTimes(1);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Raft RPC settings", () => {
  it("navigates nested sections and persists values through dialog primitives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-rpc-settings-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      const notify = vi.fn();
      let openedUi = false;
      let changedDisplay = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() =>
          Object.assign(config, loadRaftConfig({ cwd, agentDir, projectTrusted: true })),
        ),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Raft settings › UI › Tool display")) {
          changedDisplay = true;
          return options.find((option) => option.startsWith("full"));
        }
        if (title.startsWith("Raft settings › UI")) {
          if (!openedUi) {
            openedUi = true;
            return options.find((option) => option.startsWith("Tool display"));
          }
          return "← Back";
        }
        if (title.startsWith("Raft settings")) {
          if (!openedUi) return options.find((option) => option.startsWith("UI ·"));
          return "Done";
        }
        return undefined;
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify, select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(
        select.mock.calls.some(([title]) => String(title).startsWith("Raft settings › UI")),
      ).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        appearance: { ui: { toolDisplay: "full" } },
      });
      expect(config.appearance.ui.toolDisplay).toBe("full");
      expect(notify).toHaveBeenCalledWith("Raft settings saved.", "info");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports nested numeric, string, and model pickers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-rpc-agents-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      let openedAgents = false;
      let editedDepth = false;
      let editedModel = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() =>
          Object.assign(config, loadRaftConfig({ cwd, agentDir, projectTrusted: true })),
        ),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Raft settings › Agents › Default model")) {
          editedModel = true;
          return options.find((option) => option.startsWith("gpt-5.5"));
        }
        if (title.startsWith("Raft settings › Agents")) {
          if (!editedDepth) return options.find((option) => option.startsWith("Max depth"));
          if (!editedModel) return options.find((option) => option.startsWith("Default model"));
          return "← Back";
        }
        if (title.startsWith("Raft settings")) {
          if (!openedAgents) {
            openedAgents = true;
            return options.find((option) => option.startsWith("Agents ·"));
          }
          return "Done";
        }
        return undefined;
      });
      const input = vi.fn(async (title: string) => {
        if (title.startsWith("Raft settings › Agents › Max depth")) {
          editedDepth = true;
          return "64";
        }
        return undefined;
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input, custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        agents: { maxDepth: 64, model: "openai/gpt-5.5" },
      });
      expect(config.agents.maxDepth).toBe(64);
      expect(config.agents.model).toBe("openai/gpt-5.5");
      expect(input).toHaveBeenCalledTimes(1);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits nested tool allowlists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-rpc-list-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      let openedAgents = false;
      let openedTools = false;
      let toggled = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() =>
          Object.assign(config, loadRaftConfig({ cwd, agentDir, projectTrusted: true })),
        ),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Raft settings › Agents › Enable Tools › ls")) {
          toggled = true;
          return options.find((option) => option.startsWith("false"));
        }
        if (title.startsWith("Raft settings › Agents › Enable Tools")) {
          if (!toggled) return options.find((option) => option.startsWith("ls ·"));
          return "← Back";
        }
        if (title.startsWith("Raft settings › Agents")) {
          if (!openedTools) {
            openedTools = true;
            return options.find((option) => option.startsWith("Enable Tools"));
          }
          return "← Back";
        }
        if (!openedAgents) {
          openedAgents = true;
          return options.find((option) => option.startsWith("Agents ·"));
        }
        return "Done";
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(config.agents.defaultTools).toContain("read");
      expect(config.agents.defaultTools).not.toContain("ls");
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        agents: { defaultTools: expect.not.arrayContaining(["ls"]) },
      });
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits the active model compaction threshold", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-rpc-compaction-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      let openedCompaction = false;
      let changed = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() =>
          Object.assign(config, loadRaftConfig({ cwd, agentDir, projectTrusted: true })),
        ),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Raft settings › Lifecycle › Compaction › Threshold")) {
          return options.find((option) => option.startsWith("Custom percent"));
        }
        if (title.startsWith("Raft settings › Lifecycle › Compaction")) {
          if (!changed) return options.find((option) => option.startsWith("Threshold"));
          return "← Back";
        }
        if (title.startsWith("Raft settings › Lifecycle")) {
          if (!openedCompaction) {
            openedCompaction = true;
            return options.find((option) => option.startsWith("Compaction"));
          }
          return "← Back";
        }
        if (title.startsWith("Raft settings")) {
          if (!openedCompaction) return options.find((option) => option.startsWith("Lifecycle ·"));
          return "Done";
        }
        return undefined;
      });
      const input = vi.fn(async () => {
        changed = true;
        return "73";
      });
      const context = {
        mode: "rpc",
        cwd,
        model: { provider: "openai", id: "gpt-5.5" },
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input, custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(config.lifecycle.compaction.thresholds["openai/gpt-5.5"]).toBe(0.73);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        lifecycle: { compaction: { thresholds: { "openai/gpt-5.5": 0.73 } } },
      });
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens trusted projects at global save scope in RPC hosts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-rpc-scope-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      let edited = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() =>
          Object.assign(config, loadRaftConfig({ cwd, agentDir, projectTrusted: true })),
        ),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Raft settings › Executor › Runtime (TS)")) {
          edited = true;
          return options.find((option) => option.startsWith("node-process"));
        }
        if (title.startsWith("Raft settings › Executor")) {
          if (!edited) return options.find((option) => option.startsWith("Runtime (TS)"));
          return "← Back";
        }
        if (!edited) return options.find((option) => option.startsWith("Executor ·"));
        return "Done";
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        execution: { executor: { runtime: "node-process" } },
      });
      expect(fs.existsSync(path.join(cwd, ".pi", "raft.json"))).toBe(false);
      expect(String(select.mock.calls[0]?.[0])).toContain(
        "Editing: Global defaults (~/.pi/agent/raft.json)",
      );
      expect(select.mock.calls[0]?.[1]).toContain("Switch save scope · Project overrides");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits an exact tool risk override through RPC primitives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-rpc-risk-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const location = { cwd, agentDir, projectTrusted: true };
      const config = structuredClone(DEFAULT_RAFT_CONFIG);
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadRaftConfig(location))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as RaftState;
      let editedClass = false;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Raft settings › Approvals › Action risks › pi.bash")) {
          editedClass = true;
          return options.find((option) => option.startsWith("network"));
        }
        if (title.startsWith("Raft settings › Approvals › Action risks")) {
          if (!editedClass) return options.find((option) => option.startsWith("pi.bash"));
          return options.find((option) => option === "← Back");
        }
        if (title.startsWith("Raft settings › Approvals")) {
          if (!editedClass) return options.find((option) => option.startsWith("Action risks"));
          return options.find((option) => option === "← Back");
        }
        if (title.startsWith("Raft settings")) {
          if (!editedClass) return options.find((option) => option.startsWith("Approvals ·"));
          return "Done";
        }
        return undefined;
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openRaftSettings(context, { state });

      expect(editedClass).toBe(true);
      expect(config.safety.toolRisks).toEqual({ "pi.bash": "network" });
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "raft.json"), "utf8"))).toMatchObject({
        safety: { toolRisks: { "pi.bash": "network" } },
      });
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Raft settings redesign", () => {
  it("names Enable Tools and documents their scope", () => {
    const agents = buildItems().find((item) => item.id === "agents")!.submenu!("", () => {}) as any;
    const row = agents.settingsList.items.find(
      (item: { id: string }) => item.id === "agents.defaultTools",
    );
    expect(row.label).toBe("Enable Tools ›");
    expect(row.description).toContain("newly spawned agents");
    expect(row.description).toContain("current session");
    expect(row.description).toContain("raft_exec");
    expect(row.description).toContain("extension");
  });

  it("lists loaded extension tools on Enable Tools", () => {
    const items = buildRaftSettingsItems(theme, DEFAULT_RAFT_CONFIG, () => {}, {
      modelSource: fakeModelSource,
      extensionToolNames: ["browser", "read", "raft_exec"],
    });
    const agents = items.find((item) => item.id === "agents")!.submenu!("", () => {}) as any;
    const row = agents.settingsList.items.find(
      (item: { id: string }) => item.id === "agents.defaultTools",
    );
    expect(row.label).toBe("Enable Tools ›");
    const picker = row.submenu("", () => {}) as any;
    const ids = picker.settingsList.items.map((item: { id: string }) => item.id);
    expect(ids).toContain("agents.defaultTools.bash");
    expect(ids).toContain("agents.defaultTools.browser");
    expect(ids).not.toContain("agents.defaultTools.raft_exec");
    const browser = picker.settingsList.items.find(
      (item: { id: string }) => item.id === "agents.defaultTools.browser",
    );
    expect(browser.currentValue).toBe("true");
  });

  it("uses task-oriented settings sections and matching config paths", () => {
    const config = normalizeRaftConfig({
      execution: { executor: { kernel: "python" } },
      safety: { approvals: { execute: "ask" } },
      appearance: { ui: { toolDisplay: "full" } },
      lifecycle: { retention: { oneShotRunMs: 60_000 } },
    });
    const items = buildRaftSettingsItems(theme, config, () => {}, {
      modelSource: { models: [], lastUsed: {} },
    });

    expect(items.map((item) => item.id)).toEqual([
      "execution.executor",
      "tools.mcp",
      "safety.approvals",
      "agents",
      "appearance.ui",
      "appearance.codePreview",
      "lifecycle",
    ]);
    expect(config.execution.executor.kernel).toBe("python");
    expect(config.safety.approvals.execute).toBe("ask");
    expect(config.appearance.ui.toolDisplay).toBe("full");
    expect(config.lifecycle.retention.oneShotRunMs).toBe(3_600_000);
  });
});

describe("tool risk overrides", () => {
  const risksSection = (config = DEFAULT_RAFT_CONFIG, extensionToolNames: string[] = []) => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildRaftSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { modelSource: fakeModelSource, extensionToolNames },
    );
    const approvals = items.find((item) => item.id === "safety.approvals")!;
    const section = approvals.submenu!("", () => {}) as any;
    const row = section.settingsList.items.find(
      (item: { id: string }) => item.id === "safety.toolRisks",
    );
    const risks = row.submenu("", () => {}) as any;
    return { applied, row, risks, list: risks.settingsList };
  };

  it("lists configured refs before discovered candidates", () => {
    expect(
      toolRiskRefs({ "mcp.docs.search": "read", "pi.bash": "network" }, [
        "pi.read",
        "extensions.browser",
      ]),
    ).toEqual(["mcp.docs.search", "pi.bash", "pi.read", "extensions.browser"]);
    const candidates = toolRiskCandidateRefs(["browser", "read", "raft_exec"]);
    expect(candidates).toContain("pi.bash");
    expect(candidates).toContain("extensions.browser");
    expect(candidates).toContain("extensions.read");
    expect(candidates).not.toContain("pi.raft_exec");
  });

  it("surfaces an extension tool that shadows a core name with an override flag", () => {
    const { list } = risksSection(DEFAULT_RAFT_CONFIG, ["read"]);
    const core = list.items.find((item: { id: string }) => item.id === "pi.read");
    const shadow = list.items.find((item: { id: string }) => item.id === "extensions.read");
    expect(core).toBeDefined();
    expect(shadow).toBeDefined();
    expect(shadow.description).toContain("Overrides Pi core read");
  });

  it("persists only rows that differ from their built-in class", () => {
    expect(
      toolRiskPartial(
        [
          { ref: "pi.bash", value: "network" },
          { ref: "pi.read", value: "read" },
          { ref: "pi.write", value: "write" },
        ],
        { "pi.read": "read" },
      ),
    ).toEqual({ "pi.bash": "network", "pi.read": null });
    expect(toolRiskPartial([{ ref: "not-a-ref", value: "read" }])).toEqual({});
  });

  it("accepts only well-formed add tokens", () => {
    expect(parseToolRiskEntry("mcp.github.search=network")).toEqual({
      ref: "mcp.github.search",
      risk: "network",
    });
    expect(parseToolRiskEntry("mcp.github.search")).toBeUndefined();
    expect(parseToolRiskEntry("bad ref=network")).toBeUndefined();
    expect(parseToolRiskEntry("pi.bash=danger")).toBeUndefined();
  });

  it("shows each tool's class with no default placeholder", () => {
    const { list } = risksSection(DEFAULT_RAFT_CONFIG, ["browser"]);
    const bash = list.items.find((item: { id: string }) => item.id === "pi.bash");
    const read = list.items.find((item: { id: string }) => item.id === "pi.read");
    const browser = list.items.find((item: { id: string }) => item.id === "extensions.browser");

    expect(read.currentValue).toBe("read");
    expect(bash.currentValue).toBe("execute");
    expect(browser.currentValue).toBe("execute");
    expect(read.values).toEqual([...RISK_CLASSES]);
    expect(read.values).not.toContain("Default");
    expect(read.description).toContain("Pi core tool");
    expect(browser.description).toContain("Extension tool");
  });

  it("cycles a tool's class from the approvals section", () => {
    const { applied, list } = risksSection();
    const bash = list.items.find((item: { id: string }) => item.id === "pi.bash");
    list.selectedIndex = list.items.indexOf(bash);
    list.activateItem();
    expect(applied.at(-1)).toEqual({ id: "safety.toolRisks", value: { "pi.bash": "network" } });
  });

  it("leaves an unconfigured row out when it cycles back to its own class", () => {
    const { applied, list } = risksSection();
    const write = list.items.find((item: { id: string }) => item.id === "pi.write");
    list.selectedIndex = list.items.indexOf(write);
    list.activateItem();
    expect(applied.at(-1)).toEqual({ id: "safety.toolRisks", value: { "pi.write": "execute" } });
    for (let step = 0; step < 4; step += 1) list.activateItem();
    expect(write.currentValue).toBe("write");
    expect(applied.at(-1)).toEqual({ id: "safety.toolRisks", value: {} });
  });

  it("restores a configured class and can clear it again", () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.safety.toolRisks = { "pi.bash": "network" };
    const { applied, list, row } = risksSection(config);
    expect(row.currentValue).toBe("1 override");
    const bash = list.items.find((item: { id: string }) => item.id === "pi.bash");
    expect(bash.currentValue).toBe("network");
    list.selectedIndex = list.items.indexOf(bash);
    list.activateItem();
    expect(applied.at(-1)).toEqual({ id: "safety.toolRisks", value: { "pi.bash": "agent" } });
    for (let step = 0; step < 3; step += 1) list.activateItem();
    expect(bash.currentValue).toBe("execute");
    expect(applied.at(-1)).toEqual({ id: "safety.toolRisks", value: { "pi.bash": null } });
  });

  it("adds an arbitrary ref through the two-phase add flow", () => {
    const { applied, list } = risksSection();
    const add = list.items.find((item: { id: string }) => item.id === TOOL_RISK_ADD_SETTING_ID);
    list.selectedIndex = list.items.indexOf(add);
    list.activateItem();
    const addSubmenu = list.submenuComponent as any;
    expect(addSubmenu.render(80).join("\n")).toContain("Add action risk override");
    addSubmenu.input.handleInput("mcp.github.search");
    addSubmenu.input.handleInput("\r");
    expect(addSubmenu.render(80).join("\n")).toContain("mcp.github.search");
    addSubmenu.selectList.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "safety.toolRisks",
      value: { "mcp.github.search": "read" },
    });
  });

  it("rejects a malformed ref without committing", () => {
    const { applied, list } = risksSection();
    const add = list.items.find((item: { id: string }) => item.id === TOOL_RISK_ADD_SETTING_ID);
    list.selectedIndex = list.items.indexOf(add);
    list.activateItem();
    const addSubmenu = list.submenuComponent as any;
    addSubmenu.input.handleInput("not a ref");
    addSubmenu.input.handleInput("\r");
    expect(addSubmenu.selectList).toBeUndefined();
    expect(applied).toEqual([]);
  });
});
