import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../src/domain.js";
import type { VibeProfileConfig } from "../src/services/AgentsStore.js";
import {
   buildAgentsPanelViewModel,
   createAgentsPanelState,
   reduceAgentsPanelKey
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

describe("Agents Panel Pure View Model & State", () => {
   it("builds view model with builtins and vibe profiles", () => {
      const vm = buildAgentsPanelViewModel({
         agents: sampleAgents,
         vibeProfiles: sampleVibeProfiles
      });

      expect(vm.builtins.map((a) => a.name)).toEqual(["scout", "task", "high-task", "reviewer"]);
      expect(vm.vibeProfiles.fast.pi?.model).toBe("kimi-k2.7");
      expect(vm.vibeProfiles.good.pi?.model).toBe("gpt-5.6-sol");
   });

   it("creates default state", () => {
      const state = createAgentsPanelState();
      expect(state.selectedSection).toBe("builtins");
      expect(state.selectedIndex).toBe(0);
      expect(state.focusedField).toBeUndefined();
      expect(state.isOpen).toBe(true);
   });

   it("navigates selection down and up within section", () => {
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
   });

   it("switches section with Tab or right arrow", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "tab" }, vm));
      expect(state.selectedSection).toBe("vibe");
      expect(state.selectedIndex).toBe(0);

      ({ state } = reduceAgentsPanelKey(state, { key: "tab" }, vm));
      expect(state.selectedSection).toBe("global");

      ({ state } = reduceAgentsPanelKey(state, { key: "tab" }, vm));
      expect(state.selectedSection).toBe("project");

      ({ state } = reduceAgentsPanelKey(state, { key: "tab" }, vm));
      expect(state.selectedSection).toBe("builtins");
   });

   it("toggles field focus with Enter or 'f'", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      let state = createAgentsPanelState();

      ({ state } = reduceAgentsPanelKey(state, { key: "enter" }, vm));
      expect(state.focusedField).toBe("name");

      ({ state } = reduceAgentsPanelKey(state, { key: "f" }, vm));
      expect(state.focusedField).toBe("tools");

      ({ state } = reduceAgentsPanelKey(state, { key: "f" }, vm));
      expect(state.focusedField).toBe("model");

      ({ state } = reduceAgentsPanelKey(state, { key: "escape" }, vm));
      expect(state.focusedField).toBeUndefined();
      expect(state.isOpen).toBe(true);
   });

   it("Esc closes panel when no field focused", () => {
      const vm = buildAgentsPanelViewModel({ agents: sampleAgents, vibeProfiles: sampleVibeProfiles });
      const state = createAgentsPanelState();
      const res = reduceAgentsPanelKey(state, { key: "escape" }, vm);
      expect(res.state.isOpen).toBe(false);
   });
});
