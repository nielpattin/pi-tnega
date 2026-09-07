import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import {
   existsSync,
   mkdirSync,
   mkdtempSync,
   rmSync,
   writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension } from "../_bootstrap.mjs";

const pi = await import("@earendil-works/pi-coding-agent");
pi.initTheme("dark");

const agentTools = await loadExtension("extensions/pi-subagent/src/tools/agent.ts");
const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
const widget = await loadExtension("extensions/pi-subagent/src/ui/async-agent-widget.ts");
const formatters = await loadExtension("extensions/pi-subagent/src/ui/formatters.ts");
const models = await loadExtension("extensions/pi-subagent/src/services/model-resolution.ts");
const domain = await loadExtension("extensions/pi-subagent/src/domain.ts");
const profiles = await loadExtension("extensions/pi-subagent/src/services/agent-profiles.ts");
const prompt = await loadExtension("extensions/pi-subagent/src/agent-prompt.ts");
const registryModule = await loadExtension("extensions/pi-subagent/src/services/task-registry.ts");
const managerModule = await loadExtension("extensions/pi-subagent/src/services/agent-manager.ts");

const theme = {
   fg: (_color, text) => text,
   bold: (text) => text,
   strikethrough: (text) => text
};

function render(component, width = 100) {
   return component.render(width).join("\n");
}

function task(overrides = {}) {
   return {
      id: "task-1",
      ownerSessionId: "parent",
      name: "agent-one",
      profile: "worker",
      promptOrCommand: "do it",
      status: "completed",
      createdAt: 1000,
      ...overrides
   };
}

function fakeRegistry(tasks = []) {
   return {
      register: (init) => Effect.succeed({ ...init, status: "pending", createdAt: 1 }),
      restore: (value) => Effect.succeed(value),
      get: (id) => Effect.succeed(tasks.find((value) => value.id === id)),
      list: () => Effect.succeed(tasks.map((value) => ({ ...value }))),
      updateStatus: (id, status, patch) => Effect.succeed({ id, status, ...patch }),
      onSettled: () => Effect.succeed(() => {}),
      onChange: () => Effect.succeed(() => {}),
      replaceAll: () => Effect.succeed(undefined),
      clear: () => Effect.succeed(undefined)
   };
}

function fakeManager(overrides = {}) {
   return {
      spawnBatch: () => Effect.succeed([]),
      cancelTask: () => Effect.succeed(undefined),
      pruneClosedPanes: () => Effect.succeed(0),
      cancelActiveSessions: Effect.void,
      ...overrides
   };
}

function runAgentEffect(effect, registry, manager) {
   return Effect.runPromise(
      Effect.provideService(
         Effect.provideService(effect, registryModule.TaskRegistry, registry),
         managerModule.AgentManager,
         manager
      )
   );
}

function result(details, text = "result") {
   return { content: [{ type: "text", text }], details };
}

