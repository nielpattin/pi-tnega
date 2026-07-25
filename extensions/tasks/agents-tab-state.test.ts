import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultConfig } from "./src/agents/store.ts";
import type { AgentsConfig } from "./src/agents/types.ts";

export type AgentsTab = "subagents" | "vibe";

export interface TabState {
   activeTab: AgentsTab;
}

export function switchTab(current: AgentsTab): AgentsTab {
   return current === "subagents" ? "vibe" : "subagents";
}

export interface VibeTabState {
   selectedProfile: "fast" | "good";
   fieldIndex: number; // 0: harness, 1: model, 2: reasoning_effort
}

export function nextVibeField(currentField: number): number {
   return (currentField + 1) % 5;
}

export function prevVibeField(currentField: number): number {
   return (currentField + 4) % 5;
}

export function toggleVibeHarness(config: AgentsConfig, profile: "fast" | "good"): AgentsConfig {
   const current = config.profiles[profile];
   const nextHarness = current.harness === "pi" ? "agy" : "pi";
   return {
      ...config,
      profiles: {
         ...config.profiles,
         [profile]: {
            ...current,
            harness: nextHarness
         }
      }
   };
}

export function updateVibeModel(config: AgentsConfig, profile: "fast" | "good", model: string): AgentsConfig {
   const current = config.profiles[profile];
   const harness = current.harness;
   const cleanModel = model.trim() || (harness === "pi" ? null : "gemini-3.6-flash");
   
   if (harness === "pi") {
      return {
         ...config,
         profiles: {
            ...config.profiles,
            [profile]: {
               ...current,
               pi: {
                  ...current.pi,
                  model: cleanModel
               }
            }
         }
      };
   } else {
      return {
         ...config,
         profiles: {
            ...config.profiles,
            [profile]: {
               ...current,
               agy: {
                  ...current.agy,
                  model: cleanModel || "gemini-3.6-flash"
               }
            }
         }
      };
   }
}

export function updateVibeEffort(config: AgentsConfig, profile: "fast" | "good", effort: string): AgentsConfig {
   const current = config.profiles[profile];
   const harness = current.harness;
   const cleanEffort = effort.trim() || null;
   
   if (harness === "pi") {
      return {
         ...config,
         profiles: {
            ...config.profiles,
            [profile]: {
               ...current,
               pi: {
                  ...current.pi,
                  reasoning_effort: cleanEffort as any
               }
            }
         }
      };
   } else {
      const validEffort = cleanEffort === "medium" || cleanEffort === "high" || cleanEffort === "low" ? cleanEffort : "low";
      return {
         ...config,
         profiles: {
            ...config.profiles,
            [profile]: {
               ...current,
               agy: {
                  ...current.agy,
                  reasoning_effort: validEffort
               }
            }
         }
      };
   }
}

test("switchTab toggles between subagents and vibe", () => {
   assert.equal(switchTab("subagents"), "vibe");
   assert.equal(switchTab("vibe"), "subagents");
});

test("nextVibeField and prevVibeField cycle 0-4", () => {
   assert.equal(nextVibeField(0), 1);
   assert.equal(nextVibeField(1), 2);
   assert.equal(nextVibeField(2), 3);
   assert.equal(nextVibeField(3), 4);
   assert.equal(nextVibeField(4), 0);

   assert.equal(prevVibeField(0), 4);
   assert.equal(prevVibeField(1), 0);
   assert.equal(prevVibeField(2), 1);
   assert.equal(prevVibeField(3), 2);
   assert.equal(prevVibeField(4), 3);
});

test("toggleVibeHarness toggles fast/good profile harness", () => {
   let cfg = createDefaultConfig();
   assert.equal(cfg.profiles.fast.harness, "pi");
   cfg = toggleVibeHarness(cfg, "fast");
   assert.equal(cfg.profiles.fast.harness, "agy");
   cfg = toggleVibeHarness(cfg, "fast");
   assert.equal(cfg.profiles.fast.harness, "pi");
});

test("updateVibeModel updates correct harness profile model", () => {
   let cfg = createDefaultConfig();
   cfg = updateVibeModel(cfg, "fast", "claude-3-5-sonnet");
   assert.equal(cfg.profiles.fast.pi.model, "claude-3-5-sonnet");

   cfg = toggleVibeHarness(cfg, "fast"); // now agy
   cfg = updateVibeModel(cfg, "fast", "gemini-3.6-pro");
   assert.equal(cfg.profiles.fast.agy.model, "gemini-3.6-pro");
});

import {
   canSwitchAgentsTab,
   CHILD_TOOL_DENYLIST,
   clampBodyScroll,
   clampSelectorScroll,
   computeMultiLineVisibleWindow,
   ensureCursorVisible,
   filterSelectableTools,
   formatToolsSummary,
   getSelectableTools,
   isCtrlS,
   isSubagentsDirty,
   renderSelectorOptionBlock,
   renderToolOptionBlock,
   SELECT_TOOLS_HELP_UNITS,
   SUBAGENTS_HELP_UNITS,
   toggleToolSelection,
   VIBE_HELP_UNITS,
   visibleBodyWindow,
   visibleSelectorWindow,
   wrapHelpUnits,
   formatAgentListTag,
   renderAgentDescriptionPanel,
   styleAgentListTag
} from "./src/ui/agents.ts";

test("ensureCursorVisible adjusts scrollOffset so cursor remains visible inside viewport", () => {
   // Viewport height 5, total lines 20
   // cursor inside viewport (row 2, offset 0 -> unchanged)
   assert.equal(ensureCursorVisible(0, 2, 5, 20), 0);

   // cursor below viewport (row 6, offset 0 -> scroll increases to 2)
   assert.equal(ensureCursorVisible(0, 6, 5, 20), 2);

   // cursor above viewport (row 3, offset 5 -> scroll decreases to 3)
   assert.equal(ensureCursorVisible(5, 3, 5, 20), 3);

   // clamp at ends (total lines 20, viewport height 5, max offset 15)
   assert.equal(ensureCursorVisible(0, 25, 5, 20), 15);
   assert.equal(ensureCursorVisible(10, -5, 5, 20), 0);
});

