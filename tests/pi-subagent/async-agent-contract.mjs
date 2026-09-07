import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const prompt = await loadExtension("extensions/pi-subagent/src/agent-prompt.ts");
const widget = await loadExtension("extensions/pi-subagent/src/ui/async-agent-widget.ts");


test("agent prompt contract asks for a normal final assistant message", () => {
   assert.match(prompt.AGENT_SYSTEM_INSTRUCTION, /final assistant message/i);
});


test("agent widget includes the live activity label", () => {
   const tasks = [
      {
         id: "task-1",
         ownerSessionId: "parent",
         name: "inspect",
         profile: "explorer",
         promptOrCommand: "inspect",
         createdAt: Date.now() - 9000,
         status: "running",
         runtimeOwned: true,
         startedAt: Date.now() - 5000,
         activity: {
            version: 1,
            runningChildId: "task-1",
            createdAt: 1,
            updatedAt: 2,
            sequence: 3,
            latestEvent: "tool_execution_start",
            phase: "active",
            agentActive: true,
            turnActive: true,
            providerActive: false,
            toolActive: true,
            activeScope: "tool",
            activeSince: 2,
            toolName: "read",
            messageEventType: "text_delta"
         }
      }
   ];
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text
   };
   const component = widget.createAsyncAgentWidget(tasks)(undefined, theme);
   try {
      const lines = component.render(120);
      assert.equal(lines.length, 2);
      assert.match(lines[0], /agents/);
      assert.match(lines[0], /1 working/);
      assert.match(lines[1], /inspect · explorer · 5s · read/);
   } finally {
      component.dispose?.();
   }
});

test("agent widget snapshot changes when only the activity label changes", () => {
   const base = {
      running: 1,
      settled: 0,
      completed: 0,
      failed: 0,
      activeNames: ["inspect"],
      activeDetails: ["inspect: starting"],
      settledSignature: ""
   };
   const next = { ...base, activeDetails: ["inspect: read"] };
   assert.notEqual(widget.buildAsyncAgentSnapshot(base), widget.buildAsyncAgentSnapshot(next));
});
test("collapsed agent widget truncates overflow with an expand hint", () => {
   const now = Date.now();
   const tasks = [0, 1, 2, 3, 4].map((index) => ({
      id: `task-${index}`,
      ownerSessionId: "parent",
      name: `job-${index}`,
      profile: "explorer",
      promptOrCommand: "work",
      createdAt: now - 1000,
      status: "running",
      runtimeOwned: true
   }));
   const theme = { fg: (_color, text) => text, bold: (text) => text };
   const component = widget.createAsyncAgentWidget(tasks)(undefined, theme);
   try {
      const lines = component.render(120);
      assert.equal(lines.length, 5);
      assert.match(lines[4], /\+2 more/);
      assert.match(lines[4], /\/wr to expand/);
      assert.doesNotMatch(lines.join("\n"), /job-4/);
   } finally {
      component.dispose?.();
   }
});

test("expanded agent widget shows every row without truncation", () => {
   const now = Date.now();
   const tasks = [0, 1, 2, 3, 4].map((index) => ({
      id: `task-${index}`,
      ownerSessionId: "parent",
      name: `job-${index}`,
      profile: "explorer",
      promptOrCommand: "work",
      createdAt: now - 1000,
      status: "running",
      runtimeOwned: true
   }));
   const theme = { fg: (_color, text) => text, bold: (text) => text };
   const component = widget.createAsyncAgentWidget(tasks, { expanded: true })(undefined, theme);
   try {
      const lines = component.render(120);
      assert.equal(lines.length, 6);
      assert.doesNotMatch(lines.join("\n"), /more/);
      assert.match(lines.join("\n"), /job-4/);
      assert.match(lines[0], /\/wr to collapse/);
   } finally {
      component.dispose?.();
   }
});