test("agent schemas, metadata, and pure execution helpers cover all variants", async () => {
   assert.equal(agentTools.resolveAgentBackground(), false);
   assert.equal(agentTools.resolveAgentBackground(false), false);
   assert.equal(agentTools.resolveAgentBackground(true), true);
   assert.equal(agentTools.createAgentSpawnToolParamsSchema([]).properties.agents.items.properties.profile.not !== undefined, true);
   assert.equal(agentTools.createAgentSpawnToolParamsSchema(["solo"]).properties.agents.items.properties.profile.const, "solo");
   assert.equal(agentTools.createAgentSpawnToolParamsSchema(["a", "b"]).properties.agents.items.properties.profile.anyOf.length, 2);

   assert.deepEqual(agentTools.augmentAgentToolMetadata([]), { agentNames: [], descriptionAppendix: "" });
   assert.deepEqual(agentTools.augmentAgentToolMetadata([{ name: "off", description: "x", enabled: false }]), {
      agentNames: [],
      descriptionAppendix: ""
   });
   const metadata = agentTools.augmentAgentToolMetadata(
      [
         { name: "z", description: " zed ", enabled: true },
         { name: "a", description: "", enabled: true },
         { name: "hidden", description: "h", enabled: true }
      ],
      { allowedAgentNames: ["z", "a"] }
   );
   assert.deepEqual(metadata.agentNames, ["a", "z"]);
   assert.match(metadata.descriptionAppendix, /- a\n/);
   assert.match(metadata.descriptionAppendix, /- z: zed/);

   assert.deepEqual(await runAgentEffect(agentTools.handleAgentList({}), fakeRegistry([]), fakeManager()), {
      ok: true,
      tasks: []
   });
   const listedTask = task({
      name: null,
      model: "m",
      cwd: "/tmp",
      context: "c",
      startedAt: 2,
      settledAt: 3,
      errorText: "E".repeat(1200),
      sessionFile: "session",
      usage: { cost: 1, toolCalls: 2, contextTokens: 3 }
   });
   const listed = await runAgentEffect(agentTools.handleAgentList({}), fakeRegistry([listedTask]), fakeManager());
   assert.equal(listed.tasks[0].name, listedTask.id);
   assert.equal(listed.tasks[0].errorText.length, 1000);
   assert.equal(listed.tasks[0].sessionFile, "session");
   assert.deepEqual(listed.tasks[0].usage, listedTask.usage);

   const spawnedTask = task({ status: "running", name: "spawned" });
   const spawningManager = fakeManager({ spawnBatch: () => Effect.succeed([spawnedTask]) });
   const spawned = await runAgentEffect(
      agentTools.handleAgentSpawn({ agents: [{ task: "x", name: "n", profile: "worker" }] }),
      fakeRegistry([]),
      spawningManager
   );
   assert.equal(spawned.tasks[0].status, "spawned");
   assert.match(spawned.message, /1 agent finished/);
   assert.deepEqual(
      await runAgentEffect(agentTools.handleAgentSpawn({ agents: [] }), fakeRegistry([]), fakeManager()),
      { ok: false, error: 'agent_spawn requires a non-empty "agents" array.' }
   );

   const backgroundSpawned = await runAgentEffect(
      agentTools.handleAgentSpawn(
         { context: "shared", agents: [{ task: "x", name: "n", profile: "worker" }], background: true },
         { cwd: "/tmp" }
      ),
      fakeRegistry([]),
      fakeManager()
   );
   assert.match(backgroundSpawned.message, /background/);
   const missing = await runAgentEffect(agentTools.handleAgentCancel({ id: "missing" }), fakeRegistry([]), fakeManager());
   assert.deepEqual(missing, { ok: false, error: 'Agent task "missing" not found.' });
   const current = task({ status: "running" });
   const cancelled = await runAgentEffect(
      agentTools.handleAgentCancel({ id: current.id }),
      fakeRegistry([current]),
      fakeManager({ cancelTask: () => Effect.succeed(current) })
   );
   assert.equal(cancelled.action, "cancelled");
   const cancelledWithoutTask = await runAgentEffect(
      agentTools.handleAgentCancel({ id: current.id }),
      fakeRegistry([current]),
      fakeManager()
   );
   assert.equal(cancelledWithoutTask.task, undefined);
});

test("domain helpers and all tagged errors are evaluated", () => {
   const taskIdPattern = /^task-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
   const taskIds = [domain.formatTaskId(), domain.formatTaskId(), domain.formatTaskId()];
   assert.ok(taskIds.every((id) => taskIdPattern.test(id)));
   assert.equal(new Set(taskIds).size, taskIds.length);
   assert.deepEqual(domain.normalizeAgentSpecs({ agents: [{ task: undefined, name: "n", profile: "explorer" }] }), [
      { task: "", name: "n", profile: "explorer" }
   ]);
   assert.deepEqual(domain.prependContext([{ task: "t", profile: "w" }], undefined), [{ task: "t", profile: "w" }]);
   assert.deepEqual(domain.prependContext([{ task: "t", profile: "w" }], "  "), [{ task: "t", profile: "w" }]);
   assert.deepEqual(domain.prependContext([{ task: "t", profile: "w" }], "ctx"), [{ task: "ctx\n\nt", profile: "w" }]);
   const errors = [
      new domain.CapacityError({ message: "capacity", limit: 1 }),
      new domain.ConcurrencyLimitError({ message: "concurrency", limit: 1 }),
      new domain.AgentProfileNotFoundError({ message: "profile", profile: "x" }),
      new domain.DuplicateTaskError({ message: "duplicate", id: "x" }),
      new domain.ManifestSerializationError({ message: "serialization", cause: new Error("x") }),
      new domain.ManifestPersistenceError({ message: "persistence", cause: new Error("x") }),
      new domain.ParentSessionActivationError({ message: "parent", parentSessionFile: "p", cause: "x" }),
      new domain.ControlError({ message: "control" })
   ];
   assert.deepEqual(errors.map((error) => error._tag), [
      "CapacityError",
      "ConcurrencyLimitError",
      "AgentProfileNotFoundError",
      "DuplicateTaskError",
      "ManifestSerializationError",
      "ManifestPersistenceError",
      "ParentSessionActivationError",
      "ControlError"
   ]);
});

