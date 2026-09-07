import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadExtension } from "../_bootstrap.mjs";

const dir = mkdtempSync(join(tmpdir(), "pi-subagent-coverage-"));
const activity = await loadExtension("extensions/pi-subagent/src/shared/agent-activity.ts");
const completion = await loadExtension("extensions/pi-subagent/src/shared/agent-completion.ts");
const childDir = await loadExtension("extensions/pi-subagent/src/shared/child-session-dir.ts");
const compaction = await loadExtension("extensions/pi-subagent/src/shared/compaction.ts");
const child = await loadExtension("extensions/pi-subagent/src/shared/child-session.ts");
const processModule = await loadExtension("extensions/pi-subagent/src/shared/agent-process.ts");
const runner = await loadExtension("extensions/pi-subagent/src/shared/agent-runner.ts");
const childExtension = await loadExtension("extensions/pi-subagent/src/agent-child.ts");
const managerModule = await loadExtension("extensions/pi-subagent/src/services/agent-manager.ts");
const runtimeModule = await loadExtension("extensions/pi-subagent/src/runtime.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validState = (id = "id") => activity.createAgentActivityState(id, 10);
const ops = (overrides = {}) => ({ available: () => true, createTab: () => ({ tabId: "tab", rootPaneId: "root" }), createPane: () => "pane", runScript: () => {}, readPane: () => "", inspectPane: async () => "present", closePane: () => {}, closeTab: () => {}, renamePane: () => {}, sendText: () => {}, ...overrides });

test("child session directories and compaction policy handle documented inputs", () => {
  assert.equal(childDir.deriveChildSessionDirectory(undefined), undefined); assert.equal(childDir.deriveChildSessionDirectory(null), undefined); assert.equal(childDir.deriveChildSessionDirectory("/tmp/a.txt"), undefined); assert.equal(childDir.deriveChildSessionDirectory("/tmp/.jsonl"), undefined); assert.equal(childDir.deriveChildSessionDirectory("/tmp/parent.jsonl"), "/tmp/parent");
  const applied = []; const settings = { getGlobalSettings: () => ({}), getProjectSettings: () => ({}), applyOverrides: (x) => applied.push(x) }; compaction.ensureAutoCompactionEnabled(settings); assert.deepEqual(applied, [{ compaction: { enabled: true } }]);
  compaction.ensureAutoCompactionEnabled({ ...settings, getGlobalSettings: () => ({ compaction: { enabled: false } }) }); compaction.ensureAutoCompactionEnabled({ ...settings, getProjectSettings: () => ({ compaction: { enabled: false } }) });
  let state = compaction.createCompactionState(); for (const event of [{ type: "compaction_start" }, { type: "compaction_end" }, { type: "auto_retry_start" }, { type: "auto_retry_end" }, { type: "other" }, {}]) state = compaction.observeCompactionEvent(state, event); assert.equal(state.compacting, false); assert.equal(compaction.shouldDeferAgentEnd({ compacting: true, retrying: false }, {}), true); assert.equal(compaction.shouldDeferAgentEnd({ compacting: false, retrying: true }, {}), true); assert.equal(compaction.shouldDeferAgentEnd({ compacting: false, retrying: false }, { willRetry: true }), true); assert.equal(compaction.shouldDeferAgentEnd({ compacting: false, retrying: false }, {}), false);
});

test("activity files validate malformed and valid state", () => {
  const file = join(dir, "activity.json"); assert.equal(activity.getAgentActivityFile("x"), "x.activity.json"); assert.equal(activity.readAgentActivityFile(file, "id").reason, "missing"); const invalid = (value) => { writeFileSync(file, JSON.stringify(value)); return activity.readAgentActivityFile(file, "id"); }; assert.equal(invalid(null).error, "activity must be an object"); assert.equal(invalid([]).error, "activity must be an object"); const base = { ...validState(), activeScope: "agent", activeSince: 1, waitingSince: 2, turnIndex: 1, toolStartedAt: 3, toolEndedAt: 4, messageEventType: "x", toolCallId: "c", toolName: "n" }; assert.equal(invalid({ ...base, version: 2 }).error, "unsupported activity version"); assert.equal(invalid({ ...base, runningChildId: "other" }).reason, "wrong-id"); assert.equal(invalid({ ...base, latestEvent: "bad" }).error, "unknown latestEvent"); assert.equal(invalid({ ...base, phase: "bad" }).error, "unknown phase"); assert.equal(invalid({ ...base, activeScope: "bad" }).error, "unknown activeScope"); assert.equal(invalid({ ...base, createdAt: Infinity }).error, "invalid activity timing"); assert.equal(invalid({ ...base, agentActive: "yes" }).error, "invalid activity flags"); assert.equal(invalid({ ...base, turnIndex: NaN }).error, "invalid activity number"); assert.equal(invalid({ ...base, toolName: "x\n" }).error, "invalid activity text"); writeFileSync(file, "{"); assert.match(activity.readAgentActivityFile(file, "id").error, /Expected property/); writeFileSync(file, JSON.stringify(base)); assert.equal(activity.readAgentActivityFile(file, "id").ok, true); activity.writeAgentActivityFile(file, base); assert.equal(activity.readAgentActivityFile(file, "id").ok, true);
});

test("activity recorder publishes all lifecycle state", async () => {
  const file = join(dir, "rec", "activity.json"); let now = 1000; const r = activity.createAgentActivityRecorder({ runningChildId: "r", activityFile: file, now: () => now }); r.sessionStart(); r.input(); r.beforeAgentStart(); r.agentStart(); r.agentEndWaiting(); r.turnStart(3); r.beforeProviderRequest(); r.messageUpdate("delta"); r.toolExecutionStart("c", "n"); r.toolCall(); r.toolExecutionUpdate(); r.toolResult(); r.afterProviderResponse(); r.toolExecutionEnd(); r.turnEnd(); now += 301; r.messageUpdate("x"); await delay(5); r.subagentDone(); assert.equal(activity.readAgentActivityFile(file, "r").activity.phase, "done"); const noop = activity.createAgentActivityRecorder({}); noop.sessionStart(); noop.sessionShutdown(); const bad = activity.createAgentActivityRecorder({ runningChildId: "b", activityFile: "/dev/null/nope", now: () => 1 }); bad.input(); bad.input(); bad.input(); bad.input();
});

test("completion monitor covers sidecars, stats, terminal, pane and process evidence", async () => {
  assert.deepEqual(completion.interpretAgentExitSidecar({ type: "done" }), { reason: "done", exitCode: 0 }); assert.deepEqual(completion.interpretAgentExitSidecar({ type: "ping", name: "", message: 3 }), { reason: "ping", exitCode: 0, ping: { name: "agent", message: "" } }); assert.equal(completion.interpretAgentExitSidecar({ type: "error", errorMessage: " " }).errorMessage, "Agent exited with an error and did not provide a message."); assert.equal(completion.interpretAgentExitSidecar({ type: "unknown" }).reason, "error"); const exit = join(dir, "x.exit"); assert.equal(completion.consumeAgentExitSidecar(exit), null); writeFileSync(exit, "{"); assert.equal(completion.consumeAgentExitSidecar(exit), null); writeFileSync(exit, JSON.stringify({ type: "ping", name: "p", message: "m" })); assert.equal(completion.consumeAgentExitSidecar(exit).reason, "ping"); const stats = join(dir, "stats"); writeFileSync(stats, ["", "bad", JSON.stringify({ type: "message", message: { role: "user" } }), JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total: NaN }, totalTokens: Infinity }, content: "x" } })].join("\n")); assert.deepEqual(completion.readSessionStats(stats), { cost: 0, toolCalls: 0, contextTokens: 0 }); assert.deepEqual(completion.emptySessionStats(), { cost: 0, toolCalls: 0, contextTokens: 0 }); assert.deepEqual(completion.readSessionStats(join(dir, "absent")), { cost: 0, toolCalls: 0, contextTokens: 0 }); const wait = async (options) => completion.waitForAgentCompletion(new AbortController().signal, { exitFile: join(dir, "none"), intervalMs: 25, paneDisappearanceGraceMs: 0, ...options }); assert.deepEqual(await wait({ readTerminalTail: async () => "__PI_AGENT_DONE_0__" }), { reason: "done", exitCode: 0 }); assert.equal((await wait({ readTerminalTail: async () => "__PI_AGENT_DONE_-2__" })).exitCode, -2); assert.equal((await wait({ readTerminalTail: async () => { throw new Error("read"); }, processExited: () => 7 })).exitCode, 7); assert.equal((await wait({ inspectPane: async () => "missing" })).exitCode, 1); let checks = 0; assert.equal((await wait({ inspectPane: async () => { throw new Error("gone"); }, readTerminalTail: async () => "", processExited: () => (++checks > 1 ? 3 : null), onTick: () => {} })).exitCode, 3); const ctl = new AbortController(); ctl.abort(); await assert.rejects(completion.waitForAgentCompletion(ctl.signal, { exitFile: join(dir, "none") }), /Aborted/);
});

