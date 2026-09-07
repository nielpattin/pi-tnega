import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { loadExtension } from "../_bootstrap.mjs";

const scratch = mkdtempSync(join(tmpdir(), "pi-subagent-monitor-"));
const activity = await loadExtension("extensions/pi-subagent/src/shared/agent-activity.ts");
const completion = await loadExtension("extensions/pi-subagent/src/shared/agent-completion.ts");

test("session stats aggregate cost, tool calls, and context footprint", () => {
   const sessionFile = join(scratch, "task-stats.jsonl");
   appendFileSync(sessionFile, JSON.stringify({ type: "session", id: "stats-child" }) + "\n");
   appendFileSync(sessionFile, JSON.stringify({
      type: "message",
      message: {
         role: "assistant",
         content: [{ type: "text", text: "first" }, { type: "toolCall", id: "call-1", name: "read", arguments: {} }],
         usage: { input: 100, output: 10, totalTokens: 8000, cost: { total: 0.25 } },
         stopReason: "toolCall"
      }
   }) + "\n");
   appendFileSync(sessionFile, JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "result" }] }
   }) + "\n");
   appendFileSync(sessionFile, JSON.stringify({
      type: "message",
      message: {
         role: "assistant",
         content: [{ type: "text", text: "done" }, { type: "toolCall", id: "call-2", name: "bash", arguments: {} }],
         usage: { input: 200, output: 20, totalTokens: 10522, cost: { total: 0.5 } },
         stopReason: "stop"
      }
   }) + "\n");
   assert.deepEqual(completion.readSessionStats(sessionFile), { cost: 0.75, toolCalls: 2, contextTokens: 10522 });
   assert.deepEqual(completion.readSessionStats(join(scratch, "missing.jsonl")), { cost: 0, toolCalls: 0, contextTokens: 0 });
   assert.deepEqual(completion.emptySessionStats(), { cost: 0, toolCalls: 0, contextTokens: 0 });
});
const child = await loadExtension("extensions/pi-subagent/src/agent-child.ts");
const processModule = await loadExtension("extensions/pi-subagent/src/shared/agent-process.ts");
const runtimeModule = await loadExtension("extensions/pi-subagent/src/runtime.ts");
const managerModule = await loadExtension("extensions/pi-subagent/src/services/agent-manager.ts");
const registryModule = await loadExtension("extensions/pi-subagent/src/services/task-registry.ts");

const sessionFileFromLaunchScript = (scriptPath) => {
   const match = /PI_AGENT_SESSION='([^']+)'/.exec(readFileSync(scriptPath, "utf8"));
   assert.ok(match);
   return match[1];
};

test("new agent sessions use unique Pi-style filenames", () => {
   const first = processModule.createAgentSessionFile({ id: "task-1", parentSessionFile: join(scratch, "parent.jsonl") });
   const second = processModule.createAgentSessionFile({ id: "task-1", parentSessionFile: join(scratch, "parent.jsonl") });
   const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/;
   assert.match(basename(first), pattern);
   assert.match(basename(second), pattern);
   assert.notEqual(first, second);
});
test("agent activity recorder publishes live tool state and a final done state", () => {
   const activityFile = join(scratch, "task-1.activity.json");
   let now = 1000;
   const recorder = activity.createAgentActivityRecorder({
      runningChildId: "task-1",
      activityFile,
      now: () => now
   });

   recorder.sessionStart();
   now = 1010;
   recorder.agentStart();
   now = 1020;
   recorder.toolExecutionStart("call-1", "read");

   let current = activity.readAgentActivityFile(activityFile, "task-1");
   assert.equal(current.ok, true);
   assert.equal(current.activity.phase, "active");
   assert.equal(current.activity.activeScope, "tool");
   assert.equal(current.activity.toolName, "read");

   now = 1030;
   recorder.agentEndDone();
   current = activity.readAgentActivityFile(activityFile, "task-1");
   assert.equal(current.ok, true);
   assert.equal(current.activity.phase, "done");
   assert.equal(current.activity.toolActive, false);
   assert.equal(activity.readAgentActivityFile(activityFile, "other").reason, "wrong-id");
});

test("completion monitor waits for and consumes an atomic exit sidecar", async () => {
   const exitFile = join(scratch, "task-2.jsonl.exit");
   setTimeout(() => writeFileSync(exitFile, JSON.stringify({ type: "done" })), 20).unref();
   const result = await completion.waitForAgentCompletion(new AbortController().signal, {
      exitFile,
      intervalMs: 5
   });
   assert.deepEqual(result, { reason: "done", exitCode: 0 });
   assert.equal(existsSync(exitFile), false);
});

