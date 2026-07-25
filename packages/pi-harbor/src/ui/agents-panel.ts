/**
 * Pure view model and state machine for /agents panel.
 */

import type { AgentDefinition } from "../domain.js";
import type { VibeProfileConfig } from "../services/AgentsStore.js";

export type PanelSection = "builtins" | "global" | "project" | "vibe";
export type EditField = "name" | "tools" | "model" | "thinking" | "harness";

export interface AgentsPanelViewModel {
   builtins: AgentDefinition[];
   global: AgentDefinition[];
   project: AgentDefinition[];
   vibeProfiles: {
      fast: VibeProfileConfig;
      good: VibeProfileConfig;
   };
}

export interface AgentsPanelState {
   selectedSection: PanelSection;
   selectedIndex: number;
   focusedField?: EditField;
   isOpen: boolean;
}

export interface PanelKeyInput {
   key: string;
   shift?: boolean;
   alt?: boolean;
   ctrl?: boolean;
}

export function buildAgentsPanelViewModel(params: {
   agents: ReadonlyArray<AgentDefinition>;
   vibeProfiles: { fast: VibeProfileConfig; good: VibeProfileConfig };
}): AgentsPanelViewModel {
   const builtins = params.agents.filter((a) => a.source === "builtin");
   const global = params.agents.filter((a) => a.source === "global");
   const project = params.agents.filter((a) => a.source === "project");

   return {
      builtins,
      global,
      project,
      vibeProfiles: params.vibeProfiles
   };
}

export function createAgentsPanelState(initial?: Partial<AgentsPanelState>): AgentsPanelState {
   return {
      selectedSection: "builtins",
      selectedIndex: 0,
      focusedField: undefined,
      isOpen: true,
      ...initial
   };
}

const FIELD_CYCLE: EditField[] = ["name", "tools", "model", "thinking", "harness"];
const SECTIONS: PanelSection[] = ["builtins", "vibe", "global", "project"];

export function reduceAgentsPanelKey(
   state: AgentsPanelState,
   input: PanelKeyInput,
   viewModel?: AgentsPanelViewModel
): { state: AgentsPanelState } {
   const key = input.key.toLowerCase();

   if (key === "escape") {
      if (state.focusedField) {
         return { state: { ...state, focusedField: undefined } };
      }
      return { state: { ...state, isOpen: false } };
   }

   if (key === "q" && !state.focusedField) {
      return { state: { ...state, isOpen: false } };
   }

   if (key === "tab" || key === "right") {
      const idx = SECTIONS.indexOf(state.selectedSection);
      const nextIdx = (idx + 1) % SECTIONS.length;
      return {
         state: {
            ...state,
            selectedSection: SECTIONS[nextIdx],
            selectedIndex: 0,
            focusedField: undefined
         }
      };
   }

   if (key === "left") {
      const idx = SECTIONS.indexOf(state.selectedSection);
      const nextIdx = (idx - 1 + SECTIONS.length) % SECTIONS.length;
      return {
         state: {
            ...state,
            selectedSection: SECTIONS[nextIdx],
            selectedIndex: 0,
            focusedField: undefined
         }
      };
   }

   if (key === "down" || key === "j") {
      let maxCount = 2; // for vibe profiles fast/good
      if (viewModel && state.selectedSection !== "vibe") {
         maxCount = viewModel[state.selectedSection]?.length ?? 0;
      }
      const nextIdx = maxCount > 0 ? Math.min(state.selectedIndex + 1, maxCount - 1) : state.selectedIndex + 1;
      return { state: { ...state, selectedIndex: nextIdx } };
   }

   if (key === "up" || key === "k") {
      return { state: { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) } };
   }

   if (key === "enter" || key === "f") {
      if (!state.focusedField) {
         return { state: { ...state, focusedField: "name" } };
      } else {
         const currentIdx = FIELD_CYCLE.indexOf(state.focusedField);
         const nextField = FIELD_CYCLE[(currentIdx + 1) % FIELD_CYCLE.length];
         return { state: { ...state, focusedField: nextField } };
      }
   }

   return { state };
}