test("model resolution covers inherited, explicit, unique, ambiguous, and missing models", () => {
   const entries = [
      { provider: "a", id: "one" },
      { provider: "b", id: "one" },
      { provider: "a", id: "two" }
   ];
   const registry = {
      find: (provider, id) => entries.find((entry) => entry.provider === provider && entry.id === id),
      getAll: () => entries
   };
   assert.equal(models.resolveProfileModel(registry, {}, undefined), undefined);
   assert.deepEqual(models.resolveProfileModel(registry, {}, { provider: "a", id: "two" }), { provider: "a", id: "two" });
   assert.deepEqual(models.resolveProfileModel(registry, { model: "a/two" }), { provider: "a", id: "two" });
   assert.throws(() => models.resolveProfileModel(registry, { model: "a/missing" }), /Unknown profile model/);
   assert.deepEqual(models.resolveProfileModel(registry, { model: "two" }), { provider: "a", id: "two" });
   assert.deepEqual(
      models.resolveProfileModel(
         { find: (provider, id) => ({ provider, id }), getAll: () => [] },
         { model: "new" },
         { provider: "z", id: "parent" }
      ),
      { provider: "z", id: "new" }
   );
   assert.deepEqual(models.resolveProfileModel(registry, { model: "two" }, { provider: "b", id: "different" }), { provider: "a", id: "two" });
   assert.throws(() => models.resolveProfileModel(registry, { model: "one" }), /multiple providers/);
   assert.throws(() => models.resolveProfileModel(registry, { model: "missing" }), /Unknown profile model/);
   assert.throws(() => models.resolveProfileModel(registry, { model: "/leading" }), /Unknown profile model/);
});

test("formatters cover all duration and run timing branches", () => {
   assert.deepEqual(
      [-5, 0, 999, 1000, 1500, 59000, 60000, 61000, 120000, 3599999, 3600000, 3660000, 7200000].map(formatters.formatDuration),
      ["0ms", "0ms", "999ms", "1s", "1.5s", "59s", "1m", "1m 1s", "2m", "59m 59s", "1h", "1h 1m", "2h"]
   );
   const base = task({ name: "n", profile: "w", createdAt: 1000, status: "running" });
   assert.match(formatters.formatRunRow({ ...base, name: null, profile: undefined }, 3000), /-.*unknown.*2s/);
   assert.match(formatters.formatRunRow({ ...base, startedAt: 2000 }, 5000), /3s/);
   assert.match(formatters.formatRunRow({ ...base, startedAt: 1000, settledAt: 2500 }, 9000), /1.5s/);
   assert.equal(formatters.formatRunTable([]), "No active runs.");
   assert.match(formatters.formatRunTable([base, { ...base, id: "task-2" }], 2000), /task-2/);
});

