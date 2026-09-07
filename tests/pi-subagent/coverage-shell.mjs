import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension } from "../_bootstrap.mjs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

initTheme("default");
const scratch = mkdtempSync(join(tmpdir(), "pi-subagent-cov-"));
process.env.PI_CODING_AGENT_DIR = scratch;
const ext = await loadExtension("extensions/pi-subagent/src/extension.ts");
const panel = await loadExtension("extensions/pi-subagent/src/ui/agent-profiles-panel.ts");
const runtimeMod = await loadExtension("extensions/pi-subagent/src/runtime.ts");
const registryMod = await loadExtension("extensions/pi-subagent/src/services/task-registry.ts");
const managerMod = await loadExtension("extensions/pi-subagent/src/services/agent-manager.ts");
const sessionMod = await loadExtension("extensions/pi-subagent/src/services/task-session.ts");
const persistenceMod = await loadExtension("extensions/pi-subagent/src/services/task-persistence.ts");
const { Effect, Layer, ManagedRuntime } = await import("effect");
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

function piFake() {
   const p = {
      registered: new Map(), commands: new Map(), handlers: new Map(), messages: [], active: new Set(), widgets: [],
      registerTool(d) { this.registered.set(d.name, d); this.active.add(d.name); },
      registerCommand(n, d) { this.commands.set(n, d); },
      registerMessageRenderer(n, f) { this.messageRenderer = f; this.rendererName = n; },
      registerEntryRenderer(n, f) { this.entryRenderer = f; },
      sendMessage(m, o) {
         if (this.failSend || this.failSendIds?.has(m.details?.id)) throw new Error("send failed");
         this.messages.push({ m, o });
      },
      getAllTools() { return [...this.registered.values()].map((d) => ({ name: d.name, description: d.description, promptSnippet: d.promptSnippet })); },
      setActiveTools(ns) { if (this.failActive) throw new Error("active failed"); this.active = new Set(ns); },
      on(e, h) { if (!this.handlers.has(e)) this.handlers.set(e, []); this.handlers.get(e).push(h); },
      async emit(e, c) { for (const h of this.handlers.get(e) ?? []) await h({}, c); }
   };
   return p;
}
function context(over = {}) {
   return {
      mode: "tui", hasUI: true, cwd: scratch,
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent" },
      modelRegistry: { getAvailable: () => [] }, model: { provider: "offline", id: "model" },
      ui: { notify() {}, setWidget() {}, custom: async () => {} }, isIdle: () => true, ...over
   };
}
function agent(name = "worker", extra = {}) {
   return { name, description: `description ${name}`, tools: ["read", "write"], enabled: true, source: "global", systemPrompt: "one\ntwo\nthree", ...extra };
}
function manager(vm, ctx = undefined, runtime = undefined, opts = {}) {
   const tui = { terminal: { rows: 30 }, requestRender() {} };
   let closed = false;
   const m = new panel.FullScreenAgentsManager(tui, theme, keys, runtime, () => { closed = true; }, undefined, ctx, { initialViewModel: vm, ...opts });
   return { m, tui, closed: () => closed };
}
const detail = (m) => m.handleInput("\r");
const down = (m, n) => { for (let i = 0; i < n; i++) m.handleInput("\x1b[B"); };

 test("public panel helpers and editor cover boundaries", () => {
   const vm = panel.buildAgentsPanelViewModel({ agents: [agent()] });
   assert.equal(panel.createAgentsPanelState({ selectedIndex: 3 }).selectedIndex, 3);
   assert.equal(panel.detailFieldsFor().length, 7);
   assert.equal(panel.getSelectedDescription(panel.createAgentsPanelState(), vm), vm.agents[0].description);
   assert.equal(panel.getSelectedDescription(panel.createAgentsPanelState(), undefined), undefined);
   assert.deepEqual(panel.agentDisplayTags({ ...agent(), source: "builtin", isOverride: true }), ["built-in", "override"]);
   assert.deepEqual(panel.agentDisplayTags(agent()), []);
   panel.renderAgentDescriptionPanel(undefined, 0, theme);
   panel.renderAgentDescriptionPanel("long description", 8, theme, 1);
   const list = { agents: [agent(), agent("two", { enabled: false })] };
   let s = panel.createAgentsPanelState();
   for (const k of ["tab", "right", "l", "left", "h", "down", "j", "up", "k", "z", "enter", "escape", "q"]) {
      panel.reduceAgentsPanelKey(s, { key: k }, list); panel.reduceAgentsPanelKey(s, { key: k }, undefined);
   }
   s = { ...s, viewMode: "detail", detailFieldIndex: 99 };
   for (const k of ["escape", "q", "backspace", "up", "k", "down", "j", " ", "space", "enter", "right", "l", "left", "h", "x"])
      for (let i = 0; i < 7; i++) panel.reduceAgentsPanelKey({ ...s, detailFieldIndex: i }, { key: k }, list);
   panel.reduceAgentsPanelKey(s, { key: "enter" }, { agents: [] });
   const e = new panel.BodyEditor(); e.setValue("ab\ncd\nef");
   for (const x of ["", "\r", "\n", "\x7f", "\x08", "\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "\x1b[5~", "text"]) e.handleInput(x);
   e.moveCursorVertical(-1); e.moveCursorVertical(1);
   const one = new panel.BodyEditor(); one.setValue("one"); one.moveCursorVertical(-1); one.moveCursorVertical(1);
   assert.equal(typeof e.getValue(), "string");
 });

test("panel manager renders all screens and handles editing", async () => {
   const vm = { agents: [agent("worker", { source: "builtin" }), agent("second", { enabled: false, filePath: "/tmp/s.md" })] };
   const c = context({ modelRegistry: { getAvailable: () => ["m1", { provider: "p", id: "x" }, { provider: "p", id: "p/y" }, { id: "solo" }, {}, "m1"] } });
   const tools = { getAllTools: () => ["string", { name: "meta", description: "metadata", promptSnippet: "snip", promptGuidelines: ["guide"], source: "src" }, { name: "path", sourceInfo: { path: "/tmp" } }] };
   const { m } = manager(vm, c, tools, { getAllTools: () => [{ name: "option", description: "option" }] });
   m.focused = true; assert.equal(m.focused, true); m.focused = false; m.render(80);
   detail(m); m.render(80); m.handleInput("\x1b[B"); m.handleInput(" "); m.handleInput("\x13"); await new Promise(r => setTimeout(r, 30));
   // model picker, filter, commit; thinking picker cancel/commit
   m.handleInput("\x1b[B"); m.handleInput("\r"); m.render(80); m.handleInput("m"); m.handleInput("\x1b[B"); m.handleInput("\r");
   m.handleInput("\x1b[B"); m.handleInput("\r"); m.render(80); m.handleInput("\x1b");
   // tools picker: render metadata, toggle, select all/none, paging, commit
   m.handleInput("\x1b[B"); m.handleInput("\r"); m.render(80);
   for (const x of [" ", "a", "n", "\x1b[5~", "\x1b[6~", "\r"]) m.handleInput(x);
   // description text edit cancel then save
   m.handleInput("\x1b[B"); m.handleInput("\r"); m.handleInput("X"); m.handleInput("\x1b"); m.handleInput("\r"); m.handleInput("Y"); m.handleInput("\x13"); await new Promise(r => setTimeout(r, 30));
   // body editor dirty/cancel and save
   m.handleInput("\x1b[B"); m.handleInput("\r"); m.render(80); m.handleInput("Z"); m.render(80); m.handleInput("\x1b"); m.render(80); m.handleInput("\x1b");
   m.handleInput("\r"); m.handleInput("Q"); m.handleInput("\x13"); await new Promise(r => setTimeout(r, 30)); m.render(80); m.handleInput("\x1b");
   // detail dirty confirmation/revert
   m.handleInput("\x1b[B"); m.handleInput(" "); m.handleInput("\x1b"); m.handleInput("\x1b");
   // creation fallback, invalid name, valid name, intent
   m.handleInput("n"); for (const x of "!!!") m.handleInput(x); m.handleInput("\r"); m.render(80);
   for (const x of "new-profile") m.handleInput(x); m.handleInput("\r"); for (const x of "offline work") m.handleInput(x); m.handleInput("\r");
   await new Promise(r => setTimeout(r, 80)); m.render(80); m.handleInput("\x1b"); m.handleInput("\x1b"); m.handleInput("d");
   m.invalidate(); m.dispose(); m.dispose();
 });

test("panel discovers supported registry shapes and opens UI", async () => {
   const vm = { agents: [agent()] };
   const contexts = [
      { getAllTools: () => ["a", { name: "b" }], getTools: () => ["c", { name: "d" }], toolRegistry: { getAll: () => ["e", { name: "f" }] } },
      { pi: { getAllTools: () => [{ name: "pi" }] }, getTools: () => ({ named: { description: "d" }, blank: {} }), toolRegistry: { getTools: () => [{ name: "reg" }] } },
      { tools: { object: { promptSnippet: "s" } }, toolRegistry: { tools: [{ name: "array" }] } },
      { getAllTools: () => { throw new Error("offline"); }, toolRegistry: {} }
   ];
   for (const c of contexts) { const { m } = manager(vm, { ...c, hasUI: true, cwd: scratch, ui: { notify() {} } }); detail(m); down(m, 4); m.handleInput("\r"); m.render(80); m.dispose(); }
   for (const modelRegistry of [{ getAvailable: () => ["x", { provider: "p", id: "x" }, { id: "solo" }, {}] }, { getAvailable: () => { throw new Error("offline"); } }, undefined]) {
      const { m } = manager(vm, { hasUI: true, cwd: scratch, ui: { notify() {} }, modelRegistry }); detail(m); down(m, 2); m.handleInput("\r"); m.render(80); m.dispose();
   }
   await panel.openAgentsPanel({ hasUI: false, ui: {} }, undefined);
   let made;
   await panel.openAgentsPanel({ hasUI: true, cwd: scratch, ui: { custom: async (factory, options) => { made = { m: factory({ terminal: { rows: 20 }, requestRender() {} }, theme, keys, () => {}), options }; } } }, undefined, { initialViewModel: vm });
   assert.equal(made.options.overlay, true); made.m.dispose();
 });

test("extension lifecycle, fake Pi API, widget, messages, and delivery", async () => {
   const p = piFake(); const r = ext.registerAgentsExtension(p); const parent = context({ isIdle: () => false });
   await p.emit("resources_discover", parent); await p.emit("session_start", parent); await p.emit("session_start", parent);
   assert.ok(p.commands.has("wr.close"));
   const spawn = p.registered.get("agent_spawn");
   assert.equal((await spawn.execute("x", { agents: [] }, undefined, undefined, parent)).details.ok, false);
   assert.equal((await spawn.execute("x", {}, undefined, undefined, parent)).details.ok, false);
   assert.equal((await p.registered.get("agent_list").execute("x", {}, undefined, undefined, parent)).details.ok, true);
   assert.equal((await p.registered.get("agent_cancel").execute("x", { id: "missing" }, undefined, undefined, parent)).details.ok, false);
   await r.refreshAgentSpawnTool(); await r.refreshAgentSpawnTool(scratch);
   const add = (id, extra = {}) => runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.register({ id, ownerSessionId: "parent", name: id, profile: "worker", background: true, cwd: scratch, promptOrCommand: id, ...extra })));
   const wt = await add("widget", { runtimeOwned: true });
   await runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.updateStatus(wt.id, "running"))); await new Promise(x => setTimeout(x, 30));
   await runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.updateStatus(wt.id, "cancelled", { errorText: "stop" }))); await new Promise(x => setTimeout(x, 30));
   for (const [id, patch] of [["error", { status: "failed", errorText: "bad" }], ["empty", { status: "failed" }]]) { const t = await add(id); await runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.updateStatus(t.id, patch.status, patch))); }
   await new Promise(x => setTimeout(x, 20)); parent.isIdle = () => true; await p.emit("agent_end", parent); await p.emit("agent_settled", parent);
   const a = await add("ba", { batchId: "b", batchSize: 2 }); const b = await add("bb", { batchId: "b", batchSize: 2 });
   await runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.updateStatus(a.id, "completed", { resultData: "a" }))); await runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.updateStatus(b.id, "completed", { resultData: "b" }))); await new Promise(x => setTimeout(x, 20));
   for (const [msg, expanded] of [
      [{ content: "h\nb", details: {} }, false], [{ content: "h\ne", details: { status: "failed", result: "e" } }, false],
      [{ content: "h\ne", details: { status: "cancelled", result: { summary: "s" } } }, false],
      [{ content: "h", details: { result: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") } }, false], [{ content: "h", details: { result: "x\ny" } }, true], [{ content: 2, details: {} }, false]
   ]) p.messageRenderer(msg, { expanded }, theme).render(40);
   p.entryRenderer({ data: { text: "entry" } }).render(); p.entryRenderer({ data: {} }).render(); p.entryRenderer({}).render();
   p.failSend = true; const retry = await add("retry"); await runtimeMod.runTool(r.runtime, registryMod.TaskRegistry.use(reg => reg.updateStatus(retry.id, "completed", { resultData: "retry" }))); await new Promise(x => setTimeout(x, 20)); p.failSend = false; await p.emit("agent_end", parent);
   p.failActive = true; await p.emit("session_start", { ...parent, mode: "print", hasUI: false }); p.failActive = false;
   await p.emit("session_shutdown", parent); await r.runtime.dispose();
 });

test("background result delivery marks a settled task after its message is sent", async () => {
   const p = piFake();
   const r = ext.registerAgentsExtension(p);
   const parent = context();
   await p.emit("session_start", parent);
   const add = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) =>
         registry.register({
            id,
            ownerSessionId: "parent",
            name: id,
            profile: "worker",
            background: true,
            cwd: scratch,
            promptOrCommand: id,
            runtimeOwned: true
         })
      )
   );
   const updateToCompleted = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) => registry.updateStatus(id, "completed", { resultData: "done" }))
   );
   const get = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) => registry.get(id))
   );
   try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const failing = await add("delivery-failing");
      p.failSend = true;
      await updateToCompleted(failing.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await get(failing.id))?.resultDelivered, undefined);
      p.failSend = false;
      const delivered = await add("delivery-succeeds");
      await updateToCompleted(delivered.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(p.messages.some(({ m }) => m.customType === "agents-result" && m.details?.id === delivered.id));
      assert.equal((await get(delivered.id))?.resultDelivered, true);
   } finally {
      await p.emit("session_shutdown", parent);
      await r.runtime.dispose();
   }
});