test("child resources, managers, trust and disposal are bounded", async () => {
  const resources = await child.createChildResources({ cwd: dir, projectTrusted: true, agentDir: join(dir, "agent"), additionalExtensionPaths: [], appendSystemPrompt: ["x"] }); assert.ok(resources.loader); assert.ok(resources.settingsManager); assert.deepEqual(child.getChildExtensionPathsForTools(["read"], dir), []); assert.deepEqual(child.getChildExtensionPathsForTools(["web_search"], "/dev/null"), []); assert.ok(child.createChildSessionManager(dir, undefined)); assert.ok(child.createChildSessionManager(dir, join(dir, "p.jsonl"), join(dir, "explicit"))); assert.equal(child.resolveStandaloneChildProjectTrust({ parentCwd: dir, childCwd: dir, parentTrusted: true }), true); assert.equal(child.resolveStandaloneChildProjectTrust({ parentCwd: dir, childCwd: join(dir, "other"), parentTrusted: false, agentDir: "/dev/null" }), false); const session = { extensionRunner: { hasHandlers: (x) => x === "session_shutdown", emit: async () => {} }, dispose: () => {} }; const first = child.shutdownAndDisposeChildSession(session, { timeoutMs: 1 }); assert.equal(first, child.shutdownAndDisposeChildSession(session)); await first; const thrown = { extensionRunner: { hasHandlers: () => true, emit: () => { throw new Error("emit"); } }, dispose: () => { throw new Error("dispose"); } }; await child.shutdownAndDisposeChildSession(thrown, { timeoutMs: 1 }); await child.shutdownAndDisposeChildSession({ extensionRunner: { hasHandlers: () => false, emit: async () => {} }, dispose: () => {} });
});

