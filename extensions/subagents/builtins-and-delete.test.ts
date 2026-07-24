import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BUILTIN_AGENTS, isBuiltinAgentName } from "./src/agents/builtins.ts";
import { deleteAgent, loadAllAgents, mergeAgents, saveAgent } from "./src/agents/types.ts";
import type { AgentDefinition } from "./src/agents/types.ts";

test("isBuiltinAgentName correctly identifies built-in agent names", () => {
   assert.equal(isBuiltinAgentName("explore"), false);
   assert.equal(isBuiltinAgentName("scout"), true);
   assert.equal(isBuiltinAgentName("task"), true);
   assert.equal(isBuiltinAgentName("custom_agent"), false);
});

test("mergeAgents overlays file agents onto built-in catalog", () => {
   const userAgent: AgentDefinition = {
      name: "my_agent",
      description: "User agent",
      harness: "pi",
      enabled: true,
      body: "# Prompt",
      filePath: "/tmp/agents/my_agent.md"
   };

   const exploreOverride: AgentDefinition = {
      name: "explore",
      description: "Custom explore description",
      harness: "pi",
      enabled: false,
      body: "# Custom Explore Prompt",
      filePath: "/tmp/agents/explore.md"
   };

   const scoutOverride: AgentDefinition = {
      name: "scout",
      description: "Custom scout override",
      harness: "pi",
      enabled: false,
      body: "# Custom Scout",
      filePath: "/tmp/agents/scout.md"
   };

   const merged = mergeAgents(BUILTIN_AGENTS, [userAgent, exploreOverride, scoutOverride]);

   const map = new Map(merged.map((a) => [a.name, a]));

   assert.equal(map.has("scout"), true);
   assert.equal(map.get("scout")?.source, "builtin");
   assert.equal(map.get("scout")?.filePath, "/tmp/agents/scout.md");
   assert.equal(map.get("scout")?.description, "Custom scout override");

   assert.equal(map.has("task"), true);
   assert.equal(map.get("task")?.source, "builtin");
   assert.equal(map.get("task")?.filePath, undefined);

   assert.equal(map.get("my_agent")?.source, "user");
   assert.equal(map.get("my_agent")?.description, "User agent");
   assert.equal(map.get("my_agent")?.filePath, "/tmp/agents/my_agent.md");

   assert.equal(map.get("explore")?.source, "user");
   assert.equal(map.get("explore")?.description, "Custom explore description");
   assert.equal(map.get("explore")?.enabled, false);
});

test("loadAllAgents includes built-ins scout and task", () => {
   const all = loadAllAgents();
   assert.ok(all.has("scout"));
   assert.ok(all.has("task"));

   assert.equal(all.get("scout")?.source, "builtin");
   assert.equal(all.get("task")?.source, "builtin");
});

test("deleteAgent refuses built-in agents", () => {
   const resScout = deleteAgent("scout");
   assert.equal(resScout.success, false);
   assert.match(resScout.error || "", /Built-in agents cannot be deleted/);

   const resTask = deleteAgent("task");
   assert.equal(resTask.success, false);
   assert.match(resTask.error || "", /Built-in agents cannot be deleted/);
});

test("deleteAgent removes user agent file", () => {
   const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
   const projAgentsDir = path.join(tmpDir, ".pi", "agents");
   fs.mkdirSync(projAgentsDir, { recursive: true });

   const userDef: AgentDefinition = {
      name: "temp_worker",
      description: "Temp worker agent",
      harness: "pi",
      enabled: true,
      body: "# Temp body"
   };

   saveAgent(userDef, projAgentsDir);
   assert.ok(fs.existsSync(path.join(projAgentsDir, "temp_worker.md")));

   const loadedBefore = loadAllAgents(tmpDir);
   assert.ok(loadedBefore.has("temp_worker"));
   assert.equal(loadedBefore.get("temp_worker")?.source, "user");

   const delRes = deleteAgent("temp_worker", tmpDir);
   assert.equal(delRes.success, true);
   assert.ok(!fs.existsSync(path.join(projAgentsDir, "temp_worker.md")));

   const loadedAfter = loadAllAgents(tmpDir);
   assert.ok(!loadedAfter.has("temp_worker"));

   fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("deleteAgent allows deleting user explore agent file", () => {
   const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-explore-"));
   const projAgentsDir = path.join(tmpDir, ".pi", "agents");
   fs.mkdirSync(projAgentsDir, { recursive: true });

   const exploreUserDef: AgentDefinition = {
      name: "explore",
      description: "User explore agent",
      harness: "pi",
      enabled: true,
      body: "# User explore body"
   };

   saveAgent(exploreUserDef, projAgentsDir);
   assert.ok(fs.existsSync(path.join(projAgentsDir, "explore.md")));

   const delRes = deleteAgent("explore", tmpDir);
   assert.equal(delRes.success, true);
   assert.ok(!fs.existsSync(path.join(projAgentsDir, "explore.md")));

   fs.rmSync(tmpDir, { recursive: true, force: true });
});

