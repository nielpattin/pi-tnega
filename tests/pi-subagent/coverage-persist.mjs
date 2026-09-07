import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadExtension } from "../_bootstrap.mjs";

const { Effect, Layer, ManagedRuntime } = await import("effect");
const manifest = await loadExtension("extensions/pi-subagent/src/services/task-manifest.ts");
const persistence = await loadExtension("extensions/pi-subagent/src/services/task-persistence.ts");
const registry = await loadExtension("extensions/pi-subagent/src/services/task-registry.ts");
const manager = await loadExtension("extensions/pi-subagent/src/services/agent-manager.ts");
const session = await loadExtension("extensions/pi-subagent/src/services/task-session.ts");

const baseTask = (overrides = {}) => ({
   id: "task-1", ownerSessionId: "parent", name: "job", profile: "worker",
   model: "model", thinking: "high", cwd: "/tmp", context: "ctx", contextTokens: 10,
   batchId: "batch", batchSize: 1, promptOrCommand: "do it", systemPrompt: "system",
   status: "pending", createdAt: 100, startedAt: 101, settledAt: undefined,
   resultData: undefined, errorText: undefined, transcript: undefined, usage: undefined,
   sessionFile: "/tmp/child.jsonl", paneId: "pane", sessionId: "sid", ...overrides
});
function fakeFs(initial = {}) {
   const files = new Map(Object.entries(initial));
   const calls = [];
   const fs = {
      mkdir: async (dir) => { calls.push(["mkdir", dir]); },
      readdir: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
      readFile: async (p) => files.get(p),
      writeFile: async (p, data, options) => {
         calls.push(["write", p, options?.flag]);
         if (options?.flag === "wx" && files.has(p)) { const e = new Error("exists"); e.code = "EEXIST"; throw e; }
         files.set(p, data);
      },
      rename: async (a, b) => { calls.push(["rename", a, b]); const value = files.get(a); if (value === undefined) { const e = new Error("missing"); e.code = "ENOENT"; throw e; } files.delete(a); files.set(b, value); },
      unlink: async (p) => { calls.push(["unlink", p]); if (!files.delete(p)) { const e = new Error("missing"); e.code = "ENOENT"; throw e; } },
      sync: async (p) => { calls.push(["sync", p]); },
      syncDir: async (p) => { calls.push(["syncDir", p]); }
   };
   return { fs, files, calls };
}
function validIndex(task = baseTask()) {
   return { version: 1, parentSessionFile: "/tmp/parent.jsonl", writtenAt: 10, reservedTaskSeq: 9,
      summary: { totalJobs: 1, truncatedJobs: 0, droppedStringChars: 0, droppedArrayItems: 0, droppedJobs: 0 }, jobs: [task] };
}

// Pure normalization cases deliberately use direct calls, including values JSON.stringify cannot handle.
test("manifest normalizer handles JSON-ish values, cycles, getters, and bounds", () => {
   const s = { truncated: false, droppedStringChars: 0, droppedArrayItems: 0 };
   const cycle = {}; cycle.self = cycle;
   const throwing = Object.create(null);
   Object.defineProperty(throwing, "bad", { enumerable: true, get() { throw new Error("getter"); } });
   const values = [null, undefined, true, 1, "ok", 1n, Symbol("s"), () => 1, new Date("2020-01-01"), cycle, [undefined, 1], throwing];
   for (const value of values) assert.notEqual(manifest.toPersistableValue(value, { depth: 0, seen: new Set(), path: "x" }, s), undefined);
   const nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } };
   assert.ok(manifest.toPersistableValue(nested, { depth: 0, seen: new Set(), path: "x" }, s));
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxPersistedStringChars = 5;
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxPersistedArrayLength = 1;
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxPersistedNestingDepth = 8;
   const bounded = manifest.normalizePersistedTask(baseTask({ id: "éééééé", promptOrCommand: "abcdefgh", resultData: [1, 2], transcript: [{ type: "user", text: "long text" }] }));
   assert.equal(bounded.truncated, true);
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxPersistedStringChars = 0;
   assert.equal(manifest.normalizePersistedTask(baseTask()).task.id, "");
   manifest.resetManifestLimits();
   assert.equal(manifest.normalizePersistedTask(baseTask()).truncated, false);
});