test("agent process explicitly preserves the global append system prompt source", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi subagent cwd 'append-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi subagent agent 'append-"));
  const globalSource = join(agentDir, "APPEND_SYSTEM.md");
  writeFileSync(globalSource, "global append guidance");
  const projectSource = join(cwd, ".pi", "APPEND_SYSTEM.md");
  const request = { id: "append", name: "Append", prompt: "go", cwd, sessionFile: join(cwd, "append.jsonl"), piCommand: "fake" };
  assert.equal(processModule.resolveAppendSystemPromptSource(cwd, agentDir), globalSource);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const globalCommand = processModule.buildAgentCommand(request);
    assert.deepEqual(globalCommand.args.slice(-4, -2), ["--append-system-prompt", globalSource]);
    assert.ok(globalCommand.shellCommand.includes(`${processModule.shellQuote("--append-system-prompt")} ${processModule.shellQuote(globalSource)}`));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectSource, "project append guidance");
    assert.equal(processModule.resolveAppendSystemPromptSource(cwd, agentDir), undefined);
    assert.equal(processModule.buildAgentCommand(request).args.includes("--append-system-prompt"), false);
    const neitherCwd = mkdtempSync(join(tmpdir(), "pi subagent cwd 'neither-"));
    const neitherAgentDir = mkdtempSync(join(tmpdir(), "pi subagent agent 'neither-"));
    process.env.PI_CODING_AGENT_DIR = neitherAgentDir;
    assert.equal(processModule.resolveAppendSystemPromptSource(neitherCwd, neitherAgentDir), undefined);
    assert.equal(processModule.buildAgentCommand({ ...request, cwd: neitherCwd }).args.includes("--append-system-prompt"), false);
    process.env.PI_CODING_AGENT_DIR = agentDir;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
