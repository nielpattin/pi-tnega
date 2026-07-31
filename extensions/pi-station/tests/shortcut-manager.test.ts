import { test } from "vitest";

import assert from "node:assert/strict";
import { DEFAULT_STATION_SHORTCUTS, resolveStationShortcuts } from "../features/shortcut-manager/index.ts";

test("resolveStationShortcuts uses defaults when no overrides exist", () => {
   assert.deepEqual(resolveStationShortcuts(undefined), DEFAULT_STATION_SHORTCUTS);
   assert.deepEqual(resolveStationShortcuts({}), DEFAULT_STATION_SHORTCUTS);
});

test("resolveStationShortcuts applies user overrides", () => {
   assert.deepEqual(
      resolveStationShortcuts({
         bashMode: "ctrl+shift+b",
         stash: "ctrl+shift+s",
         stashHistory: "ctrl+shift+h",
         undo: "ctrl+shift+z",
         redo: "ctrl+y",
      }),
      {
         bashMode: "ctrl+shift+b",
         stash: "ctrl+shift+s",
         stashHistory: "ctrl+shift+h",
         undo: "ctrl+shift+z",
         redo: "ctrl+y",
      },
   );
});

test("resolveStationShortcuts ignores blank or unknown overrides", () => {
   assert.deepEqual(resolveStationShortcuts({ bashMode: " ", bogus: "ctrl+x", stash: "alt+x" }), {
      ...DEFAULT_STATION_SHORTCUTS,
      stash: "alt+x",
   });
});
