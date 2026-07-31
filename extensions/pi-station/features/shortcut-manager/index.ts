export interface StationShortcuts {
   bashMode: string;
   stash: string;
   stashHistory: string;
   undo: string;
   redo: string;
}

export const DEFAULT_STATION_SHORTCUTS: StationShortcuts = {
   bashMode: "ctrl+b",
   stash: "alt+s",
   stashHistory: "ctrl+alt+h",
   undo: "ctrl+z",
   redo: "ctrl+y"
};

function normalizeShortcut(value: unknown): string | null {
   if (typeof value !== "string") {
      return null;
   }
   const normalized = value.trim().toLowerCase();
   return normalized ? normalized : null;
}

export function resolveStationShortcuts(value: unknown): StationShortcuts {
   if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ...DEFAULT_STATION_SHORTCUTS };
   }

   const raw = value as Record<string, unknown>;

   return {
      bashMode: normalizeShortcut(raw.bashMode) ?? DEFAULT_STATION_SHORTCUTS.bashMode,
      stash: normalizeShortcut(raw.stash) ?? DEFAULT_STATION_SHORTCUTS.stash,
      stashHistory: normalizeShortcut(raw.stashHistory) ?? DEFAULT_STATION_SHORTCUTS.stashHistory,
      undo: normalizeShortcut(raw.undo) ?? DEFAULT_STATION_SHORTCUTS.undo,
      redo: normalizeShortcut(raw.redo) ?? DEFAULT_STATION_SHORTCUTS.redo
   };
}
