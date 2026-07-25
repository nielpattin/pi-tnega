import assert from "node:assert/strict";
import test from "node:test";
import subagentsExtension from "./index.ts";
import {
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  getSubagentSpawnPromptGuidelines,
} from "./src/prompt.ts";

function createMockPiApi() {
  const tools: any[] = [];
  return {
    registeredTools: tools,
    on: () => {},
    registerTool: (tool: any) => {
      tools.push(tool);
    },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    getThinkingLevel: () => "medium",
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
}

test("subagent_spawn tool parameters schema contains only agent, prompt, name, working_dir", () => {
  const mockApi = createMockPiApi();
  subagentsExtension(mockApi as any);

  const registeredTool = mockApi.registeredTools.find((t: any) => t.name === "subagent_spawn");
  assert.ok(registeredTool, "subagent_spawn tool was not registered");

  const properties = registeredTool.parameters.properties;
  assert.ok(properties.agent, "agent property missing");
  assert.ok(properties.prompt, "prompt property missing");
  assert.ok(properties.name, "name property missing");
  assert.ok(properties.working_dir, "working_dir property missing");

  // Verify removed parameters are not in schema
  assert.equal(properties.harness, undefined, "harness must be removed");
  assert.equal(properties.model, undefined, "model must be removed");
  assert.equal(properties.reasoning_effort, undefined, "reasoning_effort must be removed");

  // Verify required parameters array
  const required = registeredTool.parameters.required || [];
  assert.ok(required.includes("agent"), "agent must be required");
  assert.ok(required.includes("prompt"), "prompt must be required");
  assert.ok(required.includes("name"), "name must be required");
  assert.equal(required.includes("working_dir"), false, "working_dir must be optional");
});

test("prompt guidelines and parameter descriptions reflect agent-based spawn", () => {
  assert.ok(SUBAGENT_SPAWN_TOOL_DESCRIPTION.includes("agent role"));
  assert.equal((SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS as any).harness, undefined);
  assert.equal((SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS as any).model, undefined);
  assert.equal((SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS as any).reasoningEffort, undefined);
  assert.ok(SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.agent);

  const guidelines = getSubagentSpawnPromptGuidelines();
  assert.ok(guidelines.some((g) => g.includes("`agent`")));
});

test("subagent_spawn execution fails with clear error when agent or name is missing or invalid", async () => {
  const mockApi = createMockPiApi();
  subagentsExtension(mockApi as any);

  const registeredTool = mockApi.registeredTools.find((t: any) => t.name === "subagent_spawn");
  assert.ok(registeredTool);

  const mockCtx: any = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
  };

  // Test missing agent
  await assert.rejects(
    async () => {
      await registeredTool.execute("call-1", { agent: "", prompt: "Do something", name: "test-name" }, undefined, undefined, mockCtx);
    },
    (err: Error) => {
      assert.match(err.message, /Param 'agent' is required/);
      assert.match(err.message, /Available enabled agents:/);
      return true;
    }
  );

  // Test missing/empty name
  await assert.rejects(
    async () => {
      await registeredTool.execute("call-2", { agent: "task", prompt: "Do something", name: "   " }, undefined, undefined, mockCtx);
    },
    (err: Error) => {
      assert.match(err.message, /Param 'name' is required and must be non-empty/);
      return true;
    }
  );

  // Test non-existent agent
  await assert.rejects(
    async () => {
      await registeredTool.execute("call-3", { agent: "non-existent-agent-12345", prompt: "Do something", name: "test-name" }, undefined, undefined, mockCtx);
    },
    (err: Error) => {
      assert.match(err.message, /Agent "non-existent-agent-12345" not found/);
      return true;
    }
  );
});
