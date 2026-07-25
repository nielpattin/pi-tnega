import assert from "node:assert/strict";
import test from "node:test";
import tasksExtension from "./index.ts";
import {
  TASK_SPAWN_PARAMETER_DESCRIPTIONS,
  TASK_SPAWN_TOOL_DESCRIPTION,
  getTaskSpawnPromptGuidelines,
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

test("task_spawn tool parameters schema contains agent, prompt, name, working_dir", () => {
  const mockApi = createMockPiApi();
  tasksExtension(mockApi as any);

  const registeredTool = mockApi.registeredTools.find((t: any) => t.name === "task_spawn");
  assert.ok(registeredTool, "task_spawn tool was not registered");

  const properties = registeredTool.parameters.properties;
  assert.ok(properties.agent, "agent property missing");
  assert.ok(properties.prompt, "prompt property missing");
  assert.ok(properties.name, "name property missing");
  assert.ok(properties.working_dir, "working_dir property missing");

  // Verify exact schema keys (no extra or removed parameters)
  const propKeys = Object.keys(properties).sort();
  assert.deepEqual(propKeys, ["agent", "name", "prompt", "working_dir"].sort());

  // Verify required parameters array
  const required = registeredTool.parameters.required || [];
  assert.ok(required.includes("agent"), "agent must be required");
  assert.ok(required.includes("prompt"), "prompt must be required");
  assert.ok(required.includes("name"), "name must be required");
  assert.equal(required.includes("working_dir"), false, "working_dir must be optional");
});

test("prompt guidelines and parameter descriptions reflect agent-based spawn", () => {
  assert.ok(TASK_SPAWN_TOOL_DESCRIPTION.includes("agent role"));
  assert.equal((TASK_SPAWN_PARAMETER_DESCRIPTIONS as any).harness, undefined);
  assert.equal((TASK_SPAWN_PARAMETER_DESCRIPTIONS as any).model, undefined);
  assert.equal((TASK_SPAWN_PARAMETER_DESCRIPTIONS as any).reasoningEffort, undefined);
  assert.ok(TASK_SPAWN_PARAMETER_DESCRIPTIONS.agent);

  const guidelines = getTaskSpawnPromptGuidelines();
  assert.ok(guidelines.some((g) => g.includes("`agent`")));
});

test("task_spawn execution fails with clear error when agent or name is missing or invalid", async () => {
  const mockApi = createMockPiApi();
  tasksExtension(mockApi as any);

  const registeredTool = mockApi.registeredTools.find((t: any) => t.name === "task_spawn");
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
