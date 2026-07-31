import { test } from "vitest";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("station registers only bash, stash, and stash-history shortcuts", () => {
   const registrations = [...source.matchAll(/pi\.registerShortcut\((config\.shortcuts\.[a-zA-Z]+) as any,/g)].map(
      (match) => match[1],
   );

   assert.deepEqual(registrations, [
      "config.shortcuts.bashMode",
      "config.shortcuts.stash",
      "config.shortcuts.stashHistory",
   ]);
});

test("bash mode shortcut toggles bash mode", () => {
   assert.match(source, /pi\.registerShortcut\(config\.shortcuts\.bashMode as any, \{/);
   assert.match(source, /await bashIntegration\.setActive\(!bashIntegration\.active, ctx as any\);/);
});

test("stash shortcut stashes and restores editor text", () => {
   assert.match(source, /pi\.registerShortcut\(config\.shortcuts\.stash as any, \{/);
   assert.match(source, /function stashOrRestoreEditorText\(ctx: any\): void/);
   assert.match(source, /stashOrRestoreEditorText\(ctx\);/);
   assert.match(source, /pushStashHistory\(stashedPromptHistory, text\)/);
   assert.match(source, /persistStashHistory\(stashedPromptHistory\)/);
});

test("stash-history shortcut opens prompt history", () => {
   assert.match(source, /pi\.registerShortcut\(config\.shortcuts\.stashHistory as any, \{/);
   assert.match(source, /await openStashHistory\(ctx\);/);
});