test("updateVibeEffort updates correct harness profile reasoning_effort", () => {
   let cfg = createDefaultConfig();
   cfg = updateVibeEffort(cfg, "good", "high");
   assert.equal(cfg.profiles.good.pi.reasoning_effort, "high");

   cfg = toggleVibeHarness(cfg, "good"); // now agy
   cfg = updateVibeEffort(cfg, "good", "medium");
   assert.equal(cfg.profiles.good.agy.reasoning_effort, "medium");
});

test("isCtrlS detects Ctrl+S control char and keybindings", () => {
   assert.equal(isCtrlS("\x13"), true);
   assert.equal(isCtrlS("\u0013"), true);
   assert.equal(isCtrlS(String.fromCharCode(19)), true);
   assert.equal(isCtrlS("s"), false);
   assert.equal(isCtrlS("q"), false);

   const mockKeybindings = {
      matches: (data: string, action: string) => data === "save-key" && action === "save"
   } as any;
   assert.equal(isCtrlS("save-key", mockKeybindings), true);
   assert.equal(isCtrlS("other-key", mockKeybindings), false);
});

test("wrapHelpUnits wraps by whole key units and never mid-unit", () => {
   // Wide width: fits on single line
   const lineWide = wrapHelpUnits(SUBAGENTS_HELP_UNITS, 180);
   assert.equal(lineWide.length, 1);
   assert.equal(
      lineWide[0],
      "Tab/[/]:switch tab · ↑/↓:navigate · Enter/e:edit · Space:toggle · d:delete · PgUp/PgDn:scroll body · n:new · Ctrl+S:save · Esc/q:quit"
   );

   // Narrow width: breaks into multiple lines without breaking mid-unit
   const linesNarrow = wrapHelpUnits(SUBAGENTS_HELP_UNITS, 35);
   assert.ok(linesNarrow.length > 1);
   for (const line of linesNarrow) {
      // Check that no unit is cut in half across lines
      assert.ok(!line.endsWith("Ctrl+S:"));
      assert.ok(!line.endsWith("Esc/q:"));
   }

   // Ensure all units are present across lines
   const reassembled = linesNarrow.join(" · ");
   for (const unit of SUBAGENTS_HELP_UNITS) {
      assert.ok(reassembled.includes(unit));
   }
});

test("clampBodyScroll clamps offset correctly", () => {
   assert.equal(clampBodyScroll(-5, 20, 5), 0);
   assert.equal(clampBodyScroll(0, 20, 5), 0);
   assert.equal(clampBodyScroll(10, 20, 5), 10);
   assert.equal(clampBodyScroll(15, 20, 5), 15);
   assert.equal(clampBodyScroll(18, 20, 5), 15);
   assert.equal(clampBodyScroll(10, 3, 5), 0);
});