test("background spawn acknowledgements do not acknowledge a fast-settled task", async () => {
   const task = {
      id: "fast-task",
      ownerSessionId: "parent",
      name: "fast",
      profile: "worker",
      cwd: scratch,
      promptOrCommand: "Return immediately",
      background: true,
      runtimeOwned: true
   };
   const fakeManagerLayer = Layer.effect(
      managerMod.AgentManager,
      Effect.gen(function* () {
         const registry = yield* registryMod.TaskRegistry;
         return {
            spawnBatch: () =>
               Effect.gen(function* () {
                  const pending = yield* registry.register(task);
                  yield* registry.updateStatus(pending.id, "running");
                  return [yield* registry.updateStatus(pending.id, "completed", { resultData: "fast output" })];
               }),
            cancelTask: () => Effect.succeed(undefined),
            pruneClosedPanes: () => Effect.succeed(0),
            markResultsDelivered: (ids) =>
               Effect.gen(function* () {
                  const marked = [];
                  for (const id of ids) {
                     const current = yield* registry.get(id);
                     if (!current || current.resultDelivered === true) continue;
                     yield* registry.updateStatus(id, current.status, { resultDelivered: true });
                     marked.push(id);
                  }
                  return marked;
               }),
            cancelActiveSessions: Effect.succeed(undefined)
         };
      })
   ).pipe(Layer.provide(registryMod.TaskRegistry.layer));
   const testRuntime = ManagedRuntime.make(
      Layer.mergeAll(
         registryMod.TaskRegistry.layer,
         sessionMod.ParentSessionGate.layer,
         persistenceMod.AgentsTaskPersistence.layer,
         fakeManagerLayer
      )
   );
   const p = piFake();
   const r = ext.registerAgentsExtension(p, { runtime: testRuntime });
   const parent = context({ isIdle: () => false });
   try {
      await p.emit("session_start", parent);
      const result = await p.registered.get("agent_spawn").execute(
         "call-fast-background",
         { agents: [{ profile: "worker", name: "fast", task: "Return immediately" }], background: true },
         undefined,
         undefined,
         parent
      );
      assert.equal(result.details.ok, true);
      assert.equal(result.details.tasks[0].status, "completed");
      const registered = await runtimeMod.runTool(
         testRuntime,
         registryMod.TaskRegistry.use((registry) => registry.get(task.id))
      );
      assert.equal(registered?.resultDelivered, undefined);
      parent.isIdle = () => true;
      await p.emit("agent_end", parent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
         p.messages.filter(({ m }) => m.customType === "agents-result").map(({ m }) => m.details?.id),
         [task.id]
      );
   } finally {
      await p.emit("session_shutdown", parent);
      await testRuntime.dispose();
   }
});


