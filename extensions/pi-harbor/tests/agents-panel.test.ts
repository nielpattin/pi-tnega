import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../src/domain.js";
import {
   buildAgentsPanelViewModel,
   createAgentsPanelState,
   detailFieldsFor,
   getSelectedDescription,
   reduceAgentsPanelKey,
   renderAgentDescriptionPanel,
   vibeProfileToAgentDefinition,
   agentDefinitionToVibeProfile,
   agentDisplayTags
} from "../src/ui/agents-panel.js";

const sampleAgents: AgentDefinition[] = [
   {
      name: "scout",
      display_name: "scout",
      description: "Read-only research",
      tools: ["read"],
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: "# SCOUT"
   },
   {
      name: "task",
      display_name: "task",
      description: "Implementation worker",
      tools: ["read", "write"],
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: "# TASK"
   },
   {
      name: "high-task",
      display_name: "high-task",
      description: "Specialized worker",
      tools: ["read", "write"],
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: "# HIGH-TASK"
   },
   {
      name: "reviewer",
      display_name: "reviewer",
      description: "Code reviewer",
      tools: ["read"],
      harness: "pi",
      enabled: true,
      source: "builtin",
      body: "# REVIEWER"
   }
];

const sampleVibeProfiles = {
   fast: {
      harness: "pi" as const,
      pi: { model: "kimi-k2.7", reasoning_effort: "low", tools: ["read", "write"] }
   },
   good: {
      harness: "pi" as const,
      pi: { model: "gpt-5.6-sol", reasoning_effort: "high", tools: ["read", "write"] }
   }
};

const theme = {
   fg: (_color: string, text: string) => text,
   bold: (text: string) => text
} as any;

describe("Agents Panel Pure View Model & State", () => {
   it("builds unified list with agents then vibe profiles tagged [vibe]", () => {
      const vm = buildAgentsPanelViewModel({
         agents: sampleAgents,
         vibeProfiles: sampleVibeProfiles
      });

      expect(vm.agents.map((a) => a.name)).toEqual([
         "scout",
         "task",
         "high-task",
         "reviewer",
         "fast",
         "good"
      ]);
      expect(vm.agents.filter((a) => a.kind === "vibe").map((a) => a.name)).toEqual(["fast", "good"]);
      expect(vm.vibeProfiles.fast.pi?.model).toBe("kimi-k2.7");
      expect(vm.vibeProfiles.good.pi?.model).toBe("gpt-5.6-sol");
   });

   it("creates default list state without section tabs", () => {
      const state = createAgentsPanelState();
      expect(state.viewMode).toBe("list");
      expect(state.selectedIndex).toBe(0);
      expect(state.detailFieldIndex).toBe(0);
      expect(state.isOpen).toBe(true);
      expect((state as any).selectedSection).toBeUndefined();
   });

   it("navigates selection down and up across unified list with wrapping", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "down" }, vm));
      expect(state.selectedIndex).toBe(1);

      ({ state } = reduceAgentsPanelKey(state, { key: "j" }, vm));
      expect(state.selectedIndex).toBe(2);

      ({ state } = reduceAgentsPanelKey(state, { key: "up" }, vm));
      expect(state.selectedIndex).toBe(1);

      ({ state } = reduceAgentsPanelKey(state, { key: "k" }, vm));
      expect(state.selectedIndex).toBe(0);

      // Up from top wraps to last item (good, index 5)
      ({ state } = reduceAgentsPanelKey(state, { key: "k" }, vm));
      expect(state.selectedIndex).toBe(5);
      expect(vm.agents[state.selectedIndex]?.kind).toBe("vibe");
      expect(vm.agents[state.selectedIndex]?.name).toBe("good");

      // Down from bottom wraps to first item
      ({ state } = reduceAgentsPanelKey(state, { key: "j" }, vm));
      expect(state.selectedIndex).toBe(0);
   });

   it("Tab does not switch sections (no dual tabs)", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "tab" }, vm));
      expect(state.selectedIndex).toBe(0);
      expect(state.viewMode).toBe("list");
   });

   it("Enter opens detail and Esc returns to list", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "enter" }, vm));
      expect(state.viewMode).toBe("detail");
      expect(state.detailFieldIndex).toBe(0);
      expect(state.isOpen).toBe(true);

      ({ state } = reduceAgentsPanelKey(state, { key: "escape" }, vm));
      expect(state.viewMode).toBe("list");
      expect(state.isOpen).toBe(true);
   });

   it("detail fields are navigable with up/down for regular agents and vibe", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "enter" }, vm));
      const scout = vm.agents[0];
      expect(detailFieldsFor(scout)).toEqual([
         "name",
         "enabled",
         "harness",
         "model",
         "thinking",
         "tools",
         "description",
         "body"
      ]);
      expect(detailFieldsFor(scout, "agy")).toEqual([
         "name",
         "enabled",
         "harness",
         "model",
         "description",
         "body"
      ]);

      ({ state } = reduceAgentsPanelKey(state, { key: "down" }, vm));
      expect(state.detailFieldIndex).toBe(1);
      expect(detailFieldsFor(scout)[state.detailFieldIndex]).toBe("enabled");

      // Navigate to vibe (fast = index 4) and open detail
      ({ state } = reduceAgentsPanelKey(state, { key: "escape" }, vm));
      state = { ...state, selectedIndex: 4 };
      ({ state } = reduceAgentsPanelKey(state, { key: "enter" }, vm));
      const fast = vm.agents[4];
      expect(fast.kind).toBe("vibe");
      // Vibe has no rename field
      expect(detailFieldsFor(fast)).toEqual([
         "enabled",
         "harness",
         "model",
         "thinking",
         "tools",
         "description",
         "body"
      ]);
      expect(detailFieldsFor(fast, "agy")).toEqual(["enabled", "harness", "model", "description", "body"]);

      // Up from index 0 wraps to last field for vibe (body = 6)
      let vibeState = createAgentsPanelState({ selectedIndex: 4, viewMode: "detail", detailFieldIndex: 0 });
      ({ state: vibeState } = reduceAgentsPanelKey(vibeState, { key: "up" }, vm));
      expect(vibeState.detailFieldIndex).toBe(6);
      ({ state: vibeState } = reduceAgentsPanelKey(vibeState, { key: "down" }, vm));
      expect(vibeState.detailFieldIndex).toBe(0);

      // Up from index 0 wraps to last field for agents (body = 7)
      let agentState = createAgentsPanelState({ selectedIndex: 0, viewMode: "detail", detailFieldIndex: 0 });
      ({ state: agentState } = reduceAgentsPanelKey(agentState, { key: "up" }, vm));
      expect(agentState.detailFieldIndex).toBe(7);
      ({ state: agentState } = reduceAgentsPanelKey(agentState, { key: "down" }, vm));
      expect(agentState.detailFieldIndex).toBe(0);
   });

   it("space/enter on detail field emits edit intents", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "enter" }, vm));
      ({ state } = reduceAgentsPanelKey(state, { key: "down" }, vm));
      const enabled = reduceAgentsPanelKey(state, { key: " " }, vm);
      expect(enabled.intent).toEqual({ type: "toggle_enabled" });

      ({ state } = reduceAgentsPanelKey(state, { key: "down" }, vm));
      const harness = reduceAgentsPanelKey(state, { key: "enter" }, vm);
      expect(harness.intent).toEqual({ type: "cycle_harness" });
   });

   it("Esc closes panel from list view", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      const state = createAgentsPanelState();
      const res = reduceAgentsPanelKey(state, { key: "escape" }, vm);
      expect(res.state.isOpen).toBe(false);
   });

   it("selected description comes from current agent including vibe", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      expect(getSelectedDescription(createAgentsPanelState({ selectedIndex: 1 }), vm)).toBe("Implementation worker");
      const fastDesc = getSelectedDescription(createAgentsPanelState({ selectedIndex: 4 }), vm);
      expect(fastDesc).toContain("Vibe director profile");
   });
});