test("visibleBodyWindow computes visible window, above and below indicators", () => {
   const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`);

   // Top window
   const resTop = visibleBodyWindow(lines, 0, 5);
   assert.deepEqual(resTop.visible, ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]);
   assert.equal(resTop.above, 0);
   assert.equal(resTop.below, 10);

   // Middle window
   const resMid = visibleBodyWindow(lines, 5, 5);
   assert.deepEqual(resMid.visible, ["Line 6", "Line 7", "Line 8", "Line 9", "Line 10"]);
   assert.equal(resMid.above, 5);
   assert.equal(resMid.below, 5);

   // Bottom window
   const resBot = visibleBodyWindow(lines, 12, 5);
   assert.deepEqual(resBot.visible, ["Line 11", "Line 12", "Line 13", "Line 14", "Line 15"]);
   assert.equal(resBot.above, 10);
   assert.equal(resBot.below, 0);
});

import { BodyEditor, computeCursorRowCol, renderBodyLines } from "./src/ui/agents.ts";

test("BodyEditor preserves newlines, handles editing and cursor movements", () => {
   const editor = new BodyEditor();
   const initialText = "Line 1\nLine 2\nLine 3";
   editor.setValue(initialText);
   assert.equal(editor.getValue(), initialText);

   // Enter inserts a newline
   editor.handleInput("\n");
   assert.equal(editor.getValue(), "Line 1\nLine 2\nLine 3\n");

   // Inserting text preserves previous newlines
   editor.handleInput("Line 4");
   assert.equal(editor.getValue(), "Line 1\nLine 2\nLine 3\nLine 4");

   // Backspace deletes characters
   editor.handleInput("\x7f");
   assert.equal(editor.getValue(), "Line 1\nLine 2\nLine 3\nLine ");
});

test("computeCursorRowCol calculates cursor row and col across wrapping and newlines", () => {
   const body = "1234567890\nabcd";
   // Width 5:
   // Line 0: "12345" (row 0), "67890" (row 1)
   // Line 1: "abcd" (row 2)
   assert.deepEqual(computeCursorRowCol(body, 0, 5), { cursorRow: 0, cursorCol: 0 });
   assert.deepEqual(computeCursorRowCol(body, 5, 5), { cursorRow: 1, cursorCol: 0 });
   assert.deepEqual(computeCursorRowCol(body, 10, 5), { cursorRow: 1, cursorCol: 5 });
   assert.deepEqual(computeCursorRowCol(body, 11, 5), { cursorRow: 2, cursorCol: 0 });
   assert.deepEqual(computeCursorRowCol(body, 15, 5), { cursorRow: 2, cursorCol: 4 });
});

test("renderBodyLines renders visible cursor and title-styled text when editing", () => {
   const mockTheme: any = {
      bold: (s: string) => `[B]${s}[/B]`,
      fg: (color: string, s: string) => `[${color}]${s}[/${color}]`,
      inverse: (s: string) => `[INV]${s}[/INV]`
   };

   const body = "Hello World";
   const lines = renderBodyLines(body, 20, 0, 5, true, 5, mockTheme);

   assert.equal(lines.length, 1);
   // At cursorIndex 5, "Hello" is before, " " at cursor is inverse, "World" is after.
   assert.ok(lines[0].includes("[text][B]Hello[/B][/text]"));
   assert.ok(lines[0].includes("[INV] [/INV]"));
   assert.ok(lines[0].includes("[text][B]World[/B][/text]"));
});

import { isEditDirty, isVibeDirty, styleSaveHelpUnit, renderHelpUnits } from "./src/ui/agents.ts";

test("isEditDirty / isSubagentsDirty returns dirty state correctly", () => {
   const editDef: any = { name: "agent1", description: "desc1", guidance: "g1", body: "b1" };
   const editOriginalSnap: any = { name: "agent1", description: "desc1", guidance: "g1", body: "b1" };
   const editDiff: any = { name: "agent1", description: "desc2", guidance: "g1", body: "b1" };

   // 1. isEditDirty / isSubagentsDirty returns true when isNewUnsaved true
   assert.equal(isEditDirty(editDef, editOriginalSnap, true), true);
   assert.equal(isSubagentsDirty([], [], "edit", editDef, editOriginalSnap, true), true);

   // 2. returns false when snap equals editDef and not new
   assert.equal(isEditDirty(editDef, editOriginalSnap, false), false);
   assert.equal(isSubagentsDirty([], [], "edit", editDef, editOriginalSnap, false), false);

   // 3. returns true when edit differs from snap
   assert.equal(isEditDirty(editDiff, editOriginalSnap, false), true);
   assert.equal(isSubagentsDirty([], [], "edit", editDiff, editOriginalSnap, false), true);
});

test("styleSaveHelpUnit styles save unit as warning/bold when dirty, dim when clean", () => {
   const mockTheme: any = {
      bold: (s: string) => `[B]${s}[/B]`,
      fg: (color: string, s: string) => `[${color}]${s}[/${color}]`
   };

   assert.equal(styleSaveHelpUnit("Ctrl+S:save", true, mockTheme), "[warning][B]Ctrl+S:save[/B][/warning]");
   assert.equal(styleSaveHelpUnit("Ctrl+S:save", false, mockTheme), "[dim]Ctrl+S:save[/dim]");
   assert.equal(styleSaveHelpUnit("Esc/q:quit", true, mockTheme), "[dim]Esc/q:quit[/dim]");
});

test("isSubagentsDirty detects changes in list toggles and edit state", () => {
   const saved: any[] = [{ name: "agent1", enabled: true, body: "prompt1" }];
   const currentClean: any[] = [{ name: "agent1", enabled: true, body: "prompt1" }];
   const currentDirty: any[] = [{ name: "agent1", enabled: false, body: "prompt1" }];

   assert.equal(isSubagentsDirty(saved, currentClean, "list", null, null), false);
   assert.equal(isSubagentsDirty(saved, currentDirty, "list", null, null), true);

   const editSnap: any = { name: "agent1", enabled: true, body: "prompt1" };
   const editClean: any = { name: "agent1", enabled: true, body: "prompt1" };
   const editDirty: any = { name: "agent1", enabled: true, body: "prompt2" };

   assert.equal(isSubagentsDirty(saved, currentClean, "edit", editClean, editSnap), false);
   assert.equal(isSubagentsDirty(saved, currentClean, "edit", editDirty, editSnap), true);
});

test("isVibeDirty detects changes in vibe configuration", () => {
   const savedConfig = createDefaultConfig();
   const currentClean = createDefaultConfig();
   const currentDirty = updateVibeModel(createDefaultConfig(), "fast", "custom-model");

   assert.equal(isVibeDirty(savedConfig, currentClean), false);
   assert.equal(isVibeDirty(savedConfig, currentDirty), true);

   // Tools change in pi profile
   const toolsDirty = createDefaultConfig();
   toolsDirty.profiles.fast.pi.tools = ["read", "bash"];
   assert.equal(isVibeDirty(savedConfig, toolsDirty), true);

   // Body change in agy profile
   const bodyDirty = createDefaultConfig();
   bodyDirty.profiles.good.agy.body = "Custom vibe prompt";
   assert.equal(isVibeDirty(savedConfig, bodyDirty), true);
});

test("renderHelpUnits formats footer units with dirty styling without breaking whole key unit wrapping", () => {
   const mockTheme: any = {
      bold: (s: string) => `[B]${s}[/B]`,
      fg: (color: string, s: string) => `[${color}]${s}[/${color}]`
   };

   const units = ["Tab/[/]:switch tab", "Ctrl+S:save", "Esc/q:quit"];
   const linesDirty = renderHelpUnits(units, 200, true, mockTheme);
   assert.equal(linesDirty.length, 1);
   assert.ok(linesDirty[0].includes("[warning][B]Ctrl+S:save[/B][/warning]"));

   const linesClean = renderHelpUnits(units, 200, false, mockTheme);
   assert.equal(linesClean.length, 1);
   assert.ok(linesClean[0].includes("[dim]Ctrl+S:save[/dim]"));
});

import { normalizeGeneratedBody, parseGenerationResponse } from "./src/ui/agents.ts";

test("parseGenerationResponse with body containing real \\n sections keeps them", () => {
   const json = JSON.stringify({
      display_name: "Explorer",
      description: "Code explorer",
      guidance: "Use for exploration",
      body: "# EXPLORE AGENT\n\nYou explore codebases.\n\n## Role\nReadOnly explorer."
   });
   const parsed = parseGenerationResponse(json);
   assert.equal(parsed?.body, "# EXPLORE AGENT\n\nYou explore codebases.\n\n## Role\nReadOnly explorer.");
});

test("normalizeGeneratedBody converts double-escaped \\n to real newlines", () => {
   const doubleEscaped = "# EXPLORE AGENT\\n\\nYou explore codebases.\\n\\n## Role\\nReadOnly explorer.";
   const normalized = normalizeGeneratedBody(doubleEscaped);
   assert.equal(normalized, "# EXPLORE AGENT\n\nYou explore codebases.\n\n## Role\nReadOnly explorer.");
});

test("normalizeGeneratedBody inserts breaks before ## headers if jammed into one line", () => {
   const jammed = "# EXPLORE AGENT You explore codebases.## Role ReadOnly explorer.## Workflow 1. Search";
   const normalized = normalizeGeneratedBody(jammed);
   assert.equal(
      normalized,
      "# EXPLORE AGENT You explore codebases.\n\n## Role ReadOnly explorer.\n\n## Workflow 1. Search"
   );
});

test("parseGenerationResponse extracts fields from clean JSON or markdown code block JSON", () => {
   const cleanJson = JSON.stringify({
      display_name: "Code Reviewer",
      description: "Reviews code for bugs and style",
      guidance: "Use this agent when reviewing PRs",
      body: "# REVIEWER AGENT\n\nYou review code."
   });
   const parsed1 = parseGenerationResponse(cleanJson);
   assert.deepEqual(parsed1, {
      display_name: "Code Reviewer",
      description: "Reviews code for bugs and style",
      guidance: "Use this agent when reviewing PRs",
      body: "# REVIEWER AGENT\n\nYou review code."
   });

   const markdownJson = `\`\`\`json\n${cleanJson}\n\`\`\``;
   const parsed2 = parseGenerationResponse(markdownJson);
   assert.deepEqual(parsed2, parsed1);

   assert.equal(parseGenerationResponse("invalid json text"), null);
   assert.equal(parseGenerationResponse(""), null);
});