test("child completion sidecars use normal assistant completion evidence", () => {
   assert.deepEqual(child.buildAgentCompletionSidecar([{ role: "assistant", stopReason: "stop" }]), { type: "done" });
   assert.deepEqual(
      child.buildAgentCompletionSidecar([{ role: "assistant", stopReason: "error", errorMessage: "quota" }]),
      { type: "error", errorMessage: "quota", stopReason: "error" }
   );
   assert.equal(child.shouldAutoExitAgent([{ role: "assistant", stopReason: "aborted" }]), false);
});

test("child prompt hook appends to the current system prompt and records activity", () => {
   const activityFile = join(scratch, "task-prompt.activity.json");
   const previous = {
      id: process.env.PI_AGENT_ID,
      session: process.env.PI_AGENT_SESSION,
      activity: process.env.PI_AGENT_ACTIVITY_FILE,
      autoExit: process.env.PI_AGENT_AUTO_EXIT,
      prompt: process.env.PI_AGENT_SYSTEM_PROMPT
   };
   const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
   };
   process.env.PI_AGENT_ID = "task-prompt";
   delete process.env.PI_AGENT_SESSION;
   process.env.PI_AGENT_ACTIVITY_FILE = activityFile;
   delete process.env.PI_AGENT_AUTO_EXIT;
   process.env.PI_AGENT_SYSTEM_PROMPT = "child prompt";
   try {
      const handlers = new Map();
      child.default({
         on(event, handler) {
            handlers.set(event, handler);
         }
      });
      const handler = handlers.get("before_agent_start");
      assert.deepEqual(handler({ systemPrompt: "base" }), { systemPrompt: "base\n\nchild prompt" });
      assert.deepEqual(handler({ systemPrompt: "base" }), { systemPrompt: "base\n\nchild prompt" });
      const activityState = activity.readAgentActivityFile(activityFile, "task-prompt");
      assert.equal(activityState.ok, true);
      assert.equal(activityState.activity.latestEvent, "before_agent_start");
   } finally {
      restore("PI_AGENT_ID", previous.id);
      restore("PI_AGENT_SESSION", previous.session);
      restore("PI_AGENT_ACTIVITY_FILE", previous.activity);
      restore("PI_AGENT_AUTO_EXIT", previous.autoExit);
      restore("PI_AGENT_SYSTEM_PROMPT", previous.prompt);
   }
});
test("child extension writes an exit sidecar and stays open after settle", () => {
   const sessionFile = join(scratch, "task-child.jsonl");
   const activityFile = join(scratch, "task-child.activity.json");
   const previous = {
      id: process.env.PI_AGENT_ID,
      session: process.env.PI_AGENT_SESSION,
      activity: process.env.PI_AGENT_ACTIVITY_FILE,
      autoExit: process.env.PI_AGENT_AUTO_EXIT
   };
   const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
   };
   process.env.PI_AGENT_ID = "task-child";
   process.env.PI_AGENT_SESSION = sessionFile;
   process.env.PI_AGENT_ACTIVITY_FILE = activityFile;
   process.env.PI_AGENT_AUTO_EXIT = "1";
   try {
      const handlers = new Map();
      let shutdowns = 0;
      child.default({
         on(event, handler) {
            handlers.set(event, handler);
         }
      });
      handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
      handlers.get("agent_settled")({}, { shutdown: () => shutdowns += 1 });
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
      assert.equal(shutdowns, 0);
   } finally {
      restore("PI_AGENT_ID", previous.id);
      restore("PI_AGENT_SESSION", previous.session);
      restore("PI_AGENT_ACTIVITY_FILE", previous.activity);
      restore("PI_AGENT_AUTO_EXIT", previous.autoExit);
   }
});

test("external agent command carries child extension and monitor identity", () => {
   const command = processModule.buildAgentCommand({
      id: "task-3",
      name: "inspect",
      prompt: "Read the package",
      cwd: "/repo",
      sessionFile: "/tmp/task-3.jsonl",
      childExtensionPath: "/extension/agent-child.ts",
      tools: ["read", "bash"],
      model: "provider/model",
      thinking: "low",
      useHerdr: false
   });
   assert.ok(command.args.includes("/extension/agent-child.ts"));
   assert.ok(command.args.includes("--tools"));
   const script = processModule.buildAgentLaunchScript({
      id: "task-3",
      name: "inspect",
      prompt: "Read the package",
      cwd: "/repo",
      sessionFile: "/tmp/task-3.jsonl",
      childExtensionPath: "/extension/agent-child.ts",
      tools: ["read"]
   });
   assert.match(script, /PI_AGENT_ACTIVITY_FILE/);
   assert.match(script, /HERDR_ENV='0'/);
   assert.match(script, /__PI_AGENT_DONE_%s__/);
});

