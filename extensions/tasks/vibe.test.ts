import assert from "node:assert/strict";
import test from "node:test";
import {
  getToolsBeforeVibe,
  getVibeActiveTools,
  isDirectorOnlyToolset,
  isVibeDirectorTool,
  isVibeEnabled,
  resolveToolsAfterVibe,
  setVibeEnabled,
  snapshotToolsBeforeVibe,
  VIBE_DIRECTOR_TOOLS,
  withoutVibeTools,
} from "./src/vibe/state.ts";

test("vibe state toggle stores and clears pre-vibe tools", () => {
  setVibeEnabled(false);
  assert.equal(isVibeEnabled(), false);
  assert.equal(getToolsBeforeVibe(), undefined);

  setVibeEnabled(true, ["read", "bash", "edit", "write"]);
  assert.equal(isVibeEnabled(), true);
  assert.deepEqual(getToolsBeforeVibe(), ["read", "bash", "edit", "write"]);

  setVibeEnabled(false);
  assert.equal(isVibeEnabled(), false);
  assert.equal(getToolsBeforeVibe(), undefined);
});

test("withoutVibeTools strips all vibe_* tools while retaining normal tools", () => {
  const tools = [
    "read",
    "bash",
    "edit",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
    "task_spawn",
  ];
  assert.deepEqual(withoutVibeTools(tools), ["read", "bash", "edit", "task_spawn"]);
});

test("director tool allowlist includes required tools and optional info tools", () => {
  assert.equal(isVibeDirectorTool("read"), true);
  assert.equal(isVibeDirectorTool("vibe_spawn"), true);
  assert.equal(isVibeDirectorTool("vibe_send"), true);
  assert.equal(isVibeDirectorTool("vibe_wait"), true);
  assert.equal(isVibeDirectorTool("vibe_kill"), true);
  assert.equal(isVibeDirectorTool("vibe_list"), true);

  // Optional info tools
  assert.equal(isVibeDirectorTool("describe_image"), true);
  assert.equal(isVibeDirectorTool("read_session"), true);
  assert.equal(isVibeDirectorTool("workflow"), true);
  assert.equal(isVibeDirectorTool("mcp"), true);
  assert.equal(isVibeDirectorTool("web_search_exa"), true);
  assert.equal(isVibeDirectorTool("deep_search_exa"), true);
  assert.equal(isVibeDirectorTool("web_fetch_exa"), true);

  // Disallowed action / write / worker tools
  assert.equal(isVibeDirectorTool("bash"), false);
  assert.equal(isVibeDirectorTool("edit"), false);
  assert.equal(isVibeDirectorTool("write"), false);
  assert.equal(isVibeDirectorTool("task_spawn"), false);
});

test("getVibeActiveTools includes optional info tools ONLY if present in registered tools", () => {
  const registeredBasic = [
    "read",
    "bash",
    "edit",
    "write",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
  ];
  assert.deepEqual(getVibeActiveTools(registeredBasic), [
    "read",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
  ]);

  const registeredWithInfo = [
    "read",
    "bash",
    "edit",
    "write",
    "mcp",
    "web_search_exa",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
    "describe_image",
  ];
  assert.deepEqual(getVibeActiveTools(registeredWithInfo), [
    "read",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
    "describe_image",
    "mcp",
    "web_search_exa",
  ]);
});

test("isDirectorOnlyToolset detects locked director surface even with optional info tools present", () => {
  const all = [
    "read",
    "bash",
    "edit",
    "write",
    "mcp",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
  ];
  assert.equal(
    isDirectorOnlyToolset(["read", "vibe_spawn", "vibe_wait", "mcp"], all),
    true,
  );
  assert.equal(
    isDirectorOnlyToolset(["read", "bash", "edit", "write"], all),
    false,
  );
  assert.equal(isDirectorOnlyToolset([], all), false);
  assert.equal(isDirectorOnlyToolset(["bash"], all), false);
});

test("snapshotToolsBeforeVibe keeps full toolset without vibe_* when already director-locked", () => {
  const all = [
    "read",
    "bash",
    "edit",
    "write",
    "mcp",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
  ];
  assert.deepEqual(
    snapshotToolsBeforeVibe(["read", "bash", "edit", "write", "mcp"], all),
    ["read", "bash", "edit", "write", "mcp"],
  );
  // If active is already director-only (stale lock), snapshot registered minus vibe_*.
  assert.deepEqual(
    snapshotToolsBeforeVibe(
      ["read", "mcp", "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"],
      all,
    ),
    ["read", "bash", "edit", "write", "mcp"],
  );
});

test("resolveToolsAfterVibe never restores a director-only set or vibe_* tools", () => {
  const all = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "mcp",
    "vibe_spawn",
    "vibe_send",
    "vibe_wait",
    "vibe_kill",
    "vibe_list",
  ];
  const expectedNormal = ["read", "bash", "edit", "write", "grep", "mcp"];
  assert.deepEqual(
    resolveToolsAfterVibe(["read", "bash", "edit", "write", "mcp"], all),
    ["read", "bash", "edit", "write", "mcp"],
  );
  assert.deepEqual(
    resolveToolsAfterVibe(
      ["read", "mcp", "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"],
      all,
    ),
    expectedNormal,
  );
  assert.deepEqual(resolveToolsAfterVibe(undefined, all), expectedNormal);
  assert.deepEqual(resolveToolsAfterVibe([], all), expectedNormal);
});