test("isSubagentsDirty clears after updating editOriginalSnap to match editDef", () => {
   const saved: any[] = [];
   const current: any[] = [];
   const editDef: any = { name: "agent1", description: "desc", guidance: "guide", harness: "pi", body: "body" };
   let editOriginalSnap: any = { name: "agent1", description: "old desc", guidance: "guide", harness: "pi", body: "body" };

   // Before save (edited field makes it dirty)
   assert.equal(isSubagentsDirty(saved, current, "edit", editDef, editOriginalSnap), true);

   // After save, editOriginalSnap is updated to match editDef
   editOriginalSnap = JSON.parse(JSON.stringify(editDef));
   assert.equal(isSubagentsDirty(saved, current, "edit", editDef, editOriginalSnap), false);
});

import {
   computeFrontmatterLinesCount,
   filterSelectorOptions,
   getBaseSelectorOptions,
   renderWrappedFieldLines
} from "./src/ui/agents.ts";

const dummyTheme: any = {
   fg: (_color: string, str: string) => str,
   bold: (str: string) => str,
   inverse: (str: string) => str
};

test("renderWrappedFieldLines wraps long text and caps max lines with overflow indicator", () => {
   const longText = "Line one long text that wraps across multiple lines when rendered in a constrained width container.";
   // Width = 40, prefix "❯ Description: " = 15 chars, availWidth = 25 chars
   const lines = renderWrappedFieldLines({
      label: "Description",
      val: longText,
      isSelected: true,
      isEditingText: false,
      width: 40,
      theme: dummyTheme,
      maxWrappedLines: 2
   });

   // Height capped to 2 content lines + 1 overflow indicator line
   assert.equal(lines.length, 3);
   assert.ok(lines[0].startsWith("❯ Description: "));
   assert.ok(lines[2].includes("… +"));
});