test("background batches deliver completed members when another member is cancelled", async () => {
   const p = piFake();
   const r = ext.registerAgentsExtension(p);
   let idle = false;
   const parent = context({ isIdle: () => idle });
   const add = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) =>
         registry.register({
            id,
            ownerSessionId: "parent",
            name: id,
            profile: "worker",
            background: true,
            batchId: "cancelled-batch",
            batchSize: 2,
            cwd: scratch,
            promptOrCommand: id,
            runtimeOwned: true
         })
      )
   );
   const get = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) => registry.get(id))
   );
   try {
      await p.emit("session_start", parent);
      const completed = await add("batch-completed");
      const cancelled = await add("batch-cancelled");
      await runtimeMod.runTool(
         r.runtime,
         registryMod.TaskRegistry.use((registry) =>
            registry.updateStatus(completed.id, "completed", { resultData: "completed result" })
         )
      );
      await runtimeMod.runTool(
         r.runtime,
         registryMod.TaskRegistry.use((registry) =>
            registry.updateStatus(cancelled.id, "cancelled", { errorText: "cancelled result" })
         )
      );
      idle = true;
      await p.emit("agent_settled", parent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const resultMessages = p.messages.filter(({ m }) => m.customType === "agents-result");
      assert.deepEqual(resultMessages.map(({ m }) => m.details?.id), [completed.id]);
      assert.equal((await get(cancelled.id))?.resultDelivered, undefined);
      await p.emit("agent_end", parent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(p.messages.filter(({ m }) => m.customType === "agents-result").length, 1);
   } finally {
      await p.emit("session_shutdown", parent);
      await r.runtime.dispose();
   }
});

