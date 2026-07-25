import assert from "node:assert/strict";
import test from "node:test";
import tasksExtension from "./index.ts";

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
      setActiveTools: () => {}
   };
}

test("task_spawn_batch tool registration", () => {
   const mockApi = createMockPiApi();
   tasksExtension(mockApi as any);

   const batchTool = mockApi.registeredTools.find((t: any) => t.name === "task_spawn_batch");
   assert.ok(batchTool, "task_spawn_batch tool was not registered");

   const props = batchTool.parameters.properties;
   assert.ok(props.tasks, "tasks property missing");
   assert.ok(props.context, "context property missing");

   const required = batchTool.parameters.required || [];
   assert.ok(required.includes("tasks"), "tasks must be required");
});