test("getBaseSelectorOptions builds model and thinking options for pi and agy harnesses", () => {
   // Model - pi (with registry)
   const mockRegistry = {
      getAvailable: () => [
         { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "anthropic" },
         { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
         { id: "cfai/@cf/moonshotai/kimi-k2.7-code", name: "Kimi K2.7", provider: "proxy" },
         { id: "anthropic/claude-3-7-sonnet", name: "Claude 3.7", provider: "anthropic" }
      ]
   };
   const piModelOpts = getBaseSelectorOptions("model", "pi", mockRegistry);
   assert.equal(piModelOpts[0].label, "(inherit parent)");
   assert.equal(piModelOpts[0].value, "");
   assert.equal(piModelOpts[1].value, "anthropic/claude-3-5-sonnet");
   assert.equal(piModelOpts[2].value, "google/gemini-2.5-pro");
   assert.equal(piModelOpts[3].value, "proxy/cfai/@cf/moonshotai/kimi-k2.7-code");
   assert.equal(piModelOpts[3].label, "Kimi K2.7 (proxy/cfai/@cf/moonshotai/kimi-k2.7-code)");
   assert.equal(piModelOpts[4].value, "anthropic/claude-3-7-sonnet");

   // Model - agy
   const agyModelOpts = getBaseSelectorOptions("model", "agy");
   assert.equal(agyModelOpts[0].label, "(inherit parent)");
   assert.ok(agyModelOpts.some((opt) => opt.value === "gemini-3.6-flash"));
   assert.ok(agyModelOpts.some((opt) => opt.value === "gemini-3.6-flash-low"));

   // Thinking - pi
   const piThinkingOpts = getBaseSelectorOptions("thinking", "pi");
   assert.equal(piThinkingOpts[0].label, "(inherit parent)");
   assert.ok(piThinkingOpts.some((opt) => opt.value === "high"));
   assert.ok(piThinkingOpts.some((opt) => opt.value === "xhigh"));

   // Thinking - agy
   const agyThinkingOpts = getBaseSelectorOptions("thinking", "agy");
   assert.equal(agyThinkingOpts[0].label, "(inherit parent)");
   assert.deepEqual(
      agyThinkingOpts.map((o) => o.value),
      ["", "low", "medium", "high"]
   );
});

test("filterSelectorOptions filters and appends custom option when no exact match", () => {
   const base = [
      { label: "(inherit parent)", value: "" },
      { label: "claude-3-5-sonnet", value: "anthropic/claude-3-5-sonnet" },
      { label: "gpt-4o", value: "openai/gpt-4o" }
   ];

   // Empty query -> returns base options as is
   assert.deepEqual(filterSelectorOptions(base, ""), base);

   // Query matching existing option
   const filtered1 = filterSelectorOptions(base, "claude");
   assert.equal(filtered1.length, 2);
   assert.equal(filtered1[0].value, "anthropic/claude-3-5-sonnet");
   assert.equal(filtered1[1].value, "claude");
   assert.equal(filtered1[1].label, 'Custom: "claude"');

   // Query matching exact value -> no custom option added
   const filtered2 = filterSelectorOptions(base, "anthropic/claude-3-5-sonnet");
   assert.equal(filtered2.length, 1);
   assert.equal(filtered2[0].value, "anthropic/claude-3-5-sonnet");
});

test("computeFrontmatterLinesCount counts lines accurately", () => {
   const def: any = {
      display_name: "Test Agent",
      description: "Short desc",
      guidance: "Short guide",
      model: "claude-3-5-sonnet",
      thinking: "high",
      tools: ["read", "bash"],
      harness: "pi"
   };

   const count = computeFrontmatterLinesCount(def, 0, false, 80, dummyTheme);
   // 7 fields, each 1 line = 7
   assert.equal(count, 7);
});

test("CHILD_TOOL_DENYLIST includes all orchestration tools", () => {
   const expectedDenylist = [
      "task_spawn",
      "task_spawn_batch",
      "task_wait",
      "task_cancel",
      "task_check",
      "task_list",
      "vibe_spawn",
      "vibe_send",
      "vibe_wait",
      "vibe_kill",
      "vibe_list",
      "workflow",
      "ask_user"
   ];
   for (const tool of expectedDenylist) {
      assert.ok(CHILD_TOOL_DENYLIST.includes(tool));
   }
});

test("getSelectableTools filters out denylisted tools", () => {
   const allTools = [
      { name: "read", description: "Read file" },
      { name: "task_spawn", description: "Spawn task" },
      { name: "bash", description: "Run bash command" },
      { name: "vibe_spawn", description: "Spawn vibe" },
      { name: "ask_user", description: "Ask user" }
   ];
   const selectable = getSelectableTools(allTools);
   assert.deepEqual(
      selectable.map((t) => t.name),
      ["read", "bash"]
   );
});

test("toggleToolSelection handles toggle on undefined and existing lists", () => {
   assert.deepEqual(toggleToolSelection(undefined, "read"), ["read"]);
   assert.deepEqual(toggleToolSelection(["read", "bash"], "read"), ["bash"]);
   assert.deepEqual(toggleToolSelection(["bash"], "read"), ["bash", "read"]);
});

test("formatToolsSummary formats tool counts cleanly", () => {
   assert.equal(formatToolsSummary(undefined), "(inherit all)");
   assert.equal(formatToolsSummary([]), "(inherit all)");
   assert.equal(formatToolsSummary(["read"]), "read");
   assert.equal(formatToolsSummary(["read", "bash", "grep"]), "read, bash, grep");
   assert.equal(formatToolsSummary(["read", "bash", "grep", "edit", "write"]), "read, bash, grep (+2 more)");
});

test("filterSelectableTools filters tools by name and description", () => {
   const tools = [
      { name: "read", description: "Read content from disk" },
      { name: "bash", description: "Execute shell command" },
      { name: "grep_search", description: "Search files using ripgrep" }
   ];
   assert.deepEqual(
      filterSelectableTools(tools, "").map((t) => t.name),
      ["read", "bash", "grep_search"]
   );
   assert.deepEqual(
      filterSelectableTools(tools, "shell").map((t) => t.name),
      ["bash"]
   );
   assert.deepEqual(
      filterSelectableTools(tools, "GREP").map((t) => t.name),
      ["grep_search"]
   );
});

test("isSubagentsDirty detects tool changes and select_tools view state", () => {
   const original: any = { name: "scout", tools: ["read", "bash"], harness: "pi" };
   const edited: any = { name: "scout", tools: ["read", "bash", "grep"], harness: "pi" };

   // Same tools -> clean
   assert.equal(isSubagentsDirty([], [], "edit", original, JSON.parse(JSON.stringify(original))), false);

   // Different tools in edit state -> dirty
   assert.equal(isSubagentsDirty([], [], "edit", edited, original), true);

   // Different tools in select_tools viewState -> dirty
   assert.equal(isSubagentsDirty([], [], "select_tools", edited, original), true);
});

test("clampSelectorScroll clamps offset with 3 or 4 arguments", () => {
   // 3 args: clampSelectorScroll(offset, totalItems, viewportHeight)
   assert.equal(clampSelectorScroll(-5, 20, 5), 0);
   assert.equal(clampSelectorScroll(0, 20, 5), 0);
   assert.equal(clampSelectorScroll(10, 20, 5), 10);
   assert.equal(clampSelectorScroll(18, 20, 5), 15);
   assert.equal(clampSelectorScroll(5, 3, 5), 0);

   // 4 args: clampSelectorScroll(offset, selectedIndex, totalItems, viewportHeight)
   // Selected index inside viewport -> offset unchanged
   assert.equal(clampSelectorScroll(0, 2, 20, 5), 0);
   // Selected index below viewport (selected 7, viewport 0..4) -> scroll down to 3
   assert.equal(clampSelectorScroll(0, 7, 20, 5), 3);
   // Selected index above viewport (selected 2, viewport 5..9) -> scroll up to 2
   assert.equal(clampSelectorScroll(5, 2, 20, 5), 2);
   // Clamps max scroll when selected index is near the bottom
   assert.equal(clampSelectorScroll(0, 19, 20, 5), 15);
   // Clamps selected index out of bounds
   assert.equal(clampSelectorScroll(10, -5, 20, 5), 0);
   assert.equal(clampSelectorScroll(0, 25, 20, 5), 15);
});

test("visibleSelectorWindow computes visible option slice and indicators", () => {
   const tools = Array.from({ length: 15 }, (_, i) => ({ name: `tool_${i + 1}`, description: `Desc ${i + 1}` }));

   // Offset 0, viewport 5 -> items 0..4, 0 above, 10 below
   const window0 = visibleSelectorWindow(tools, 0, 5);
   assert.equal(window0.startIndex, 0);
   assert.equal(window0.above, 0);
   assert.equal(window0.below, 10);
   assert.deepEqual(
      window0.visible.map((t) => t.name),
      ["tool_1", "tool_2", "tool_3", "tool_4", "tool_5"]
   );

   // Offset 5, viewport 5 -> items 5..9, 5 above, 5 below
   const window5 = visibleSelectorWindow(tools, 5, 5);
   assert.equal(window5.startIndex, 5);
   assert.equal(window5.above, 5);
   assert.equal(window5.below, 5);
   assert.deepEqual(
      window5.visible.map((t) => t.name),
      ["tool_6", "tool_7", "tool_8", "tool_9", "tool_10"]
   );

   // Empty list -> empty visible
   const emptyWindow = visibleSelectorWindow([], 0, 5);
   assert.deepEqual(emptyWindow, { visible: [], startIndex: 0, above: 0, below: 0 });
});

import {
   assembleManagerFrame,
   computeManagerContentBudget,
   computeSelectorViewport,
   fixedFrameLines,
   padLineToWidth
} from "./src/ui/agents.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

test("padLineToWidth pads short lines and truncates long lines to exact visual width", () => {
   // Short plain string -> padded to width
   const padded = padLineToWidth("hello", 10);
   assert.equal(visibleWidth(padded), 10);
   assert.equal(padded, "hello     ");

   // Long plain string -> truncated to width
   const truncated = padLineToWidth("hello world long text", 10);
   assert.equal(visibleWidth(truncated), 10);

   // String with ANSI codes -> padded based on visible width
   const ansiStr = "\x1b[31mred\x1b[0m";
   const paddedAnsi = padLineToWidth(ansiStr, 8);
   assert.equal(visibleWidth(paddedAnsi), 8);
   assert.equal(paddedAnsi, "\x1b[31mred\x1b[0m     ");

   // Empty string -> spaces to width
   const emptyPadded = padLineToWidth("", 5);
   assert.equal(visibleWidth(emptyPadded), 5);
   assert.equal(emptyPadded, "     ");
});

test("padLineToWidth hard-truncates without ellipsis dots", () => {
   const truncated = padLineToWidth("abcdefghijklmnop", 10);
   // Visible width is exact and no ellipsis characters are emitted.
   assert.equal(visibleWidth(truncated), 10);
   assert.ok(!truncated.includes("..."));
   assert.ok(!truncated.includes("…"));
});

test("computeSelectorViewport allocates fixed content budget and list region without overflow", () => {
   const helpUnits = ["↑/↓:navigate", "Space:toggle", "Enter:confirm", "Esc:cancel"];

   // Terminal rows = 30, width = 80
   // managerHeader = 3, wrappedHelp length = 1, footer = 3
   // contentBudget = 30 - 3 - 3 = 24
   // selectorOverhead = 5
   // listBudget = 19
   const resSmall = computeSelectorViewport(30, 80, helpUnits, 10, 0, 0);
   assert.equal(resSmall.contentBudget, 24);
   assert.equal(resSmall.listBudget, 19);
   assert.equal(resSmall.viewportHeight, 19);

   // When totalItems > listBudget and both above and below indicators are active:
   // offset = 5, selectedIndex = 7, totalItems = 30, listBudget = 19
   // viewportHeight should reserve 2 lines for above and below indicators -> 17
   const resLarge = computeSelectorViewport(30, 80, helpUnits, 30, 5, 7);
   assert.equal(resLarge.contentBudget, 24);
   assert.equal(resLarge.listBudget, 19);
   assert.equal(resLarge.viewportHeight, 17);
});

test("fixedFrameLines returns exactly termRows lines all padded to width", () => {
   const termRows = 30;
   const width = 40;
   const expectedHeight = termRows; // 30

   // Case 1: Short input content -> padded to expectedHeight
   const shortContent = ["header", "content1", "content2"];
   const framedShort = fixedFrameLines(shortContent, termRows, width);
   assert.equal(framedShort.length, expectedHeight);
   for (const line of framedShort) {
      assert.equal(visibleWidth(line), width);
   }
   assert.equal(framedShort[0], "header                                  ");
   assert.equal(framedShort[1], "content1                                ");
   assert.equal(framedShort[2], "content2                                ");
   assert.equal(framedShort[3], "                                        ");

   // Case 2: Long input content -> truncated to expectedHeight
   const longContent = Array.from({ length: 50 }, (_, i) => `line ${i}`);
   const framedLong = fixedFrameLines(longContent, termRows, width);
   assert.equal(framedLong.length, expectedHeight);
   for (const line of framedLong) {
      assert.equal(visibleWidth(line), width);
   }
   assert.equal(framedLong[0], "line 0                                  ");
   assert.equal(framedLong[expectedHeight - 1], `line ${expectedHeight - 1}                                 `);
});

const mockTheme = {
   fg: (_color: string, text: string) => text,
   bg: (_color: string, text: string) => text,
   bold: (text: string) => text,
   dim: (text: string) => text,
   inverse: (text: string) => text
} as any;

test("renderToolOptionBlock wraps long description to multiple lines with indentation and no ellipsis", () => {
   const tool = {
      name: "read",
      description: "Read file contents. Supports line ranges and continues wrapping cleanly across multiple lines."
   };
   const width = 45;
   const lines = renderToolOptionBlock(tool, { selected: true, checked: true, width, theme: mockTheme });

   // 1. Long description produces multiple lines
   assert.ok(lines.length > 1, `expected multiple lines, got ${lines.length}`);

   // 2. First line includes cursor, checkbox, tool name, separator, and start of description
   assert.ok(lines[0].startsWith("❯ [✓] read - Read file contents."));

   // 3. Continuation lines are indented under description start (prefix width = 13)
   const indent13 = " ".repeat(13);
   assert.ok(lines[1].startsWith(indent13), `expected line 1 to start with 13 spaces, got: ${JSON.stringify(lines[1])}`);

   // 4. No ellipsis dots in output lines
   for (const line of lines) {
      assert.ok(!line.includes("..."), `line contains '...': ${line}`);
      assert.ok(!line.includes("…"), `line contains '…': ${line}`);
      // 5. Width of each line <= width (visibleWidth)
      assert.ok(visibleWidth(line) <= width, `visible width ${visibleWidth(line)} > ${width}`);
   }
});

test("renderToolOptionBlock handles narrow width by putting description on next indented lines", () => {
   const tool = {
      name: "very_long_tool_name_identifier",
      description: "Executes something very long."
   };
   const width = 30;
   const lines = renderToolOptionBlock(tool, { selected: false, checked: false, width, theme: mockTheme });

   assert.ok(lines.length > 1);
   assert.equal(lines[0], "  [ ] very_long_tool_name_identifier");
   const indent6 = " ".repeat(6);
   assert.ok(lines[1].startsWith(indent6));
   for (const line of lines) {
      assert.ok(!line.includes("..."));
      assert.ok(!line.includes("…"));
   }
});

test("computeMultiLineVisibleWindow calculates multi-line viewport scrolling and respects listBudget", () => {
   const heights = [2, 3, 4, 2, 3];
   const listBudget = 10;

   const win0 = computeMultiLineVisibleWindow(heights, listBudget, 0, 0);
   assert.equal(win0.startIndex, 0);
   assert.equal(win0.endIndex, 3);
   assert.equal(win0.aboveCount, 0);
   assert.equal(win0.belowCount, 2);

   const win3 = computeMultiLineVisibleWindow(heights, listBudget, 0, 3);
   assert.equal(win3.startIndex, 2);
   assert.equal(win3.endIndex, 5);
   assert.equal(win3.aboveCount, 2);
   assert.equal(win3.belowCount, 0);
   assert.ok(3 >= win3.startIndex && 3 < win3.endIndex);
});

import type { AgentDefinition } from "./src/agents/types.ts";

test("formatAgentListTag returns built-in, override, or empty for user agents", () => {
   const pureBuiltin: AgentDefinition = {
      name: "scout",
      description: "Built-in scout",
      harness: "pi",
      enabled: true,
      body: "# body",
      source: "builtin"
   };
   assert.equal(formatAgentListTag(pureBuiltin), "[built-in]");

   const override: AgentDefinition = {
      name: "scout",
      description: "Overridden scout",
      harness: "pi",
      enabled: true,
      body: "# body",
      source: "builtin",
      filePath: "C:/tmp/agents/scout.md"
   };
   assert.equal(formatAgentListTag(override), "[built-in] (override)");

   const userAgent: AgentDefinition = {
      name: "my-agent",
      description: "Custom agent",
      harness: "pi",
      enabled: true,
      body: "# body",
      source: "user",
      filePath: "C:/tmp/agents/my-agent.md"
   };
   assert.equal(formatAgentListTag(userAgent), "");

   const userNoSource: AgentDefinition = {
      name: "custom",
      description: "Custom",
      harness: "pi",
      enabled: true,
      body: "# body"
   };
   assert.equal(formatAgentListTag(userNoSource), "");
});

test("formatAgentListTag treats builtin name with filePath as override even if source missing", () => {
   const overrideNoSource: AgentDefinition = {
      name: "task",
      description: "Task override",
      harness: "pi",
      enabled: true,
      body: "# body",
      filePath: "/agents/task.md"
   };
   assert.equal(formatAgentListTag(overrideNoSource), "[built-in] (override)");
});

test("styleAgentListTag colors pure built-in dim and override warning", () => {
   const themed = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => text
   } as any;

   const pureBuiltin: AgentDefinition = {
      name: "scout",
      description: "Built-in scout",
      harness: "pi",
      enabled: true,
      body: "# body",
      source: "builtin"
   };
   assert.equal(styleAgentListTag(pureBuiltin, themed), "[dim][built-in][/dim]");

   const override: AgentDefinition = {
      name: "scout",
      description: "Overridden scout",
      harness: "pi",
      enabled: true,
      body: "# body",
      source: "builtin",
      filePath: "C:/tmp/agents/scout.md"
   };
   assert.equal(
      styleAgentListTag(override, themed),
      "[dim][built-in] [/dim][warning](override)[/warning]"
   );

   const userAgent: AgentDefinition = {
      name: "my-agent",
      description: "Custom agent",
      harness: "pi",
      enabled: true,
      body: "# body",
      source: "user",
      filePath: "C:/tmp/agents/my-agent.md"
   };
   assert.equal(styleAgentListTag(userAgent, themed), "");
});