test("child resources discover APPEND_SYSTEM.md without an explicit append source", async () => {
  const cwd = dir;
  const agentDir = dir;
  writeFileSync(join(cwd, "APPEND_SYSTEM.md"), "local append guidance");
  const resources = await child.createChildResources({ cwd, projectTrusted: true, agentDir });
  assert.ok(resources.loader.getAppendSystemPrompt().some((prompt) => prompt.includes("local append guidance")));
});

test("agent process command construction carries child prompts without overriding Pi resources", async () => {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "APPEND_SYSTEM.md"), "project append guidance");
  assert.equal(processModule.shellQuote("a'b"), "'a'\\''b'");
  const request = {
    id: "p",
    name: "Name",
    prompt: "go",
    cwd: dir,
    sessionFile: join(dir, "p.jsonl"),
    tools: [],
    systemPrompt: "  profile 'quote' \nline ",
    piCommand: "fake",
    model: "m",
    thinking: "low"
  };
  const command = processModule.buildAgentCommand(request);
  assert.equal(command.executable, "fake");
  assert.ok(command.args.includes("--no-tools"));
  assert.equal(command.args.includes("--append-system-prompt"), false);
  assert.doesNotMatch(command.shellCommand, /--append-system-prompt/);
  const script = processModule.buildAgentLaunchScript(request);
  const expectedSystemPrompt = "Work autonomously on the assigned task. When complete, return a concise final assistant message that summarizes the result, evidence, and any remaining issue.\n\nprofile 'quote' \nline";
  assert.match(script, /PI_AGENT_AUTO_EXIT/);
  assert.ok(script.includes(`PI_AGENT_SYSTEM_PROMPT=${processModule.shellQuote(expectedSystemPrompt)}`));
  const handlers = new Map();
  childExtension.default({ on(event, handler) { handlers.set(event, handler); } });
  const previousPrompt = process.env.PI_AGENT_SYSTEM_PROMPT;
  process.env.PI_AGENT_SYSTEM_PROMPT = "child prompt";
  try {
    assert.deepEqual(handlers.get("before_agent_start")({ systemPrompt: "base" }), { systemPrompt: "base\n\nchild prompt" });
  } finally {
    if (previousPrompt === undefined) delete process.env.PI_AGENT_SYSTEM_PROMPT;
    else process.env.PI_AGENT_SYSTEM_PROMPT = previousPrompt;
  }
  assert.match(processModule.createAgentSessionFile({ id: "z", parentSessionFile: join(dir, "parent.jsonl") }), /parent.*\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl/);
  assert.match(processModule.createAgentSessionFile({ id: "z", agentDir: join(dir, "agent") }), /agent-sessions/);
  const sidecar = join(dir, "consume.exit");
  writeFileSync(sidecar, JSON.stringify({ type: "done" }));
  assert.equal(processModule.consumeAgentCompletionSidecar(sidecar).reason, "done");
  assert.ok(processModule.buildAgentCommand({ ...request, tools: ["read"], additionalExtensionPaths: ["/tmp/e"], childExtensionPath: "/tmp/c" }).args.includes("/tmp/e"));
});