test("manifest retention, ids, and hard size reductions", () => {
   const jobs = [
      baseTask({ id: "task-2", status: "completed", createdAt: 1, settledAt: 2 }),
      baseTask({ id: "task-3", status: "failed", createdAt: 2, settledAt: 3 }),
      baseTask({ id: "task-4", status: "cancelled", createdAt: 3, settledAt: 4 }),
      baseTask({ id: "task-5", status: "running", createdAt: 4 }),
      baseTask({ id: "weird", status: "running", createdAt: 5 })
   ];
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxTerminalAgeMs = 1_000_000_000;
   assert.deepEqual(manifest.pruneTerminalTasksForRetention(jobs, 100, 3).map((x) => x.id), ["task-4", "task-5", "weird"]);
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxTerminalAgeMs = 50;
   assert.deepEqual(manifest.pruneTerminalTasksForRetention(jobs, 1_000_000_000, 99).map((x) => x.id), ["task-5", "weird"]);
   manifest.resetManifestLimits();
   manifest.AGENTS_TASK_MANIFEST_LIMITS.maxPersistedManifestBytes = 100;
   const result = manifest.buildPersistedIndex([baseTask({ id: "task-99", promptOrCommand: "x".repeat(1000), errorText: "e".repeat(1000), resultData: { x: "y" } })], "/tmp/parent.jsonl");
   assert.equal(result.index.version, 1); assert.equal(result.index.jobs.length, 0); assert.equal(result.summary.droppedJobs, 1);
   manifest.resetManifestLimits();
});

const acceptedTranscript = [
   { type: "user", text: "u", timestamp: 1 }, { type: "thinking", text: "t" }, { type: "assistant", text: "a" }, { type: "error", text: "e" },
   { type: "tool-call", toolCallId: "c", toolName: "n", arguments: { a: 1 }, raw: [true], timestamp: 2 },
   { type: "tool-result", toolCallId: "c", toolName: "n", content: [{ type: "text", text: "out" }, { type: "image", mimeType: "image/png" }], isError: false, raw: { ok: true } }
];
test("manifest parser accepts valid shapes and rejects malformed ones", () => {
   const noSession = validIndex(baseTask({ id: "task-7", transcript: acceptedTranscript, usage: { cost: 1, toolCalls: 2, contextTokens: 3 }, status: "recoverable", sessionFile: undefined }));
   assert.equal(manifest.parsePersistedIndex(noSession).jobs[0].status, "failed");
   const good = validIndex(baseTask({ id: "task-7", transcript: acceptedTranscript, usage: { cost: 1, toolCalls: 2, contextTokens: 3 } }));
   assert.equal(manifest.parsePersistedIndex(good).jobs[0].id, "task-7");
   assert.equal(manifest.parsePersistedTaskEntry(good.jobs[0]).id, "task-7");
   const bads = [null, [], {}, { ...good, version: 2 }, { ...good, extra: 1 }, { ...good, jobs: "x" }, { ...good, jobs: [good.jobs[0], good.jobs[0]] },
      { ...good, summary: { totalJobs: -1, truncatedJobs: 0, droppedStringChars: 0, droppedArrayItems: 0, droppedJobs: 0 } }, { ...good, reservedTaskSeq: 1.2 }, { ...good, writtenAt: Infinity },
      { ...good, jobs: [{ id: "", ownerSessionId: "p", promptOrCommand: "x", status: "pending", createdAt: 1 }] }];
   for (const bad of bads) assert.equal(manifest.parsePersistedIndex(bad), undefined);
   const optionalBad = ["ownerSessionId", "promptOrCommand", "status", "createdAt", "name", "origin", "startedAt", "settledAt", "async", "model", "thinking", "cwd", "context", "contextTokens", "batchId", "batchSize", "errorText", "systemPrompt", "sessionFile", "paneId", "sessionId"];
   for (const key of optionalBad) { const x = structuredClone(good); x.jobs = [structuredClone(good.jobs[0])]; x.jobs[0][key] = key === "status" ? "bad" : {}; assert.equal(manifest.parsePersistedIndex(x), undefined, key); }
   for (const key of ["resultData", "transcript", "usage"]) { const x = structuredClone(good); x.jobs[0][key] = key === "usage" ? { cost: 1 } : key === "transcript" ? [{ type: "bad" }] : 1n; assert.equal(manifest.parsePersistedIndex(x), undefined); }
   assert.equal(manifest.parsePersistedTaskEntry({ ...baseTask(), background: true }), undefined);
});