test("renderAgentDescriptionPanel shows separator, label, and wrapped description", () => {
   const desc =
      "MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches.";
   const lines = renderAgentDescriptionPanel(desc, 40, mockTheme, 3);

   assert.ok(lines[0].includes("─"));
   assert.equal(lines[1], "Description");
   assert.ok(lines.length >= 3);
   // Description body starts after label
   assert.ok(lines[2].length > 0);
   // No inline list-row style
   for (const line of lines) {
      assert.ok(!line.includes("[ON]"));
      assert.ok(!line.includes("[OFF]"));
   }
});

test("renderAgentDescriptionPanel falls back when description empty", () => {
   const lines = renderAgentDescriptionPanel("", 40, mockTheme, 2);
   assert.ok(lines.some((l) => l.includes("No description")));
});

test("canSwitchAgentsTab only allows switch on subagents list or any vibe view", () => {
   // Subagents list -> allow
   assert.equal(canSwitchAgentsTab("subagents", "list"), true);

   // Subagents non-list views -> block
   assert.equal(canSwitchAgentsTab("subagents", "edit"), false);
   assert.equal(canSwitchAgentsTab("subagents", "select_tools"), false);
   assert.equal(canSwitchAgentsTab("subagents", "select_model"), false);
   assert.equal(canSwitchAgentsTab("subagents", "select_thinking"), false);
   assert.equal(canSwitchAgentsTab("subagents", "create_name"), false);
   assert.equal(canSwitchAgentsTab("subagents", "create_intent"), false);
   assert.equal(canSwitchAgentsTab("subagents", "generating"), false);

   // Vibe always allows (including vibe selectors)
   assert.equal(canSwitchAgentsTab("vibe", "list"), true);
   assert.equal(canSwitchAgentsTab("vibe", "select_vibe_model"), true);
   assert.equal(canSwitchAgentsTab("vibe", "select_vibe_thinking"), true);
});

