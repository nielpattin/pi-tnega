import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension } from "../_bootstrap.mjs";

// Keep all runtime state (recovery files, persistence) inside a temp dir.
const scratch = mkdtempSync(join(tmpdir(), "pi-worker-flows-test-"));
process.env.PI_CODING_AGENT_DIR = scratch;

const { registerWorkersExtension } = await loadExtension(
   "extensions/pi-worker-flows/src/workers/extension.ts"
);

const WORKER_TOOLS = ["worker_spawn", "worker_list", "worker_recover", "worker_cancel"];

function createFakePi() {
   const registered = new Map();
   const active = new Set();
   const handlers = new Map();
   return {
      registered,
      handlers,
      registerTool(def) {
         registered.set(def.name, def);
         // Pi core activates newly registered tools immediately.
         active.add(def.name);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      appendEntry() {},
      sendMessage() {},
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
         for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
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
      ui: { notify() {}, setStatus() {} },
      isIdle: () => true
   };
}

test("worker tools stay active in the parent TUI session", async () => {
   const pi = createFakePi();
   registerWorkersExtension(pi);
   for (const name of WORKER_TOOLS) {
      assert.ok(pi.registered.has(name), `expected ${name} to be registered`);
      assert.ok(pi.getActiveTools().includes(name), `expected ${name} to start active`);
   }

   await pi.emit("session_start", parentTuiContext());
   for (const name of WORKER_TOOLS) {
      assert.ok(
         pi.getActiveTools().includes(name),
         `expected ${name} to stay active after parent session_start`
      );
   }

   await pi.emit("before_agent_start", parentTuiContext());
   for (const name of WORKER_TOOLS) {
      assert.ok(
         pi.getActiveTools().includes(name),
         `expected ${name} to stay active after before_agent_start`
      );
   }
});