test("registry lifecycle, limits, restoration, and notifications", async () => {
   const rt = ManagedRuntime.make(registry.TaskRegistry.layer);
   const use = (f) => rt.runPromise(registry.TaskRegistry.use(f));
   const changes = [], settled = [];
   const unsubChange = await use((r) => r.onChange((x) => { changes.push(x); throw new Error("listener"); }));
   const unsubSettle = await use((r) => r.onSettled((x) => { settled.push(x); throw new Error("settled"); }));
   const t = await use((r) => r.register({ id: "task-1", ownerSessionId: "p", name: "n", promptOrCommand: "p" }));
   await use((r) => r.register({ id: "task-2", ownerSessionId: "p", name: null, promptOrCommand: "p" }));
   await assert.rejects(() => use((r) => r.register({ id: "task-1", ownerSessionId: "p", name: null, promptOrCommand: "p" })), /already exists/);
   assert.equal((await use((r) => r.list({ status: "pending" }))).length, 2); assert.equal(await use((r) => r.get("missing")), undefined);
   const running = await use((r) => r.updateStatus(t.id, "running", { profile: "w" })); assert.equal(running.startedAt !== undefined, true);
   await use((r) => r.updateStatus(t.id, "completed")); await use((r) => r.updateStatus(t.id, "completed")); assert.equal(settled.length, 1);
   assert.equal(changes.length, 5); assert.equal(unsubChange(), true); assert.equal(unsubChange(), false); assert.equal(unsubSettle(), true); assert.equal(unsubSettle(), false);
   await assert.rejects(() => use((r) => r.updateStatus("no", "running")), /not found/);
   await use((r) => r.clear()); const restored = await use((r) => r.restore(baseTask({ id: "task-8" }))); assert.equal(restored.id, "task-8");
   assert.equal((await use((r) => r.restore(baseTask({ id: "task-8", promptOrCommand: "new" })))).promptOrCommand, "do it");
   await use((r) => r.replaceAll([baseTask()]));
   await use((r) => r.clear());
   for (let i = 0; i < 64; i += 1) await use((r) => r.register({ id: `fill-${i}`, ownerSessionId: "p", name: null, promptOrCommand: "p" }));
   await use((r) => r.updateStatus("fill-0", "completed"));
   await use((r) => r.register({ id: "new", ownerSessionId: "p", name: null, promptOrCommand: "p" }));
   assert.equal(await use((r) => r.get("fill-0")), undefined);
   await assert.rejects(() => use((r) => r.restore(baseTask({ id: "other" }))), /full/);
   await assert.rejects(() => use((r) => r.register({ id: "task-2", ownerSessionId: "p", name: null, promptOrCommand: "p" })), /full/);
   await assert.rejects(() => use((r) => r.replaceAll(Array.from({ length: 65 }, (_, i) => baseTask({ id: `too-many-${i}` })))), /full/);
   await rt.dispose();
});

