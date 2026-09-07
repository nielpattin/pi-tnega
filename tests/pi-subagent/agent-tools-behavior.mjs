import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { loadExtension } from "../_bootstrap.mjs";

const scratch = mkdtempSync(join(tmpdir(), "pi-subagent-tools-"));
const runtimeModule = await loadExtension("extensions/pi-subagent/src/runtime.ts");
const managerModule = await loadExtension("extensions/pi-subagent/src/services/agent-manager.ts");
const registryModule = await loadExtension("extensions/pi-subagent/src/services/task-registry.ts");
const agentTools = await loadExtension("extensions/pi-subagent/src/tools/agent.ts");

const scriptFile = join(scratch, "fake-tools-pi.mjs");
writeFileSync(
   scriptFile,
   [
      "#!/usr/bin/env node",
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const session = process.env.PI_AGENT_SESSION;",
      "const mode = process.env.FAKE_AGENT_MODE ?? 'done';",
      "const delay = Number(process.env.FAKE_AGENT_DELAY_MS ?? '50');",
      "appendFileSync(session, JSON.stringify({ type: 'session', id: 'tools-child' }) + '\\n');",
      "if (mode === 'hang') { setInterval(() => {}, 1000); }",
      "else {",
      "appendFileSync(session, JSON.stringify({ type: 'message', message: {",
      "   role: 'assistant',",
      "   content: [{ type: 'text', text: `${mode} output` }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }],",
      "   ...(mode === 'done' ? { usage: { input: 100, output: 10, totalTokens: 5000, cost: { total: 0.25 } } } : {}),",
      "   stopReason: mode === 'done' ? 'stop' : 'error'",
      "} }) + '\\n');",
      "setTimeout(() => writeFileSync(session + '.exit',",
      "   mode === 'done' ? JSON.stringify({ type: 'done' }) + '\\n'",
      "      : JSON.stringify({ type: 'error', errorMessage: 'boom', stopReason: 'error' }) + '\\n'), delay);",
      "}",
      ""
   ].join("\n"),
   { mode: 0o755 }
);
chmodSync(scriptFile, 0o755);

const savedEnv = {
   PI_COMMAND: process.env.PI_COMMAND,
   HERDR_ENV: process.env.HERDR_ENV,
   HERDR_PANE_ID: process.env.HERDR_PANE_ID,
   FAKE_AGENT_MODE: process.env.FAKE_AGENT_MODE,
   FAKE_AGENT_DELAY_MS: process.env.FAKE_AGENT_DELAY_MS
};

function useDirectSpawn(mode = "done") {
   process.env.PI_COMMAND = scriptFile;
   delete process.env.HERDR_ENV;
   delete process.env.HERDR_PANE_ID;
   process.env.FAKE_AGENT_MODE = mode;
   delete process.env.FAKE_AGENT_DELAY_MS;
}

function restoreEnv() {
   for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
   }
}

const sessionFileFromLaunchScript = (scriptPath) => {
   const match = /PI_AGENT_SESSION='([^']+)'/.exec(readFileSync(scriptPath, "utf8"));
   assert.ok(match);
   return match[1];
};
async function getTask(runtime, id) {
   return runtimeModule.runTool(runtime, registryModule.TaskRegistry.use((registry) => registry.get(id)));
}

async function waitForStatus(runtime, id, status) {
   let current;
   for (let attempt = 0; attempt < 40; attempt += 1) {
      current = await getTask(runtime, id);
      if (current?.status === status) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
   }
   return current;
}

test("agent_list returns every spawned agent with status, session file, and usage", async () => {
   useDirectSpawn("done");
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         agentTools.handleAgentSpawn(
            {
               agents: [
                  { profile: "worker", name: "list-one", task: "First" },
                  { profile: "worker", name: "list-two", task: "Second" }
               ]
            },
            { ownerSessionId: "parent-list-test", parentSessionFile: join(scratch, "parent.jsonl"), cwd: scratch }
         )
      );
      assert.equal(spawned.ok, true);
      assert.equal(spawned.count, 2);
      for (const summary of spawned.tasks) assert.match(summary.result, /done output/);

      const listed = await runtimeModule.runTool(runtime, agentTools.handleAgentList({}));
      assert.equal(listed.ok, true);
      assert.equal(listed.tasks.length, 2);
      for (const entry of listed.tasks) {
         assert.equal(entry.status, "completed");
         assert.ok(entry.sessionFile, "list entry keeps the session file for inspection");
         assert.deepEqual(entry.usage, { cost: 0.25, toolCalls: 1, contextTokens: 5000 });
      }
      const names = listed.tasks.map((entry) => entry.name).sort();
      assert.deepEqual(names, ["list-one", "list-two"]);
   } finally {
      restoreEnv();
      await runtime.dispose();
   }
});