test("agent prompt and profile parser/storage are fully offline", () => {
   assert.equal(prompt.buildAgentPrompt("prompt"), "prompt");
   assert.match(prompt.AGENT_SYSTEM_INSTRUCTION, /final assistant message/);
   assert.deepEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(profiles.normalizeAgentThinkingLevel), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
   assert.equal(profiles.normalizeAgentThinkingLevel("invalid"), "medium");
   assert.equal(profiles.isAgentThinkingLevel(4), false);
   assert.equal(profiles.isAgentThinkingLevel("high"), true);

   const plain = profiles.parseAgentProfileMarkdown("plain", "body", "/tmp/plain.md", "global");
   assert.equal(plain.description, "Custom plain profile.");
   assert.deepEqual(plain.tools, ["read", "write", "edit", "bash", "powershell"]);
   assert.equal(profiles.parseAgentProfileMarkdown("empty", "---\ndescription: x\n---\n  ", "/tmp/empty.md"), undefined);
   const noEnd = profiles.parseAgentProfileMarkdown("noend", "---\nname: noend", undefined, "global");
   assert.match(noEnd.systemPrompt, /name: noend/);
   const parsed = profiles.parseAgentProfileMarkdown(
      "custom",
      "---\ndescription: \"Description\"\ndisplay_name: Display\ntools: read, bash\nguidance: Guide\nmodel: a/m\nthinking: high\nenabled: false\nignored-line\n---\n# Body",
      "/repo/.pi/agents/custom.md"
   );
   assert.equal(parsed.source, "project");
   assert.equal(parsed.enabled, false);
   assert.deepEqual(parsed.tools, ["read", "bash"]);
   assert.equal(profiles.parseAgentProfileMarkdown("bad", "---\nthinking: nope\n---\nbody").thinking, undefined);
   assert.equal(profiles.getGlobalAgentProfilesDir("/agent"), "/agent/agents");
   assert.deepEqual(profiles.getProjectAgentProfilesDirs(), []);
   assert.deepEqual(profiles.getProjectAgentProfilesDirs("/project"), ["/project/agents", "/project/.pi/agents"]);

   const agentDir = mkdtempSync(join(tmpdir(), "coverage-agent-"));
   const cwd = mkdtempSync(join(tmpdir(), "coverage-cwd-"));
   mkdirSync(join(agentDir, "agents"), { recursive: true });
   mkdirSync(join(cwd, "agents"), { recursive: true });
   mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
   writeFileSync(join(cwd, "agents", "legacy.md"), "---\ndescription: Legacy\n---\nlegacy");
   writeFileSync(join(cwd, "agents", "empty.md"), "---\n---\n ");
   writeFileSync(join(cwd, "agents", "disabled.md"), "---\nenabled: false\n---\ndisabled");
   writeFileSync(join(cwd, ".pi", "agents", "custom.md"), "---\ndescription: Project\n---\nproject");
   writeFileSync(join(agentDir, "agents", "worker.md"), "---\ndescription: Global override\n---\nglobal");
   let loaded = profiles.listAgentProfiles(cwd, { agentDir });
   assert.equal(loaded.find((profile) => profile.name === "worker").description, "Global override");
   assert.equal(loaded.find((profile) => profile.name === "legacy").source, "project");
   assert.equal(profiles.resolveAgentProfile("disabled", cwd, { agentDir }), undefined);
   assert.equal(profiles.resolveAgentProfile("  worker  ", cwd, { agentDir }).name, "worker");
   assert.equal(profiles.resolveAgentProfile(undefined, cwd, { agentDir }), undefined);
   assert.equal(profiles.resolveAgentProfile("absent", cwd, { agentDir }), undefined);

   const fullProfile = {
      name: "saved",
      description: "d",
      display_name: "D",
      tools: ["read"],
      model: "m",
      thinking: "low",
      guidance: "g",
      systemPrompt: "Body",
      enabled: false
   };
   const serialized = profiles.serializeAgentProfile(fullProfile);
   assert.match(serialized, /display_name: D/);
   assert.match(serialized, /enabled: false/);
   const saved = profiles.saveAgentProfile(fullProfile, { agentDir, cwd });
   assert.equal(existsSync(saved), true);
   assert.equal(existsSync(join(cwd, "agents", "saved.md")), false);
   assert.equal(profiles.deleteAgentProfile("saved", { agentDir, cwd }).success, true);
   assert.equal(profiles.deleteAgentProfile("not-found", { agentDir, cwd }).success, false);
   const knownPath = join(cwd, ".pi", "agents", "custom.md");
   assert.equal(profiles.deleteAgentProfile({ name: "custom", filePath: knownPath }, { agentDir, cwd }).success, true);
   mkdirSync(join(agentDir, "agents", "directory.md"));
   assert.equal(profiles.deleteAgentProfile("directory", { agentDir, cwd }).success, false);
   rmSync(agentDir, { recursive: true, force: true });
   rmSync(cwd, { recursive: true, force: true });
});