test("list contentBudget + header + footer equals termRows (header never clipped)", () => {
   const termRows = 30;
   const width = 80;
   const managerHeader = 3;
   const wrappedHelp = wrapHelpUnits(SUBAGENTS_HELP_UNITS, width);
   const footerLinesCount = 2 + wrappedHelp.length;
   const contentBudget = Math.max(1, termRows - managerHeader - footerLinesCount);

   // Full frame = header + content + footer
   const total = managerHeader + contentBudget + footerLinesCount;
   assert.equal(total, termRows);

   // Description panel must fit inside contentBudget with room for at least 1 list row
   const descPanel = renderAgentDescriptionPanel("A short description", width, mockTheme, 4);
   const panelBlock = ["", ...descPanel];
   assert.ok(panelBlock.length < contentBudget, "panel must leave room for list rows");
   assert.ok(contentBudget - panelBlock.length >= 1);
});

test("updateVibeModel / updateVibeEffort match selector confirm write-back semantics", () => {
   // pi: empty string -> null (inherit)
   let cfg = createDefaultConfig();
   cfg = updateVibeModel(cfg, "fast", "");
   assert.equal(cfg.profiles.fast.pi.model, null);
   cfg = updateVibeModel(cfg, "fast", "anthropic/claude-3-5-sonnet");
   assert.equal(cfg.profiles.fast.pi.model, "anthropic/claude-3-5-sonnet");

   cfg = updateVibeEffort(cfg, "fast", "");
   assert.equal(cfg.profiles.fast.pi.reasoning_effort, null);
   cfg = updateVibeEffort(cfg, "fast", "high");
   assert.equal(cfg.profiles.fast.pi.reasoning_effort, "high");

   // agy: empty model -> default flash; invalid effort -> low
   cfg = toggleVibeHarness(cfg, "good");
   cfg = updateVibeModel(cfg, "good", "");
   assert.equal(cfg.profiles.good.agy.model, "gemini-3.6-flash");
   cfg = updateVibeEffort(cfg, "good", "not-valid");
   assert.equal(cfg.profiles.good.agy.reasoning_effort, "low");
   cfg = updateVibeEffort(cfg, "good", "medium");
   assert.equal(cfg.profiles.good.agy.reasoning_effort, "medium");
});

