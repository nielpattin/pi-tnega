import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const agentProfiles = await loadExtension("extensions/pi-subagent/src/services/agent-profiles.ts");
const childSession = await loadExtension("extensions/pi-subagent/src/shared/child-session.ts");
const agentProfilesPanel = await loadExtension("extensions/pi-subagent/src/ui/agent-profiles-panel.ts");

test("CHILD_EXCLUDED_TOOL_NAMES excludes nested agent tools", () => {
   const excluded = childSession.CHILD_EXCLUDED_TOOL_NAMES;
   assert.ok(excluded.includes("ask_user"));
   assert.ok(excluded.includes("agent_spawn"));
   assert.ok(excluded.includes("agent_list"));
   assert.ok(excluded.includes("agent_cancel"));
});

test("DISABLED_NESTED_TOOLS in profiles panel excludes nested agent tools", () => {
   const disabled = agentProfilesPanel.DISABLED_NESTED_TOOLS;
   assert.ok(disabled.has("ask_user"));
   assert.ok(disabled.has("agent_spawn"));
   assert.ok(disabled.has("agent_list"));
   assert.ok(disabled.has("agent_cancel"));
});

test("librarian profile is configured with pi-web-access tools", () => {
   const profiles = agentProfiles.listBuiltInAgentProfiles();
   const librarian = profiles.find((p) => p.name === "librarian");

   assert.ok(librarian, "librarian profile should be present");
   assert.equal(librarian.name, "librarian");
   assert.deepEqual(librarian.tools, ["web_search", "fetch_content", "web_research", "outline_site", "read"]);
   assert.ok(librarian.systemPrompt.includes("Primary Sources Only"));
   assert.ok(librarian.systemPrompt.includes("Zero Hallucination Policy"));
   assert.ok(librarian.systemPrompt.includes("Temporal & Version Precision"));
});

test("getChildExtensionPathsForTools resolves pi-web-access extension", () => {
   const tools = ["web_search", "fetch_content"];
   const paths = childSession.getChildExtensionPathsForTools(tools, process.cwd());

   assert.equal(paths.length, 1);
   assert.ok(paths[0].includes("pi-web-access"));
});