function fakePi(name, mode = "done") { const file = join(dir, name); writeFileSync(file, `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from 'node:fs';\nconst s=process.env.PI_AGENT_SESSION; appendFileSync(s, JSON.stringify({type:'session',id:'sid'})+'\\n'); appendFileSync(s, JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:'out'}],stopReason:'${mode === "done" ? "stop" : "error"}'}})+'\\n'); writeFileSync(s+'.exit', JSON.stringify(${JSON.stringify(mode === "done" ? { type: "done" } : { type: "error", errorMessage: "bad" })}));\n`, { mode: 0o755 }); chmodSync(file, 0o755); return file; }

test("external agents run direct, herdr and fallback paths", async () => {
  const direct = await processModule.launchExternalAgent({ id: "direct", name: "d", prompt: "x", cwd: dir, sessionFile: join(dir, "direct.jsonl"), piCommand: fakePi("pi-d"), useHerdr: false }); assert.equal((await direct.completion).output, "out"); await direct.control("ignored"); await direct.abort(); const sent = []; const h = ops({ createPane: () => "hp", runScript: () => { writeFileSync(join(dir, "herdr.jsonl.exit"), JSON.stringify({ type: "done" })); }, sendText: (_p, t) => sent.push(t) }); const herdr = await processModule.launchExternalAgent({ id: "herdr", name: "h", prompt: "x", cwd: dir, sessionFile: join(dir, "herdr.jsonl"), useHerdr: true, herdrOps: h }); await herdr.control("hello"); assert.deepEqual(sent, ["hello"]); assert.equal((await herdr.completion).ok, true); const fallback = ops({ createPane: () => { throw new Error("split"); }, closePane: () => { throw new Error("close"); } }); const failed = await processModule.launchExternalAgent({ id: "fallback", name: "f", prompt: "x", cwd: dir, sessionFile: join(dir, "fallback.jsonl"), piCommand: fakePi("pi-f"), useHerdr: true, herdrOps: fallback }); assert.equal((await failed.completion).ok, true); const existingFail = ops({ renamePane: () => { throw new Error("rename"); }, createPane: () => { throw new Error("split"); } }); const ef = await processModule.launchExternalAgent({ id: "existing-fail", name: "e", prompt: "x", cwd: dir, sessionFile: join(dir, "ef.jsonl"), piCommand: fakePi("pi-ef"), useHerdr: true, herdrOps: existingFail, existingPaneId: "old" }); assert.equal((await ef.completion).ok, true);
});