test("agent widget animates and styles every outcome", () => {
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text
   };
   const tasks = [
      { id: "task-1", ownerSessionId: "parent", batchId: "batch-1", name: "run", profile: "worker", promptOrCommand: "x", status: "running", createdAt: Date.now() - 2000, startedAt: Date.now() - 1000, runtimeOwned: true },
      { id: "task-2", ownerSessionId: "parent", batchId: "batch-1", name: "done", profile: "worker", promptOrCommand: "x", status: "completed", createdAt: 1, runtimeOwned: true },
      { id: "task-3", ownerSessionId: "parent", batchId: "batch-1", name: "broke", profile: "worker", promptOrCommand: "x", status: "failed", createdAt: 1, runtimeOwned: true },
   ];
   const component = widget.createAsyncAgentWidget(tasks)(undefined, theme);
   try {
      const lines = component.render(120);
      assert.match(lines[0], /^• agents /);
      assert.match(lines[0], /● 1 working/);
      assert.match(lines[0], /✓ 1 done/);
      assert.match(lines[0], /✗ 1 failed/);
      assert.match(lines[1], /^  [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] run · worker · 1s/);
   } finally {
      component.dispose?.();
      component.dispose?.();
   }
});

test("agent batch call lists agents while running and collapses when settled", async () => {
   const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text
   };
   const args = { agents: [
      { name: "explore-tps", profile: "explorer", task: "Explore the folder extensions/tps/" },
      { name: "explore-tool-selector", profile: "explorer", task: "Explore the folder extensions/tool-selector/" }
   ] };
   const running = renderers.renderAgentCall(args, theme, {}).render(120);
   assert.equal(running.length, 3);
   assert.match(running[0], /agent_spawn batch · 2 agents/);
   assert.match(running[1], /explore-tps/);
   assert.match(running[2], /explore-tool-selector/);
   for (const line of running) {
      assert.doesNotMatch(line, /Explore the folder/);
   }
   assert.match(running[1], /· explorer/);
   assert.match(running[2], /· explorer/);
   const settled = renderers.renderAgentCall(
      args,
      theme,
      { state: { taskStatuses: ["completed", "completed"] } }
   ).render(120);
   assert.equal(settled.length, 1);
   assert.match(settled[0], /agent_spawn batch · 2 agents/);
});

test("agent stat line renders cost, calls, context, and lines", async () => {
   const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text
   };
   assert.equal(
      renderers.formatAgentStatLine(
         {
            status: "completed",
            name: "explore-tps",
            profile: "explorer",
            usage: { cost: 0.012, toolCalls: 14, contextTokens: 38000 },
            lineCount: 12
         },
         theme
      ),
      "✓ explore-tps · explorer · $0.012 · 14 calls · 38k ctx (12 lines)"
   );
   assert.equal(
      renderers.formatAgentStatLine({ status: "completed", name: "one", profile: "worker", lineCount: 1 }, theme),
      "✓ one · worker (1 line)"
   );
   assert.equal(
      renderers.formatAgentStatLine({
         status: "failed",
         name: "solo",
         usage: { cost: 1.2, toolCalls: 1, contextTokens: 512 }
      }, theme),
      "✗ solo · $1.2 · 1 call · 512 ctx"
   );
});

test("agent single call collapses to the header once settled", async () => {
   const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text
   };
   const args = { agents: [{ name: "solo", profile: "explorer", task: "Read the readme" }] };
   const running = renderers.renderAgentCall(args, theme, {}).render(120);
   assert.equal(running.length, 1);
   assert.match(running[0], /solo/);
   assert.match(running[0], /Read the readme/);
   const settled = renderers
      .renderAgentCall(args, theme, { state: { taskStatuses: ["completed"] } })
      .render(120);
   assert.equal(settled.length, 1);
   assert.match(settled[0], /agent_spawn batch · 1 agent/);
   assert.doesNotMatch(settled[0], /solo/);
});

test("agent partial result renders nothing until all agents finish", async () => {
   const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text
   };
   const component = renderers.renderAgentResult(
      {
         content: [{ type: "text", text: "partial" }],
         details: { ok: true, count: 2, tasks: [{ id: "task-1", status: "completed" }], message: "partial" }
      },
      { expanded: false, isPartial: true },
      theme,
      { state: {} }
   );
   assert.deepEqual(component.render(120), []);
});

test("agent result records per-task statuses from the tasks array", async () => {
   const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text
   };
   const context = { state: {} };
   renderers.renderAgentResult(
      {
         content: [{ type: "text", text: "2 agents finished." }],
         details: {
            ok: true,
            count: 2,
            tasks: [
               { id: "task-1", name: "one", status: "completed", result: "a" },
               { id: "task-2", name: "two", status: "completed", result: "b" }
            ],
            message: "2 agents finished."
         }
      },
      { expanded: true, isPartial: false },
      theme,
      context
   );
   assert.deepEqual(context.state.taskStatuses, ["completed", "completed"]);
});