describe("Vibe profile conversion", () => {
   it("shows override beside the vibe tag for Markdown overrides", () => {
      const agent = vibeProfileToAgentDefinition("fast", sampleVibeProfiles.fast);
      expect(agentDisplayTags({ ...agent, isOverride: true })).toEqual(["vibe", "override"]);
      expect(agentDisplayTags(agent)).toEqual(["vibe"]);
   });

   it("converts vibe profile to agent definition with kind=vibe and locked tools", () => {
      const agent = vibeProfileToAgentDefinition("fast", sampleVibeProfiles.fast);
      expect(agent.kind).toBe("vibe");
      expect(agent.name).toBe("fast");
      expect(agent.model).toBe("kimi-k2.7");
      expect(agent.thinking).toBe("low");
      expect(agent.tools).toContain("submit");
      expect(agent.tools).toContain("hub");
      expect(agent.tools).not.toContain("task");
      expect(agent.tools).not.toContain("vibe");
      expect(agent.tools).not.toContain("vibe_spawn");
   });

   it("round-trips agent definition back to vibe profile", () => {
      const agent = vibeProfileToAgentDefinition("good", sampleVibeProfiles.good);
      const profile = agentDefinitionToVibeProfile(agent);
      expect(profile.harness).toBe("pi");
      expect(profile.pi?.model).toBe("gpt-5.6-sol");
      expect(profile.pi?.reasoning_effort).toBe("high");
   });

   it("strips task, vibe, and legacy vibe_* tools from vibe conversion", () => {
      const agent = vibeProfileToAgentDefinition("fast", {
         harness: "pi",
         pi: {
            model: "x",
            tools: ["read", "task", "vibe", "vibe_spawn", "vibe_kill", "write", "hub"]
         }
      });
      expect(agent.tools).toEqual(expect.arrayContaining(["read", "write", "hub", "submit"]));
      expect(agent.tools).not.toContain("task");
      expect(agent.tools).not.toContain("vibe");
      expect(agent.tools).not.toContain("vibe_spawn");
      expect(agent.tools).not.toContain("vibe_kill");
   });
});

describe("Agents Panel description panel", () => {
   it("labels panel Description and never uses selected description", () => {
      const panel = renderAgentDescriptionPanel(
         "Read-only research agent for rapid exploration of large codebases.",
         40,
         theme,
         4
      );
      expect(panel.some((line) => line.includes("Description"))).toBe(true);
      expect(panel.every((line) => !line.toLowerCase().includes("selected description"))).toBe(true);
      expect(panel.some((line) => line.includes("Read-only research"))).toBe(true);
      expect(panel.every((line) => !line.includes("..."))).toBe(true);
   });

   it("marks built-in agents as isOverride when overridden by disk file", () => {
      const overriddenScout: AgentDefinition = {
         name: "scout",
         display_name: "scout",
         description: "Custom scout override",
         tools: ["read", "grep"],
         harness: "pi",
         enabled: true,
         source: "builtin",
         isOverride: true,
         body: "# CUSTOM SCOUT"
      };
      const vm = buildAgentsPanelViewModel({ agents: [overriddenScout], vibeProfiles: sampleVibeProfiles });
      expect(vm.agents.find((a) => a.name === "scout")?.isOverride).toBe(true);
      expect(vm.agents.find((a) => a.name === "scout")?.source).toBe("builtin");
   });
});