test("direct external agent monitor stays offline and reads the child session result", async () => {
   const scriptFile = join(scratch, "fake-pi.mjs");
   const sessionFile = join(scratch, "task-4.jsonl");
   writeFileSync(
      scriptFile,
      [
         "#!/usr/bin/env node",
         "import { appendFileSync, writeFileSync } from 'node:fs';",
         "const session = process.env.PI_AGENT_SESSION;",
         "appendFileSync(session, JSON.stringify({ type: 'session', id: 'child-session' }) + '\\n');",
         "appendFileSync(session, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'offline result' }], stopReason: 'stop' } }) + '\\n');",
         "writeFileSync(session + '.exit', JSON.stringify({ type: 'done' }) + '\\n');",
         "",
      ].join("\n"),
      { mode: 0o755 }
   );
   const handle = await processModule.launchExternalAgent({
      id: "task-4",
      name: "offline",
      prompt: "Return a result",
      cwd: scratch,
      sessionFile,
      piCommand: scriptFile,
      useHerdr: false
   });
   const result = await handle.completion;
   assert.equal(result.ok, true);
   assert.equal(result.output, "offline result");
   assert.equal(result.sessionId, "child-session");
});

test("herdr agent pane stays open after the agent finishes", async () => {
   const sessionFile = join(scratch, "task-herdr.jsonl");
   const closed = [];
   const herdrOps = {
      available: () => true,
      createTab: () => { throw new Error("single agent must not create a tab"); },
      createPane: (name) => {
         assert.equal(name, "herdr-test");
         return "fake-pane-1";
      },
      runScript: () => {
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: "herdr-child" }) + "\n");
         appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "herdr result" }], stopReason: "stop" } }) + "\n");
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: (paneId) => closed.push(paneId),
      closeTab: () => { throw new Error("must not close a tab"); },
      renamePane: () => {},
      sendText: () => {}
   };
   const handle = await processModule.launchExternalAgent({
      id: "task-herdr",
      name: "herdr-test",
      prompt: "Return a result",
      cwd: scratch,
      sessionFile,
      useHerdr: true,
      herdrOps
   });
   assert.equal(handle.metadata.paneId, "fake-pane-1");
   const result = await handle.completion;
   assert.equal(result.ok, true);
   assert.equal(result.output, "herdr result");
   assert.deepEqual(closed, []);
});

test("existing pane is reused without splitting a new pane", async () => {
   const sessionFile = join(scratch, "task-existing.jsonl");
   let splits = 0;
   const runs = [];
   const renamed = [];
   const herdrOps = {
      available: () => true,
      createTab: () => { throw new Error("must not create a tab"); },
      createPane: () => {
         splits += 1;
         return "fake-pane-x";
      },
      runScript: (paneId) => {
         runs.push(paneId);
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: "existing-child" }) + "\n");
         appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "existing result" }], stopReason: "stop" } }) + "\n");
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: () => {},
      closeTab: () => {},
      renamePane: (paneId, name) => renamed.push([paneId, name]),
      sendText: () => {}
   };
   const handle = await processModule.launchExternalAgent({
      id: "task-existing",
      name: "existing",
      prompt: "Return a result",
      cwd: scratch,
      sessionFile,
      useHerdr: true,
      herdrOps,
      existingPaneId: "tab-root-1"
   });
   assert.equal(handle.metadata.paneId, "tab-root-1");
   assert.equal(splits, 0);
   assert.deepEqual(runs, ["tab-root-1"]);
   assert.deepEqual(renamed, [["tab-root-1", "existing"]]);
   const result = await handle.completion;
   assert.equal(result.ok, true);
});