test("persistence config, load, persist, listeners, migration, and atomic writes", async () => {
   const parent = join(mkdtempSync(join(tmpdir(), "agents-cov-")), "parent.jsonl"); const empty = fakeFs();
   const rt = ManagedRuntime.make(persistence.AgentsTaskPersistence.layerWith(empty.fs)); const use = (f) => rt.runPromise(persistence.AgentsTaskPersistence.use(f));
   assert.equal(await use((p) => p.currentDir()), undefined); assert.deepEqual(await use((p) => p.load()), { version: 1, jobs: [] }); await use((p) => p.configure(parent));
   assert.equal(await use((p) => p.currentTarget()), parent); await use((p) => p.persist([baseTask()])); await use((p) => p.flush()); assert.equal((await use((p) => p.load())).jobs.length, 1);
   const unsub = () => {}; await use((p) => p.setChangeListener(unsub)); assert.equal(await use((p) => p.takeChangeListener()), unsub); assert.equal(await use((p) => p.takeChangeListener()), undefined);
   const writer = { schedule() {}, async flush() {} }; await use((p) => p.setChangeWriter(writer)); assert.equal(await use((p) => p.takeChangeWriter()), writer); await use((p) => p.configure(null)); assert.equal(await use((p) => p.currentTarget()), undefined); await rt.dispose();
});

test("persistence corruption quarantine and write failures", async () => {
   const parent = join(mkdtempSync(join(tmpdir(), "agents-cov-")), "parent.jsonl"); const dir = parent.slice(0, -6); const final = join(dir, "agents-tasks.json"); const final0 = final; const good = JSON.stringify(validIndex()); const f = fakeFs({ [final0]: good });
   const rt = ManagedRuntime.make(persistence.AgentsTaskPersistence.layerWith(f.fs)); const use = (fn) => rt.runPromise(persistence.AgentsTaskPersistence.use(fn)); await use((p) => p.configure(parent)); assert.equal((await use((p) => p.load())).jobs.length, 1);
   f.files.set(final, "not json"); assert.deepEqual((await use((p) => p.load())).jobs, []); await use((p) => p.configure(parent)); f.fs.writeFile = async () => { throw new Error("disk full"); }; await assert.rejects(() => use((p) => p.persist([baseTask()])), /Failed to persist/); await rt.dispose();
});

test("persistence restores newest valid backup and exercises Windows replacement", async () => {
   const parent = join(mkdtempSync(join(tmpdir(), "agents-backup-")), "parent.jsonl");
   const dir = parent.slice(0, -6); const final = join(dir, "agents-tasks.json");
   const f = fakeFs({ [final]: "bad", [join(dir, "agents-tasks.json.bak-100-old")]: JSON.stringify(validIndex()), [join(dir, "agents-tasks.json.bak-200-new")]: "bad" });
   const rt = ManagedRuntime.make(persistence.AgentsTaskPersistence.layerWith(f.fs)); const use = (fn) => rt.runPromise(persistence.AgentsTaskPersistence.use(fn));
   await use((p) => p.configure(parent)); assert.equal((await use((p) => p.load())).jobs.length, 1); await rt.dispose();

   const f2 = fakeFs({ [final]: JSON.stringify(validIndex()) }); let first = true; const originalRename = f2.fs.rename;
   f2.fs.rename = async (a, b) => { if (first && b === final) { first = false; const e = new Error("sharing"); e.code = "EPERM"; throw e; } return originalRename(a, b); };
   const rt2 = ManagedRuntime.make(persistence.AgentsTaskPersistence.layerWith(f2.fs)); const use2 = (fn) => rt2.runPromise(persistence.AgentsTaskPersistence.use(fn));
   await use2((p) => p.configure(parent)); await use2((p) => p.persist([baseTask({ promptOrCommand: "replacement" })])); assert.equal((await use2((p) => p.load())).jobs[0].promptOrCommand, "replacement"); await rt2.dispose();
});

test("coalescing writer handles immediate, debounce, flush and errors", async () => {
   const calls = []; let reject = false; const p = { persist: (jobs) => { calls.push(jobs); return reject ? Effect.fail(new Error("no disk")) : Effect.succeed(undefined); } }; const w = persistence.createRegistryChangeWriter(p);
   w.schedule([baseTask()]); await w.flush(); w.schedule([baseTask({ status: "running" })]); await w.flush(); w.schedule([baseTask({ status: "completed" })]); await w.flush(); reject = true; w.schedule([baseTask({ status: "running" })]); await w.flush(); assert.equal(calls.length, 4);
});

