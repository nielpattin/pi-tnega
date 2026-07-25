import { test } from "vitest";

import assert from "node:assert/strict";
import {
   collectHiddenExtensionStatusKeys,
   getNotificationExtensionStatuses,
   mergeSegmentsWithCustomItems,
   normalizeCompactExtensionStatus,
   normalizeExtensionStatusValue,
   parseStationConfig,
} from "../station-config.ts";

test("parseStationConfig supports object config with custom items", () => {
   const config = parseStationConfig({
      customItems: [
         { id: "ci", position: "right", prefix: "CI", statusKey: "ci-status" },
         { hideWhenMissing: false, id: "review", position: "secondary" },
      ],
   });

   assert.equal(config.customItems.length, 2);
   assert.equal(config.customItems[0].id, "ci");
   assert.equal(config.customItems[0].statusKey, "ci-status");
   assert.equal(config.customItems[1].statusKey, "review");
   assert.equal(config.customItems[1].hideWhenMissing, false);
   assert.equal(config.scrollBar, true);
   assert.equal(config.fixedEditor, true);
   assert.deepEqual(config.shortcuts, {
      bashMode: "ctrl+b",
      stash: "alt+s",
      stashHistory: "ctrl+alt+h",
      undo: "ctrl+z",
      redo: "ctrl+y",
   });
});

test("parseStationConfig uses defaults when optional layout fields are absent", () => {
   const config = parseStationConfig({ fixedEditor: false, scrollBar: false });

   assert.equal(config.scrollBar, false);
   assert.equal(config.fixedEditor, false);
   assert.deepEqual(config.customItems, []);
});

test("parseStationConfig resolves shortcut overrides", () => {
   const config = parseStationConfig({
      shortcuts: {
         bashMode: "ctrl+shift+b",
         stash: "ctrl+shift+s",
         stashHistory: "ctrl+shift+h",
      },
   });

   assert.deepEqual(config.shortcuts, {
      bashMode: "ctrl+shift+b",
      stash: "ctrl+shift+s",
      stashHistory: "ctrl+shift+h",
      undo: "ctrl+z",
      redo: "ctrl+y",
   });
});

test("mergeSegmentsWithCustomItems appends custom segment ids by position", () => {
   const merged = mergeSegmentsWithCustomItems(
      {
         leftSegments: ["path"],
         rightSegments: ["git"],
         secondarySegments: ["extension_statuses"],
         separator: "station",
      },
      [
         {
            excludeFromExtensionStatuses: true,
            hideWhenMissing: true,
            id: "ci",
            position: "left",
            statusKey: "ci",
         },
         {
            excludeFromExtensionStatuses: true,
            hideWhenMissing: true,
            id: "timer",
            position: "right",
            statusKey: "timer",
         },
         {
            excludeFromExtensionStatuses: true,
            hideWhenMissing: true,
            id: "review",
            position: "secondary",
            statusKey: "review",
         },
      ],
   );

   assert.deepEqual(merged.leftSegments, ["path", "custom:ci"]);
   assert.deepEqual(merged.rightSegments, ["git", "custom:timer"]);
   assert.deepEqual(merged.secondarySegments, ["extension_statuses", "custom:review"]);
});

test("collectHiddenExtensionStatusKeys includes default custom status keys", () => {
   const hidden = collectHiddenExtensionStatusKeys([
      {
         excludeFromExtensionStatuses: true,
         hideWhenMissing: true,
         id: "ci",
         position: "right",
         statusKey: "ci-status",
      },
      {
         excludeFromExtensionStatuses: false,
         hideWhenMissing: true,
         id: "review",
         position: "secondary",
         statusKey: "review",
      },
   ]);

   assert.equal(hidden.has("ci-status"), true);
   assert.equal(hidden.has("review"), false);
});

test("normalizeCompactExtensionStatus strips baked-in trailing separators", () => {
   assert.equal(normalizeCompactExtensionStatus("CI ok · "), "CI ok");
   assert.equal(normalizeCompactExtensionStatus("CI ok |   "), "CI ok");
   assert.equal(normalizeCompactExtensionStatus("[notice] queued"), null);
});

test("normalizeExtensionStatusValue keeps notification-style statuses renderable for custom items", () => {
   assert.equal(normalizeExtensionStatusValue("[review] queued · "), "[review] queued");
});

test("getNotificationExtensionStatuses skips promoted hidden status keys", () => {
   const statuses = new Map<string, string>([
      ["ci-status", "[ci] queued"],
      ["review", "[review] running"],
      ["plain", "plain status"],
   ]);
   const hidden = new Set(["ci-status"]);

   assert.deepEqual(getNotificationExtensionStatuses(statuses, hidden), ["[review] running"]);
});