test("agent batch shares one herdr tab across its panes", async () => {
   const calls = { tabs: [], panes: [], renamed: [], closedTabs: [] };
   let paneSeq = 0;
   const herdrOps = {
      available: () => true,
      createTab: (name, cwd) => {
         calls.tabs.push({ name, cwd });
         return { tabId: "fake-tab-1", rootPaneId: "fake-root-1" };
      },
      createPane: (name, cwd, fromPaneId, direction) => {
         paneSeq += 1;
         calls.panes.push({ name, fromPaneId, direction });
         return `fake-pane-${paneSeq}`;
      },
      runScript: (paneId, scriptPath) => {
         const id = basename(scriptPath, ".sh");
         const sessionFile = sessionFileFromLaunchScript(scriptPath);
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: `session-${id}` }) + "\n");
         appendFileSync(sessionFile, JSON.stringify({
            type: "message",
            message: {
               role: "assistant",
               content: [{ type: "text", text: `result ${id}` }, { type: "toolCall", id: `call-${id}`, name: "read", arguments: {} }],
               usage: { input: 100, output: 10, totalTokens: 9000, cost: { total: 0.5 } },
               stopReason: "stop"
            }
         }) + "\n");
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: () => {},
      closeTab: (tabId) => calls.closedTabs.push(tabId),
      renamePane: (paneId, name) => calls.renamed.push([paneId, name]),
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) =>
            manager.spawnBatch(
               [
                  { profile: "worker", name: "one", task: "First", cwd: scratch },
                  { profile: "worker", name: "two", task: "Second", cwd: scratch },
                  { profile: "worker", name: "three", task: "Third", cwd: scratch }
               ],
               {
                  ownerSessionId: "parent-tab-test",
                  parentSessionFile: join(scratch, "parent.jsonl"),
                  background: false,
                  useHerdr: true,
                  herdrOps,
                  batchId: "batch-tab",
                  batchSize: 3
               }
            )
         )
      );
      assert.equal(spawned.length, 3);
      assert.equal(calls.tabs.length, 1);
      assert.match(calls.tabs[0].name, /batch-tab/);
      assert.equal(calls.panes.length, 2);
      assert.equal(calls.panes[0].fromPaneId, "fake-root-1");
      assert.ok(calls.panes.every(({ direction }) => direction === "right"));
      assert.equal(calls.panes[0].name, "two");
      assert.deepEqual(calls.renamed, [["fake-root-1", "one"]]);
      const settled = await runtimeModule.runTool(runtime, registryModule.TaskRegistry.use((registry) => registry.list()));
      const mine = settled.filter((task) => task.ownerSessionId === "parent-tab-test");
      assert.equal(mine.length, 3);
      for (const task of mine) assert.equal(task.status, "completed");
      for (const task of mine) {
         assert.deepEqual(task.usage, { cost: 0.5, toolCalls: 1, contextTokens: 9000 });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(calls.closedTabs, []);
   } finally {
      await runtime.dispose();
   }
});

test("agent manager settles a background child and mirrors activity into the task registry", async () => {
   const scriptFile = join(scratch, "fake-manager-pi.mjs");
   writeFileSync(
      scriptFile,
      [
         "#!/usr/bin/env node",
         "import { appendFileSync, writeFileSync } from 'node:fs';",
         "const session = process.env.PI_AGENT_SESSION;",
         "const now = Date.now();",
         "writeFileSync(process.env.PI_AGENT_ACTIVITY_FILE, JSON.stringify({ version: 1, runningChildId: process.env.PI_AGENT_ID, createdAt: now, updatedAt: now, sequence: 1, latestEvent: 'tool_execution_start', phase: 'active', agentActive: true, turnActive: true, providerActive: false, toolActive: true, activeScope: 'tool', toolCallId: 'call-1', toolName: 'read', toolStartedAt: now }) + '\\n');",
         "appendFileSync(session, JSON.stringify({ type: 'session', id: 'manager-child' }) + '\\n');",
         "appendFileSync(session, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'manager result' }], stopReason: 'stop' } }) + '\\n');",
         "setTimeout(() => writeFileSync(session + '.exit', JSON.stringify({ type: 'done' }) + '\\n'), 450);",
         "",
      ].join("\n"),
      { mode: 0o755 }
   );
   chmodSync(scriptFile, 0o755);
   const previousCommand = process.env.PI_COMMAND;
   const previousHerdr = process.env.HERDR_ENV;
   const previousPane = process.env.HERDR_PANE_ID;
   process.env.PI_COMMAND = scriptFile;
   delete process.env.HERDR_ENV;
   delete process.env.HERDR_PANE_ID;
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) =>
            manager.spawnBatch(
               [{ profile: 'worker', name: 'managed', task: 'Return a result', cwd: scratch }],
               {
                  ownerSessionId: 'parent-test',
                  parentSessionFile: join(scratch, 'parent.jsonl'),
                  background: true,
                  useHerdr: false
               }
            )
         )
      );
      const taskId = spawned[0].id;
      assert.match(taskId, /^task-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      let settled = spawned[0];
      for (let attempt = 0; attempt < 15; attempt += 1) {
         await new Promise((resolve) => setTimeout(resolve, 100));
         settled = await runtimeModule.runTool(runtime, registryModule.TaskRegistry.use((registry) => registry.get(taskId)));
         if (settled?.status === 'completed') break;
      }
      assert.equal(settled?.status, 'completed');
      assert.equal(settled?.resultData, 'manager result');
      assert.equal(settled?.activity?.toolName, 'read');
   } finally {
      await runtime.dispose();
      if (previousCommand === undefined) delete process.env.PI_COMMAND;
      else process.env.PI_COMMAND = previousCommand;
      if (previousHerdr === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previousHerdr;
      if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPane;
   }
});