test("default Herdr operations remain offline with a fake CLI", async () => {
  const herdr = join(dir, "herdr");
  writeFileSync(herdr, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1; exit 0; fi\ncase \"$2\" in create) echo \"{\\\"result\\\":{\\\"tab\\\":{\\\"tab_id\\\":\\\"tab\\\"},\\\"root_pane\\\":{\\\"pane_id\\\":\\\"root\\\"}}}\";; split) echo \"{\\\"result\\\":{\\\"pane\\\":{\\\"pane_id\\\":\\\"split\\\"}}}\";; read) echo \"{\\\"result\\\":{\\\"text\\\":\\\"screen\\\"}}\";; esac\n", { mode: 0o755 }); chmodSync(herdr, 0o755);
  const oldPath = process.env.PATH; const oldEnv = process.env.HERDR_ENV; const oldPane = process.env.HERDR_PANE_ID; process.env.PATH = `${dir}:${oldPath}`; process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "parent";
  try { const h = processModule.defaultAgentHerdrOps; assert.equal(h.available(), true); assert.deepEqual(h.createTab("n", dir), { tabId: "tab", rootPaneId: "root" }); assert.equal(h.createPane("n", dir, "root", "down"), "split"); h.runScript("split", "/tmp/x"); assert.equal(h.readPane("split"), "screen"); assert.equal(await h.inspectPane("split"), "present"); h.renamePane("split", "n"); h.sendText("split", "x"); h.closePane("split"); h.closeTab("tab"); } finally { process.env.PATH = oldPath; if (oldEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = oldEnv; if (oldPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = oldPane; }
});

test("in-process runner returns success, failure and abort outcomes", async () => {
  const messages = [{ role: "user", content: " question ", timestamp: 1 }, { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "think" }, { type: "text", text: " answer " }, { type: "toolCall", id: "c", name: "read", arguments: { x: 1 } }] }, { role: "toolResult", toolName: "read", toolCallId: "c", content: [{ type: "text", text: "result" }], isError: true, timestamp: 3 }]; let handlers; let disposed = 0; const make = async ({ mode = "ok" } = {}) => ({ session: { messages, model: { provider: "p", id: "m", contextWindow: 100 }, systemPrompt: "sys", thinkingLevel: "low", setSessionName: () => {}, prompt: async () => { if (mode === "throw") throw new Error("prompt"); }, abort: async () => {}, dispose: () => { disposed++; }, subscribe: (fn) => { handlers = fn; return () => {}; }, extensionRunner: { hasHandlers: () => false, emit: async () => {} } } }); const progress = []; const success = await runner.runAgent({ prompt: "x", cwd: dir, profile: { name: "worker", tools: [], thinking: "low" }, modelRegistry: { getAll: () => [] }, createSessionFn: make, onProgress: (p) => progress.push(p), onSessionReady: () => {}, sessionName: "s" }); assert.equal(success.ok, true); assert.equal(success.output, "answer"); assert.equal(success.transcript.length, 5); assert.ok(progress.length); handlers({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "event fail" }] }); const failure = await runner.runAgent({ prompt: "x", cwd: dir, profile: { name: "worker", tools: [], thinking: "low" }, modelRegistry: { getAll: () => [] }, createSessionFn: () => make({ mode: "throw" }) }); assert.equal(failure.ok, false); assert.match(failure.error, /prompt/); const controller = new AbortController(); controller.abort(); const aborted = await runner.runAgent({ prompt: "x", cwd: dir, profile: { name: "worker", tools: [] }, modelRegistry: { getAll: () => [] }, signal: controller.signal, createSessionFn: make }); assert.equal(aborted.aborted, true); const noProfile = await runner.runAgent({ prompt: "x", cwd: dir, profile: undefined, modelRegistry: { getAll: () => [] }, createSessionFn: make }); assert.equal(noProfile.ok, false); assert.match(noProfile.error ?? "", /does not exist or is not enabled/); const creation = await runner.runAgent({ prompt: "x", cwd: dir, profile: { name: "worker", tools: [] }, modelRegistry: { getAll: () => [] }, createSessionFn: async () => { throw "bad"; } }); assert.match(creation.error, /Failed to create/); assert.ok(disposed >= 1);
});

test("manager rejects profiles and handles panes and cancellation", async () => {
  const runtime = runtimeModule.makeAgentsRuntime(); try { await assert.rejects(runtimeModule.runTool(runtime, managerModule.AgentManager.use((m) => m.spawnBatch([{ profile: "" }]))), /profile/); const h = ops({ inspectPane: async () => "missing" }); const tasks = await runtimeModule.runTool(runtime, managerModule.AgentManager.use((m) => m.spawnBatch([{ profile: "worker", task: "x" }], { background: true, useHerdr: true, herdrOps: h }))); assert.equal(tasks.length, 1); assert.equal(await runtimeModule.runTool(runtime, managerModule.AgentManager.use((m) => m.pruneClosedPanes())), 1); assert.equal((await runtimeModule.runTool(runtime, managerModule.AgentManager.use((m) => m.cancelTask(tasks[0].id)))).status, "cancelled"); assert.equal((await runtimeModule.runTool(runtime, managerModule.AgentManager.use((m) => m.cancelTask(tasks[0].id)))).status, "cancelled"); } finally { await runtime.dispose(); }
});