test("agent_cancel stops a running agent and reports unknown ids", async () => {
   useDirectSpawn("hang");
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         agentTools.handleAgentSpawn(
            { agents: [{ profile: "worker", name: "doomed", task: "Hang" }], background: true },
            { ownerSessionId: "parent-cancel-test", parentSessionFile: join(scratch, "parent.jsonl"), cwd: scratch }
         )
      );
      assert.equal(spawned.ok, true);
      const [summary] = spawned.tasks;
      const listed = await runtimeModule.runTool(runtime, agentTools.handleAgentList({}));
      assert.equal(listed.tasks[0].status, "running");

      const cancelled = await runtimeModule.runTool(
         runtime,
         agentTools.handleAgentCancel({ id: summary.id })
      );
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.action, "cancelled");
      let settled = await waitForStatus(runtime, summary.id, "cancelled");
      assert.equal(settled?.status, "cancelled");
      for (let attempt = 0; attempt < 40 && !settled?.errorText; attempt += 1) {
         await new Promise((resolve) => setTimeout(resolve, 50));
         settled = await getTask(runtime, summary.id);
      }
      assert.match(settled?.errorText ?? "", /borted/);

      const missing = await runtimeModule.runTool(runtime, agentTools.handleAgentCancel({ id: "task-404" }));
      assert.equal(missing.ok, false);
      assert.match(missing.error, /not found/);

      process.env.FAKE_AGENT_MODE = "done";
      const quick = await runtimeModule.runTool(
         runtime,
         agentTools.handleAgentSpawn(
            { agents: [{ profile: "worker", name: "finished", task: "Quick" }] },
            { ownerSessionId: "parent-cancel-test", parentSessionFile: join(scratch, "parent.jsonl"), cwd: scratch }
         )
      );
      const finishedId = quick.tasks[0].id;
      assert.equal((await getTask(runtime, finishedId))?.status, "completed");
      const afterCancel = await runtimeModule.runTool(
         runtime,
         agentTools.handleAgentCancel({ id: finishedId })
      );
      assert.equal(afterCancel.ok, true);
      assert.equal((await getTask(runtime, finishedId))?.status, "completed");
   } finally {
      restoreEnv();
      await runtime.dispose();
   }
});


test("manager cancel closes the agent pane", async () => {
   const closed = [];
   const herdrOps = {
      available: () => true,
      createTab: () => {
         throw new Error("single agent must not create a tab");
      },
      createPane: () => "cancel-pane-1",
      runScript: () => {},
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: (paneId) => closed.push(paneId),
      closeTab: () => {},
      renamePane: () => {},
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) =>
            manager.spawnBatch([{ profile: "worker", name: "pane-victim", task: "Hang" }], {
               ownerSessionId: "parent-pane-test",
               parentSessionFile: join(scratch, "parent.jsonl"),
               background: true,
               useHerdr: true,
               herdrOps
            })
         )
      );
      const [task] = spawned;
      assert.equal((await getTask(runtime, task.id))?.paneId, "cancel-pane-1");
      await runtimeModule.runTool(runtime, managerModule.AgentManager.use((manager) => manager.cancelTask(task.id)));
      const settled = await waitForStatus(runtime, task.id, "cancelled");
      assert.equal(settled?.status, "cancelled");
      assert.equal(settled?.paneId, undefined);
      assert.deepEqual(closed, ["cancel-pane-1"]);
   } finally {
      await runtime.dispose();
   }
});

