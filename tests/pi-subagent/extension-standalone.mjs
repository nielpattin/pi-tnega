import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { loadExtension } from "../_bootstrap.mjs";

// Keep all runtime state (task files, persistence) inside a temp dir.
const scratch = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
process.env.PI_CODING_AGENT_DIR = scratch;

const extension = await loadExtension("extensions/pi-subagent/src/extension.ts");
const { registerAgentsExtension } = extension;

const AGENT_TOOLS = ["agent_spawn", "agent_list", "agent_cancel"];

function createFakePi() {
   const registered = new Map();
   const commands = new Map();
   const active = new Set();
   const handlers = new Map();
   const entries = [];
   const messages = [];
   const notices = [];
   return {
      registered,
      commands,
      entries,
      messages,
      notices,
      registerTool(def) {
         registered.set(def.name, def);
         // Pi core activates newly registered tools immediately.
         active.add(def.name);
      },
      registerCommand(name, def) {
         commands.set(name, def);
      },
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      appendEntry(kind, entry) {
         entries.push({ kind, entry });
      },
      sendMessage(message) {
         messages.push(message);
      },
      getThinkingLevel: () => "medium",
      getAllTools() {
         return [...registered.keys()].map((name) => ({ name }));
      },
      getActiveTools() {
         return [...active];
      },
      setActiveTools(names) {
         active.clear();
         for (const name of names) active.add(name);
      },
      on(event, handler) {
         if (!handlers.has(event)) handlers.set(event, []);
         handlers.get(event).push(handler);
      },
      async emit(event, ctx) {
         const results = [];
         for (const handler of handlers.get(event) ?? []) results.push(await handler({}, ctx));
         return results;
      }
   };
}

function parentTuiContext() {
   return {
      mode: "tui",
      hasUI: true,
      cwd: scratch,
      sessionManager: {
         getSessionFile: () => undefined,
         getSessionId: () => "test-parent"
      },
      modelRegistry: { getAvailable: () => [] },
      ui: { notify() {}, setStatus() {}, setWidget() {} },
      isIdle: () => true
   };
}

function toolContext() {
   return {
      mode: "tui",
      hasUI: false,
      cwd: scratch,
      sessionManager: {
         getSessionFile: () => undefined,
         getSessionId: () => "test-parent"
      },
      modelRegistry: { getAvailable: () => [] },
      ui: { notify() {} },
      isIdle: () => true
   };
}

test("standalone registration exposes only agent tools and commands", () => {
   const pi = createFakePi();
   const result = registerAgentsExtension(pi);
   assert.equal(result.ok, true);
   assert.ok(result.runtime, "runtime is exposed for tests");
   assert.equal(typeof result.refreshAgentSpawnTool, "function");
   for (const name of AGENT_TOOLS) {
      assert.ok(pi.registered.has(name), `expected ${name} to be registered`);
   }
   assert.equal(pi.registered.has("agent_recover"), false);
   assert.ok(pi.commands.has("wr"), "/wr widget toggle is registered");
   assert.ok(pi.commands.has("wr.profile"), "/wr.profile config command is registered");
});

test("default export is the plain extension installer", () => {
   assert.equal(typeof extension.default, "function");
});

test("default installer skips the delegation extension inside an agent child", () => {
   const previousAgentId = process.env.PI_AGENT_ID;
   process.env.PI_AGENT_ID = "task-child";
   try {
      const pi = createFakePi();
      extension.default(pi);
      assert.equal(pi.registered.size, 0);
      assert.equal(pi.commands.size, 0);
   } finally {
      if (previousAgentId === undefined) delete process.env.PI_AGENT_ID;
      else process.env.PI_AGENT_ID = previousAgentId;
   }
});

test("resources_discover exposes the pi-subagent prompts dir", async () => {
   const pi = createFakePi();
   registerAgentsExtension(pi);
   const [result] = await pi.emit("resources_discover", parentTuiContext());
   assert.ok(result, "resources_discover handler returns prompt paths");
   assert.equal(result.promptPaths.length, 1);
   assert.ok(
      result.promptPaths[0].endsWith(`pi-subagent${sep}prompts`),
      `prompts dir stays inside pi-subagent, got ${result.promptPaths[0]}`
   );
});

test("print-mode child sessions lose the parent agent tools", async () => {
   const pi = createFakePi();
   registerAgentsExtension(pi);
   await pi.emit("session_start", parentTuiContext());
   for (const name of AGENT_TOOLS) {
      assert.ok(pi.getActiveTools().includes(name), `expected ${name} active in parent TUI`);
   }
   await pi.emit("session_start", { ...parentTuiContext(), mode: "print", hasUI: false });
   for (const name of AGENT_TOOLS) {
      assert.ok(!pi.getActiveTools().includes(name), `expected ${name} hidden in child session`);
   }
});


test("agent_list on an empty registry returns text, agent_cancel unknown id returns an error result", async () => {
   const pi = createFakePi();
   registerAgentsExtension(pi);
   await pi.emit("session_start", parentTuiContext());
   const ctx = toolContext();
   const list = pi.registered.get("agent_list");
   const listed = await list.execute("call-1", {}, undefined, undefined, ctx);
   assert.ok(Array.isArray(listed.content) && listed.content.length > 0, "list returns content blocks");
   assert.match(String(listed.content[0].text ?? ""), /No active|Agent Tasks|task/i);
   const cancel = pi.registered.get("agent_cancel");
   const cancelled = await cancel.execute("call-2", { id: "task-999" }, undefined, undefined, ctx);
   assert.match(String(cancelled.content[0].text ?? ""), /not found/i);
});

test("/wr.profile lists profiles without UI", async () => {
   const pi = createFakePi();
   registerAgentsExtension(pi);
   const notices = [];
   const ctx = { ...toolContext(), ui: { notify: (text) => notices.push(text) } };
   await pi.commands.get("wr.profile").handler("", ctx);
   assert.equal(notices.length, 1);
   assert.match(notices[0], /Agent profiles/);
   assert.match(notices[0], /librarian/);
});

test("session_shutdown settles without active agents", async () => {
   const pi = createFakePi();
   registerAgentsExtension(pi);
   await pi.emit("session_start", parentTuiContext());
   await pi.emit("session_shutdown", parentTuiContext());
});