test("assembleManagerFrame pins header and footer; length === termRows", () => {
   const termRows = 24;
   const width = 40;
   const expectedHeight = termRows;

   const header = [
      "────────────────────────────────────────",
      " Agents Manager  [ Subagents ]  [ Vibe ]",
      "────────────────────────────────────────"
   ];
   const footer = ["────────────────────────────────────────", "Tab · Esc/q:quit", "────────────────────────────────────────"];
   const content = Array.from({ length: 50 }, (_, i) => `agent-row-${i}`);

   const frame = assembleManagerFrame({ header, content, footer, termRows, width });

   assert.equal(frame.length, expectedHeight);
   for (const line of frame) {
      assert.equal(visibleWidth(line), width);
   }

   // First 3 lines are header (title present)
   assert.ok(frame[0].includes("─"));
   assert.ok(frame[1].includes("Agents Manager"));
   assert.ok(frame[1].includes("[ Subagents ]"));
   assert.ok(frame[1].includes("[ Vibe ]"));
   assert.ok(frame[2].includes("─"));

   // Last lines are footer help
   assert.ok(frame[expectedHeight - 1].includes("─"));
   assert.ok(frame[expectedHeight - 2].includes("Esc/q:quit"));
   assert.ok(frame[expectedHeight - 3].includes("─"));

   // Content is in the middle only (oversized content truncated, not header)
   assert.ok(frame[3].includes("agent-row-0"));
});

test("assembleManagerFrame oversized content still preserves header and footer", () => {
   const termRows = 12;
   const width = 30;
   const header = ["H1", " Agents Manager  [ Subagents ]  [ Vibe ]", "H3"];
   const footer = ["F1", "help line", "F3"];
   // Content much larger than available middle
   const content = Array.from({ length: 100 }, (_, i) => `C${i}`);

   const frame = assembleManagerFrame({ header, content, footer, termRows, width });
   const expectedHeight = termRows; // 12
   // header 3 + footer 3 + content budget 6 = 12
   assert.equal(frame.length, expectedHeight);
   assert.ok(frame[0].startsWith("H1"));
   assert.ok(frame[1].includes("Agents Manager"));
   assert.ok(frame[2].startsWith("H3"));
   assert.ok(frame[expectedHeight - 3].startsWith("F1"));
   assert.ok(frame[expectedHeight - 2].includes("help line"));
   assert.ok(frame[expectedHeight - 1].startsWith("F3"));
   // Content squeezed to middle only
   assert.ok(frame[3].includes("C0"));
   assert.equal(frame.length, header.length + (expectedHeight - header.length - footer.length) + footer.length);
});

test("list content budget math: header + contentBudget + footer === termRows", () => {
   for (const termRows of [20, 30, 40, 12]) {
      for (const width of [40, 80, 120]) {
         const footerLinesCount = 2 + wrapHelpUnits(SUBAGENTS_HELP_UNITS, width).length;
         const contentBudget = computeManagerContentBudget(termRows, footerLinesCount);
         assert.equal(3 + contentBudget + footerLinesCount, termRows);
      }
   }
});