test("manager prune keeps closed settled entries until result delivery", async () => {
   const inspected = [];
   const gone = new Set(["prune-pane-2"]);
   const herdrOps = {
      available: () => true,
      createTab: () => ({ tabId: "prune-tab", rootPaneId: "prune-pane-1" }),
      createPane: () => "prune-pane-2",
      runScript: (_paneId, scriptPath) => {
         const id = basename(scriptPath, ".sh");
         const sessionFile = sessionFileFromLaunchScript(scriptPath);
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: `session-${id}` }) + "\n");
         appendFileSync(
            sessionFile,
            JSON.stringify({
               type: "message",
               message: { role: "assistant", content: [{ type: "text", text: `result ${id}` }], stopReason: "stop" }
            }) + "\n"
         );
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async (paneId) => {
         inspected.push(paneId);
         return gone.has(paneId) ? "missing" : "present";
      },
      closePane: () => {},
      closeTab: () => {},
      renamePane: () => {},
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) =>
            manager.spawnBatch(
               [
                  { profile: "worker", name: "kept", task: "First" },
                  { profile: "worker", name: "dropped", task: "Second" }
               ],
               {
                  ownerSessionId: "parent-prune-test",
                  parentSessionFile: join(scratch, "parent.jsonl"),
                  background: false,
                  useHerdr: true,
                  herdrOps,
                  batchId: "batch-prune",
                  batchSize: 2
               }
            )
         )
      );
      assert.equal(spawned.length, 2);
      const pruned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) => manager.pruneClosedPanes())
      );
      assert.equal(pruned, 1);
      assert.ok(inspected.includes("prune-pane-1"));
      const kept = await getTask(runtime, spawned[0].id);
      const dropped = await getTask(runtime, spawned[1].id);
      assert.equal(kept?.status, "completed");
      assert.equal(kept?.paneId, "prune-pane-1");
      assert.equal(dropped?.status, "completed");
      assert.equal(dropped?.paneId, undefined);
      assert.equal(dropped?.paneClosed, true);
      const droppedStatus = dropped?.status;
      const droppedSettledAt = dropped?.settledAt;
      const widget = await loadExtension("extensions/pi-subagent/src/ui/async-agent-widget.ts");
      const visibleBeforeDelivery = widget.visibleWidgetTasks([kept, dropped]);
      assert.deepEqual(
         visibleBeforeDelivery.map((task) => task.id),
         [spawned[0].id, spawned[1].id]
      );
      const delivered = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) => manager.markResultsDelivered([dropped.id]))
      );
      assert.deepEqual(delivered, [dropped.id]);
      const markedDropped = await getTask(runtime, dropped.id);
      assert.equal(markedDropped?.resultDelivered, true);
      assert.equal(markedDropped?.status, droppedStatus);
      assert.equal(markedDropped?.settledAt, droppedSettledAt);
      const visibleAfterDelivery = widget.visibleWidgetTasks([kept, markedDropped]);
      assert.deepEqual(
         visibleAfterDelivery.map((task) => task.id),
         [spawned[0].id]
      );
      const deliveredAgain = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) => manager.markResultsDelivered([dropped.id]))
      );
      assert.deepEqual(deliveredAgain, []);
   } finally {
      await runtime.dispose();
   }
});

test("manager prune keeps panes when herdr is unavailable", async () => {
   let inspected = 0;
   let herdrUp = true;
   const herdrOps = {
      available: () => herdrUp,
      createTab: () => ({ tabId: "t", rootPaneId: "offline-pane-1" }),
      createPane: () => "offline-pane-1",
      runScript: () => {},
      readPane: () => "",
      inspectPane: async () => {
         inspected += 1;
         return "present";
      },
      closePane: () => {},
      closeTab: () => {},
      renamePane: () => {},
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const spawned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) =>
            manager.spawnBatch([{ profile: "worker", name: "offline", task: "Hang" }], {
               ownerSessionId: "parent-offline-test",
               parentSessionFile: join(scratch, "parent.jsonl"),
               background: true,
               useHerdr: true,
               herdrOps
            })
         )
      );
      assert.equal((await getTask(runtime, spawned[0].id))?.paneId, "offline-pane-1");
      herdrUp = false;
      const pruned = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) => manager.pruneClosedPanes())
      );
      assert.equal(pruned, 0);
      // The live monitor may still inspect the running pane; prune itself must not clear it.
      const task = await getTask(runtime, spawned[0].id);
      assert.equal(task?.paneId, "offline-pane-1");
      assert.equal(task?.paneClosed, undefined);
      await runtimeModule.runTool(runtime, managerModule.AgentManager.use((manager) => manager.cancelTask(spawned[0].id)));
   } finally {
      await runtime.dispose();
   }
});

test("one-agent spawn opens a new tab when the parent tab is occupied", async () => {
   const tabs = [];
   const panes = [];
   const herdrOps = {
      available: () => true,
      currentTabPaneCount: () => 2,
      createTab: (name, cwd) => {
         tabs.push({ name, cwd });
         return { tabId: "occupied-tab", rootPaneId: "occupied-root" };
      },
      createPane: () => {
         return "wrong-split-pane";
      },
      runScript: (paneId, scriptPath) => {
         panes.push(paneId);
         const sessionFile = sessionFileFromLaunchScript(scriptPath);
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: "occupied-child" }) + "\n");
         appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "occupied result" }], stopReason: "stop" } }) + "\n");
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: () => {},
      closeTab: () => {},
      renamePane: () => {},
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const [spawned] = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) => manager.spawnBatch([{ profile: "worker", name: "occupied", task: "First" }], {
            ownerSessionId: "parent-occupied-test",
            parentSessionFile: join(scratch, "parent.jsonl"),
            useHerdr: true,
            herdrOps
         }))
      );
      assert.equal(tabs.length, 1);
      assert.deepEqual(panes, ["occupied-root"]);
      const task = await getTask(runtime, spawned.id);
      assert.equal(task?.paneId, "occupied-root");
   } finally {
      await runtime.dispose();
   }
});