test("async agent widget covers visibility, activity, idle, overflow, and truncation", async () => {
   assert.equal(widget.activityLabel(undefined), undefined);
   assert.equal(widget.activityLabel({ phase: "starting" }), "starting");
   assert.equal(widget.activityLabel({ phase: "waiting" }), "waiting");
   assert.equal(widget.activityLabel({ phase: "done" }), "done");
   assert.equal(widget.activityLabel({ phase: "active", toolName: "read" }), "read");
   assert.equal(widget.activityLabel({ phase: "active", activeScope: "tool" }), "tool");
   assert.equal(widget.activityLabel({ phase: "active", messageEventType: "text" }), "text");
   assert.equal(widget.activityLabel({ phase: "active" }), "working");
   assert.deepEqual(widget.visibleWidgetTasks([
      task({ runtimeOwned: false, status: "running" }),
      task({ runtimeOwned: true, status: "cancelled" }),
      task({ runtimeOwned: true, paneClosed: true, resultDelivered: true, status: "completed" }),
      task({ runtimeOwned: true, paneClosed: true, status: "completed" }),
      task({ runtimeOwned: true, paneClosed: true, status: "running" }),
      task({ runtimeOwned: true, status: "pending" })
   ]).map((value) => value.status), ["completed", "running", "pending"]);
   const summary = widget.summarizeAsyncAgentStatus([
      task({ id: "r", name: null, status: "running", runtimeOwned: true }),
      task({ id: "p", name: "pending", status: "pending", runtimeOwned: true, activity: { phase: "waiting" } }),
      task({ id: "c", status: "completed", runtimeOwned: true, paneId: "pane" }),
      task({ id: "f", status: "failed", runtimeOwned: true }),
   ]);
   assert.deepEqual(summary.activeNames, ["pending"]);
   assert.match(summary.activeDetails.join(","), /r,/);
   assert.equal(summary.running, 2);
   assert.equal(summary.settled, 2);
   assert.match(widget.buildAsyncAgentSnapshot({ ...summary, activeNames: ["a", "b", "c", "d"], activeDetails: ["1", "2", "3", "4"] }), /^2:2:1:1:a,b,c\|1,2,3/);

   const idle = widget.createAsyncAgentWidget([])(undefined, theme);
   assert.match(render(idle, 80), /idle/);
   idle.dispose();
   const now = Date.now();
   const active = Array.from({ length: 5 }, (_, index) => task({
      id: `active-${index}`,
      name: `active-${index}`,
      status: "running",
      runtimeOwned: true,
      profile: "worker",
      createdAt: now - 3_700_000,
      startedAt: now - 3_700_000,
      activity: { phase: "active", toolName: "read" }
   }));
   const settled = Array.from({ length: 6 }, (_, index) => task({
      id: `settled-${index}`,
      name: index === 0 ? null : `settled-${index}`,
      status: index % 2 ? "failed" : "completed",
      runtimeOwned: true,
      resultData: "line one\nline two",
      usage: { cost: 0.5, toolCalls: 1, contextTokens: 100 },
      paneId: `pane-${index}`
   }));
   const component = widget.createAsyncAgentWidget([...active, ...settled])({ requestRender() {} }, theme);
   assert.match(render(component, 30), /\+2 more/);
   await new Promise((resolve) => setTimeout(resolve, 190));
   component.dispose();
   component.dispose();
   const narrow = widget.createAsyncAgentWidget([task({ status: "pending", runtimeOwned: true, profile: undefined, activity: undefined })])(undefined, theme);
   assert.equal(narrow.render(0)[0], "");
   assert.ok(narrow.render(2)[0]);
   narrow.dispose();
});