test("interrupted tasks are marked failed and parent gate state transitions", async () => {
   const withFile = persistence.markInterruptedTaskFailed(baseTask({ status: "running", sessionFile: "x" })); const noFile = persistence.markInterruptedTaskFailed(baseTask({ status: "running", sessionFile: undefined }));
   assert.equal(withFile.status, "failed"); assert.equal(noFile.status, "failed"); assert.match(withFile.errorText, /marked failed/);
   const rt = ManagedRuntime.make(session.ParentSessionGate.layer); const use = (fn) => rt.runPromise(session.ParentSessionGate.use(fn)); assert.equal(await use((g) => g.stateFor("p")), "idle"); await use((g) => g.markBusy("p"));
   assert.equal(await use((g) => g.stateFor("p")), "idle"); const waiting = use((g) => g.awaitReady("p")); await use((g) => g.markReady()); await waiting; assert.equal(await use((g) => g.stateFor("p")), "ready");
   await use((g) => g.markBusy("p")); await use((g) => g.markFailed("bad", "p")); await assert.rejects(() => use((g) => g.awaitReady("p")), /bad/); await use((g) => g.markBusy("q")); await assert.rejects(() => use((g) => g.awaitReady("p")), /mismatch/);
   await use((g) => g.markFailed(new Error("boom"), "q")); await assert.rejects(() => use((g) => g.awaitReady("q")), /boom/); await use((g) => g.markBusy("q")); await use((g) => g.markReady()); assert.equal(await use((g) => g.stateFor(null)), "idle"); await rt.dispose();
});

test("parent activation runs offline with fake filesystem and manager dependencies", async () => {
   const parent = join(mkdtempSync(join(tmpdir(), "agents-activate-")), "parent.jsonl"); const f = fakeFs();
   const base = Layer.mergeAll(registry.TaskRegistry.layer, session.ParentSessionGate.layer, persistence.AgentsTaskPersistence.layerWith(f.fs));
   const live = Layer.mergeAll(manager.AgentManager.layer.pipe(Layer.provideMerge(base)), base); const rt = ManagedRuntime.make(live);
   await rt.runPromise(session.activateParentSession(parent));
   await rt.runPromise(session.ensureParentSessionReady(parent));
   await rt.runPromise(session.flushPendingWrites());
   await rt.runPromise(session.startTaskPersistenceListener());
   await rt.runPromise(session.ensureParentSessionReady(undefined));
   await rt.dispose();
});


test("default node filesystem and activation failure cleanup", async () => {
   const parent = join(mkdtempSync(join(tmpdir(), "agents-nodefs-")), "parent.jsonl");
   const rt = ManagedRuntime.make(persistence.AgentsTaskPersistence.layer);
   await rt.runPromise(persistence.AgentsTaskPersistence.use((p) => p.configure(parent)));
   await rt.runPromise(persistence.AgentsTaskPersistence.use((p) => p.persist([baseTask()])));
   assert.equal((await rt.runPromise(persistence.AgentsTaskPersistence.use((p) => p.load()))).jobs.length, 1);
   await rt.runPromise(persistence.AgentsTaskPersistence.use((p) => p.configure(undefined)));
   await rt.dispose();

   const failingFs = fakeFs(); failingFs.fs.mkdir = async () => { throw new Error("mkdir failed"); };
   const base = Layer.mergeAll(registry.TaskRegistry.layer, session.ParentSessionGate.layer, persistence.AgentsTaskPersistence.layerWith(failingFs.fs));
   const live = Layer.mergeAll(manager.AgentManager.layer.pipe(Layer.provideMerge(base)), base);
   const badRt = ManagedRuntime.make(live);
   await assert.rejects(() => badRt.runPromise(session.activateParentSession(parent)), /mkdir failed/);
   await badRt.dispose();
});