test("background batch delivery retries only the unsent member after a partial send failure", async () => {
   const p = piFake();
   const r = ext.registerAgentsExtension(p);
   let idle = false;
   const parent = context({ isIdle: () => idle });
   const add = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) =>
         registry.register({
            id,
            ownerSessionId: "parent",
            name: id,
            profile: "worker",
            background: true,
            batchId: "partial-send-batch",
            batchSize: 2,
            cwd: scratch,
            promptOrCommand: id,
            runtimeOwned: true
         })
      )
   );
   const get = (id) => runtimeMod.runTool(
      r.runtime,
      registryMod.TaskRegistry.use((registry) => registry.get(id))
   );
   try {
      await p.emit("session_start", parent);
      const first = await add("send-first");
      const second = await add("send-second");
      p.failSendIds = new Set([second.id]);
      for (const task of [first, second]) {
         await runtimeMod.runTool(
            r.runtime,
            registryMod.TaskRegistry.use((registry) =>
               registry.updateStatus(task.id, "completed", { resultData: task.id })
            )
         );
      }
      idle = true;
      await p.emit("agent_settled", parent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
         p.messages.filter(({ m }) => m.customType === "agents-result").map(({ m }) => m.details?.id),
         [first.id]
      );
      assert.equal((await get(first.id))?.resultDelivered, true);
      assert.equal((await get(second.id))?.resultDelivered, undefined);
      p.failSendIds.clear();
      await p.emit("agent_end", parent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
         p.messages.filter(({ m }) => m.customType === "agents-result").map(({ m }) => m.details?.id),
         [first.id, second.id]
      );
      assert.equal((await get(second.id))?.resultDelivered, true);
   } finally {
      await p.emit("session_shutdown", parent);
      await r.runtime.dispose();
   }
});
test("agent-only mode and disposed runtime catches remain safe", async () => {
   const p = piFake(); p.failActive = true; const r = ext.registerAgentsExtension(p);
   await p.emit("session_start", { ...context(), mode: "print", hasUI: false }); assert.equal(p.active.size, 3);
   await r.runtime.dispose(); await p.emit("session_start", context({ sessionManager: { getSessionFile: () => "/tmp/disposed", getSessionId: () => "other" } })); await p.emit("session_shutdown", context());
 });

