/**
 * In-memory vibe / director mode state.
 *
 * toolsBeforeVibe remembers the pre-vibe active tool set so we can restore
 * it exactly when the user turns vibe off (plan-mode pattern).
 */

export interface VibeState {
   enabled: boolean;
   toolsBeforeVibe?: string[];
}

const state: VibeState = {
   enabled: false
};

export function isVibeEnabled(): boolean {
   return state.enabled;
}

/** Saved pre-vibe tool set (for exact restore). */
export function getVibeSavedTools(): string[] | undefined {
   return state.toolsBeforeVibe;
}

/** @deprecated Prefer getVibeSavedTools */
export const getToolsBeforeVibe = getVibeSavedTools;

export function setVibeEnabled(enabled: boolean, toolsBeforeVibe?: string[]): void {
   state.enabled = enabled;
   if (enabled) {
      if (toolsBeforeVibe !== undefined) {
         state.toolsBeforeVibe = [...toolsBeforeVibe];
      }
   } else {
      state.toolsBeforeVibe = undefined;
   }
}

/** Tools that are always required for director mode. */
export const VIBE_ALWAYS_TOOLS = ["read", "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

/** Optional info/read-like tools allowed in director mode ONLY if registered. */
export const VIBE_OPTIONAL_INFO_TOOLS = [
   "describe_image",
   "read_session",
   "workflow",
   "mcp",
   "web_search_exa",
   "deep_search_exa",
   "web_fetch_exa"
] as const;

/** Tools the director is allowed to use in vibe mode. */
export const VIBE_DIRECTOR_TOOLS = [...VIBE_ALWAYS_TOOLS, ...VIBE_OPTIONAL_INFO_TOOLS] as const;

export type VibeDirectorTool = (typeof VIBE_DIRECTOR_TOOLS)[number];

export function isVibeToolAllowed(name: string): boolean {
   return (VIBE_DIRECTOR_TOOLS as readonly string[]).includes(name);
}

/** @deprecated Prefer isVibeToolAllowed */
export const isVibeDirectorTool = isVibeToolAllowed;

/** Tools that are exclusive to vibe/director mode (vibe_*). */
export const VIBE_ONLY_TOOLS = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

/** Filter out vibe_* exclusive tools from a list of tool names. */
export function withoutVibeTools(tools: readonly string[]): string[] {
   const vibeSet = new Set<string>(VIBE_ONLY_TOOLS);
   return tools.filter((name) => !vibeSet.has(name));
}

/** Active tool list for director mode (intersection of allowed tools with registered tools). */
export function getVibeActiveTools(registeredToolNames: string[]): string[] {
   const registered = new Set(registeredToolNames);
   return VIBE_DIRECTOR_TOOLS.filter((name) => registered.has(name));
}

/** True when the active set is already only the director surface. */
export function isDirectorOnlyToolset(activeTools: readonly string[], registeredTools: readonly string[]): boolean {
   if (activeTools.length === 0) return false;
   const director = new Set(getVibeActiveTools([...registeredTools]));
   if (director.size === 0) return false;
   return activeTools.every((name) => director.has(name));
}

/**
 * Snapshot to save when entering vibe.
 * Never save a director-only set or vibe_* tools in the pre-vibe baseline.
 */
export function snapshotToolsBeforeVibe(activeTools: readonly string[], registeredTools: readonly string[]): string[] {
   if (isDirectorOnlyToolset(activeTools, registeredTools)) {
      return withoutVibeTools(registeredTools);
   }
   return withoutVibeTools(activeTools);
}

/**
 * Tools to restore when leaving vibe.
 * Falls back to normal registered set (without vibe_*) when saved is missing or director-only.
 */
export function resolveToolsAfterVibe(
   savedTools: readonly string[] | undefined,
   registeredTools: readonly string[]
): string[] {
   const normalRegistered = withoutVibeTools(registeredTools);
   if (!savedTools || savedTools.length === 0) {
      return normalRegistered;
   }
   if (isDirectorOnlyToolset(savedTools, registeredTools)) {
      return normalRegistered;
   }
   const registered = new Set(normalRegistered);
   const restored = savedTools.filter((name) => registered.has(name));
   return restored.length > 0 ? restored : normalRegistered;
}