test("one-agent spawn splits the lone parent pane without opening a tab", async () => {
   const tabs = [];
   const panes = [];
   const herdrOps = {
      available: () => true,
      currentTabPaneCount: () => 1,
      createTab: () => {
         tabs.push(true);
         throw new Error("must not create a tab");
      },
      createPane: (_name, _cwd, fromPaneId) => {
         panes.push(fromPaneId);
         return "lone-split-pane";
      },
      runScript: (_paneId, scriptPath) => {
         const sessionFile = sessionFileFromLaunchScript(scriptPath);
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: "lone-child" }) + "\n");
         appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "lone result" }], stopReason: "stop" } }) + "\n");
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: () => {},
      closeTab: () => {},
      renamePane: () => {},
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   try {
      const [spawned] = await runtimeModule.runTool(
         runtime,
         managerModule.AgentManager.use((manager) => manager.spawnBatch([{ profile: "worker", name: "lone", task: "First" }], {
            ownerSessionId: "parent-lone-test",
            parentSessionFile: join(scratch, "parent.jsonl"),
            useHerdr: true,
            herdrOps
         }))
      );
      assert.deepEqual(tabs, []);
      assert.deepEqual(panes, [undefined]);
      assert.equal((await getTask(runtime, spawned.id))?.paneId, "lone-split-pane");
   } finally {
      await runtime.dispose();
   }
});

test("closeSettledPanes closes only owned terminal runtime panes and is idempotent", async () => {
   const closed = [];
   const herdrOps = {
      available: () => true,
      currentTabPaneCount: () => 1,
      createTab: () => { throw new Error("must not create a tab"); },
      createPane: () => "seed-pane",
      runScript: (_paneId, scriptPath) => {
         const sessionFile = sessionFileFromLaunchScript(scriptPath);
         appendFileSync(sessionFile, JSON.stringify({ type: "session", id: "seed-child" }) + "\n");
         appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "seed result" }], stopReason: "stop" } }) + "\n");
         writeFileSync(sessionFile + ".exit", JSON.stringify({ type: "done" }) + "\n");
      },
      readPane: () => "",
      inspectPane: async () => "present",
      closePane: (paneId) => {
         if (paneId === "close-fail") throw new Error("pane close failed");
         closed.push(paneId);
      },
      closeTab: () => {},
      renamePane: () => {},
      sendText: () => {}
   };
   const runtime = runtimeModule.makeAgentsRuntime();
   const owner = "close-owner";
   const register = async (id, status, extra = {}) => {
      const task = await runtimeModule.runTool(runtime, registryModule.TaskRegistry.use((registry) => registry.register({
         id, ownerSessionId: owner, name: id, profile: "worker", cwd: scratch, promptOrCommand: id, runtimeOwned: true, paneId: id, ...extra
      })));
      return runtimeModule.runTool(runtime, registryModule.TaskRegistry.use((registry) => registry.updateStatus(task.id, status)));
   };
   try {
      const [seedTask] = await runtimeModule.runTool(runtime, managerModule.AgentManager.use((manager) => manager.spawnBatch([{ profile: "worker", name: "seed", task: "Seed" }], {
         ownerSessionId: owner, parentSessionFile: join(scratch, "parent.jsonl"), useHerdr: true, herdrOps
      })));
      await register("close-completed", "completed");
      await register("close-failed", "failed");
      await register("close-cancelled", "cancelled");
      await register("close-running", "running");
      await register("close-pending", "pending");
      await register("close-restored", "completed", { runtimeOwned: false });
      await register("close-foreign", "completed", { ownerSessionId: "other-owner" });
      await register("close-fail", "completed");
      const first = await runtimeModule.runTool(runtime, managerModule.AgentManager.use((manager) => manager.closeSettledPanes(owner)));
      assert.equal(first, 4);
      assert.deepEqual(closed.sort(), ["seed-pane", "close-cancelled", "close-completed", "close-failed"].sort());
      const task = async (id) => getTask(runtime, id);
      for (const id of [seedTask.id, "close-completed", "close-failed", "close-cancelled"]) {
         const current = await task(id);
         assert.equal(current?.paneClosed, true);
         assert.equal(current?.paneId, undefined);
      }
      assert.equal((await task("close-fail"))?.paneId, "close-fail");
      for (const id of ["close-running", "close-pending", "close-restored", "close-foreign"]) {
         const current = await task(id);
         assert.equal(current?.paneId, id);
         assert.notEqual(current?.paneClosed, true);
      }
      const closedBeforeSecond = closed.length;
      const second = await runtimeModule.runTool(runtime, managerModule.AgentManager.use((manager) => manager.closeSettledPanes(owner)));
      assert.equal(second, 0);
      assert.equal(closed.length, closedBeforeSecond);
   } finally {
      await runtime.dispose();
   }
});