test("renderer helpers cover calls, markdown, stats, records, results, and errors", async () => {
   assert.equal(renderers.extractMarkdownText("plain"), "plain");
   for (const [value, expected] of [
      [{ output: "o" }, "o"],
      [{ summary: "s" }, "s"],
      [{ result: "r" }, "r"],
      [{ text: "t" }, "t"],
      [{ markdown: "m" }, "m"],
      [undefined, ""],
      [null, ""],
      [{ n: 1 }, '{\n  "n": 1\n}'],
      [[1], "[\n  1\n]"],
      [42, "42"]
   ]) assert.equal(renderers.extractMarkdownText(value), expected);
   const md = renderers.createMarkdownTheme(theme);
   assert.equal(md.heading("h"), "h");
   assert.equal(md.link("l"), "l");
   assert.equal(md.linkUrl("u"), "u");
   assert.equal(md.code("c"), "c");
   assert.equal(md.codeBlock("cb"), "cb");
   assert.equal(md.codeBlockBorder("b"), "b");
   assert.equal(md.quote("q"), "q");
   assert.equal(md.quoteBorder("qb"), "qb");
   assert.equal(md.hr("hr"), "hr");
   assert.equal(md.listBullet("lb"), "lb");
   assert.equal(md.bold("b"), "b");
   assert.match(md.italic("i"), /i/);
   assert.match(md.strikethrough("s"), /s/);
   assert.match(md.underline("u"), /u/);
   const bareTheme = { fg: (_color, text) => text, bold: (text) => text };
   assert.match(renderers.createMarkdownTheme(bareTheme).italic("i"), /23m/);
   assert.match(renderers.createMarkdownTheme(bareTheme).strikethrough("s"), /29m/);
   assert.match(renderers.createMarkdownTheme(bareTheme).underline("u"), /24m/);

   assert.match(render(renderers.renderAgentCall({}, theme, {})), /0 agents/);
   assert.match(render(renderers.renderAgentCall({ agents: [{ name: "one", profile: "worker", task: "a very long task" }] }, theme, { isError: true })), /one/);
   assert.match(render(renderers.renderAgentCall({ agents: [{ name: "one", profile: "worker", task: "task" }, { name: "two" }] }, theme, { state: { taskStatuses: ["running", "pending"] } })), /two/);
   assert.match(render(renderers.renderAgentCall({ agents: [{ name: "one", profile: "worker", task: "task" }] }, theme, { state: { taskStatuses: ["completed"] } })), /batch · 1 agent/);
   assert.match(render(renderers.renderAgentListCall({}, theme)), /agent_list/);
   assert.match(render(renderers.renderAgentCancelCall({}, theme)), /agent_cancel agent/);

   assert.equal(renderers.formatAgentStatLine({ status: "completed", name: "n", profile: "w", usage: { cost: 0.012, toolCalls: 1, contextTokens: 1500 }, lineCount: 1 }, theme), "✓ n · w · $0.012 · 1 call · 1.5k ctx (1 line)");
   assert.match(renderers.formatAgentStatLine({ status: "failed", name: "n", boldName: true, usage: { cost: NaN, toolCalls: Infinity, contextTokens: -1 } }, theme), /✗ n/);
   assert.match(renderers.formatAgentStatLine({ status: "unknown", name: "n", lineCount: 2 }, theme), /2 lines/);

   const partial = renderers.renderAgentResult(result({ tasks: [
      { name: "done", profile: "worker", status: "completed", result: "a\nb", usage: { cost: 1, toolCalls: 2, contextTokens: 2000 } },
      { id: "pending", profile: "worker", status: "spawned" }
   ] }), { expanded: false, isPartial: true }, theme, { state: {} });
   assert.equal(render(partial), "");
   assert.equal(render(renderers.renderAgentResult(result({}), { expanded: false, isPartial: true }, theme, { state: {} })), "");
   assert.equal(render(renderers.renderAgentResult({ content: [], details: { tasks: [] } }, { expanded: false, isPartial: true }, theme, { state: {} })), "");

   let invalidated = 0;
   const state = { taskStatuses: ["running"], spinnerTimer: setTimeout(() => {}, 10000) };
   const context = { state, invalidate: () => { invalidated += 1; } };
   render(renderers.renderAgentResult(result({ tasks: [{ id: "a", status: "completed", result: "out" }] }), { expanded: false, isPartial: false }, theme, context));
   render(renderers.renderAgentResult(result({ tasks: [{ id: "a", status: "completed", result: "out" }] }), { expanded: false, isPartial: false }, theme, context));
   assert.equal(state.spinnerRunning, false);
   await new Promise((resolve) => setTimeout(resolve, 0));
   assert.equal(invalidated, 1);

   const cases = [
      [result({ tasks: [{ id: "a", name: "a", status: "spawned" }] }), false],
      [result({ tasks: [{ id: "a", name: "a", status: "spawned" }] }), true],
      [result({ tasks: [{ id: "a", name: "a", status: "running" }, { id: "b", status: "pending" }] }), false],
      [result({ tasks: [{ id: "a", name: "a", status: "running" }, { id: "b", status: "pending" }] }), true],
      [result({ tasks: [{ id: "a", name: "a", status: "completed", result: "# output" }] }), false],
      [result({ tasks: [{ id: "a", name: "a", status: "completed", result: "# output" }] }), true],
      [result({ tasks: [{ id: "a", name: "a", status: "failed", errorText: "bad" }] }), false],
      [result({ tasks: [{ id: "a", name: "a", status: "failed", errorText: { code: 1 }, result: "fallback" }] }), true],
      [result({ tasks: [{ id: "a", status: "completed" }, { id: "b", status: "failed", errorText: "bad" }] }), false],
      [result({ tasks: [{ id: "a", status: "completed" }, { id: "b", status: "failed", errorText: "bad" }] }), true],
      [result({ id: "single", status: "completed", result: "single" }), false],
      [result({ id: "single", status: "running" }), true]
   ];
   for (const [value, expanded] of cases) render(renderers.renderAgentResult(value, { expanded, isPartial: false }, theme, { state: {} }));
   assert.match(render(renderers.renderAgentResult({ content: [{ type: "text", text: "failure" }], details: { error: "error" } }, { expanded: false, isPartial: false }, theme, {})), /error/);
   assert.match(render(renderers.renderAgentResult({ content: [{ type: "text", text: "failure" }], details: { error: "error" } }, { expanded: false, isPartial: false }, theme, { isError: true })), /error/);
   assert.match(render(renderers.renderAgentResult({ content: [{ type: "text", text: "fallback" }] }, { expanded: false, isPartial: false }, theme, {})), /fallback/);
   assert.match(render(renderers.renderAgentResult({ content: [] }, { expanded: false, isPartial: false }, theme, {})), /Done/);

   render(renderers.renderAgentResult(result({ jobs: [{ id: "job", status: "completed" }] }), { expanded: false, isPartial: false }, theme, { state: {} }));
   render(renderers.renderAgentResult(result({ jobs: [{ id: "job", status: "running" }] }), { expanded: false, isPartial: false }, theme, { state: {} }));
   const recordCases = [
      { jobs: [{ id: "j", status: "completed", resultData: "output" }] },
      { jobs: [{ id: "object", resultData: { value: 1 } }, { id: "empty" }] },
      { jobs: [{ name: "n", agent: "agent" }, { id: "j2", status: "failed", errorText: { code: 1 } }, { status: "completed", resultData: { summary: "summary" } }] },
      { lines: ["one", 2, "two", "three", "four", "five"] },
      { job: { id: "entity", status: "completed", resultData: "entity output" } },
      { arbitrary: "json" }
   ];
   for (const details of recordCases) {
      render(renderers.renderJobListResult(result(details), { expanded: false, isPartial: false }, theme, {}));
      render(renderers.renderJobListResult(result(details), { expanded: true, isPartial: false }, theme, {}));
   }
   assert.match(render(renderers.renderJobListResult({ content: [], details: "not-record" }, { expanded: false, isPartial: false }, theme, {})), /Done/);
   for (const fn of [renderers.renderAgentListResult, renderers.renderAgentCancelResult]) {
      assert.match(render(fn(result({ jobs: [{ id: "j", status: "completed" }] }), { expanded: false, isPartial: false }, theme, {})), /j/);
   }
});