test("profile command supports both UI and non-UI contexts", async () => {
   const p = piFake(); const r = ext.registerAgentsExtension(p); const notices = [];
   await p.commands.get("wr.profile").handler("", context({ hasUI: false, ui: { notify: (x) => notices.push(x) } })); assert.equal(notices.length, 1);
   let custom = false; await p.commands.get("wr.profile").handler("", context({ ui: { custom: async () => { custom = true; } } })); assert.equal(custom, true);
   await p.emit("session_shutdown", context()); await r.runtime.dispose();
 });


test("panel presentation states cover picker, detail, editor, and empty-list branches", async () => {
   const vm = { agents: [agent("display", { model: "p/m", thinking: "high", tools: [], filePath: undefined })] };
   const { m } = manager(vm, undefined);
   // These are externally observable view states reached by the keyboard UI; assigning
   // them here lets the shell render each transient overlay without a real TUI loop.
   for (const state of ["create_name", "create_intent", "generating", "select_model", "select_thinking", "select_tools"]) {
      m.viewState = state;
      m.render(24);
   }
   m.viewState = "list";
   m.state = { selectedIndex: 0, viewMode: "detail", detailFieldIndex: 0, isOpen: true };
   m.renderListRows(40, 10);
   m.renderDetailScreen(40, 25);
   m.renderPickerOverlay(40, 25);
   m.buildDetailFields(38, 20);
   m.getOriginalAgent();
   for (const field of panel.AGENT_DETAIL_FIELDS) m.isFieldChanged(field);
   m.isFieldChanged("unknown");
   m.initialAgentSnapshot = "not-json";
   m.getOriginalAgent();
   await m.applyIntent({ type: "none" });
   await m.applyIntent({ type: "close_detail" });
   await m.applyIntent({ type: "open_detail" });
   m.initialAgentSnapshot = JSON.stringify(vm.agents[0]);
   m.render(24);
   m.isEditingText = true;
   m.render(24);
   m.isEditingText = false;
   for (let i = 0; i < 7; i++) {
      m.state.detailFieldIndex = i;
      m.render(24);
   }
   m.state.detailFieldIndex = 6;
   m.isEditingBody = true;
   m.systemPromptEditor.setValue("a very long line that wraps\nsecond line");
   m.initialBodyValue = "original";
   m.pendingEscConfirm = true;
   m.render(24);
   m.pendingEscConfirm = false;
   m.render(80);
   m.isEditingBody = false;
   m.state.viewMode = "list";
   m.viewModel = { agents: [] };
   m.render(24);
   m.viewModel = undefined;
   m.render(24);
   m.dispose();

   const empty = manager({ agents: [] }).m;
   empty.state = { selectedIndex: 0, viewMode: "detail", detailFieldIndex: 0, isOpen: true };
   empty.viewModel = { agents: [] };
   empty.render(24);
   empty.dispose();
});

assert.equal(typeof ext.registerAgentsExtension, "function");
assert.equal(typeof panel.FullScreenAgentsManager, "function");
