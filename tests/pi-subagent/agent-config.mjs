import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const agentProfiles = await loadExtension("extensions/pi-subagent/src/services/agent-profiles.ts");
const modelResolution = await loadExtension("extensions/pi-subagent/src/services/model-resolution.ts");
const domain = await loadExtension("extensions/pi-subagent/src/domain.ts");
const agentPrompt = await loadExtension("extensions/pi-subagent/src/agent-prompt.ts");
const formatters = await loadExtension("extensions/pi-subagent/src/ui/formatters.ts");
const widget = await loadExtension("extensions/pi-subagent/src/ui/async-agent-widget.ts");
const renderers = await loadExtension("extensions/pi-subagent/src/ui/tool-renderers.ts");
test("built-in profiles expose complete metadata", () => {
   const profiles = agentProfiles.listBuiltInAgentProfiles();
   assert.ok(profiles.length > 0);
   for (const profile of profiles) {
      assert.equal(profile.enabled, true, `${profile.name} is on by default`);
      assert.ok(profile.tools.length > 0, `${profile.name} allows tools`);
      assert.ok(profile.systemPrompt.length > 0, `${profile.name} carries instructions`);
      assert.ok(profile.description.length > 0, `${profile.name} carries a description`);
   }
});

test("profile resolution requires an explicit name and honors thinking levels", () => {
   assert.equal(agentProfiles.resolveAgentProfile(undefined), undefined);
   assert.equal(agentProfiles.resolveAgentProfile(""), undefined);
   assert.equal(agentProfiles.resolveAgentProfile("explorer")?.name, "explorer");
   assert.equal(agentProfiles.resolveAgentProfile("no-such-profile"), undefined);
   assert.match(agentProfiles.formatUnknownAgentProfileError("nope"), /"nope"/);
   assert.match(agentProfiles.formatUnknownAgentProfileError("nope"), /Available profiles:/);
   assert.match(agentProfiles.formatUnknownAgentProfileError(""), /<missing>/);
   assert.equal(agentProfiles.normalizeAgentThinkingLevel("high"), "high");
   assert.equal(agentProfiles.normalizeAgentThinkingLevel("nonsense"), "medium");
   assert.equal(domain.mapThinkingLevel("low"), "low");
});

test("model resolution prefers the profile hint and falls back to the parent model", () => {
   const known = new Set(["a/m2", "b/m1", "a/m1"]);
   const registry = {
      find: (provider, id) => (known.has(`${provider}/${id}`) ? { provider, id } : undefined),
      getAll: () => [
         { provider: "a", id: "m1" },
         { provider: "b", id: "m1" },
         { provider: "a", id: "m2" }
      ]
   };
   assert.deepEqual(
      modelResolution.resolveProfileModel(registry, {}, { provider: "a", id: "m2" }),
      { provider: "a", id: "m2" }
   );
   assert.deepEqual(modelResolution.resolveProfileModel(registry, { model: "b/m1" }), {
      provider: "b",
      id: "m1"
   });
   assert.throws(() => modelResolution.resolveProfileModel(registry, { model: "zzz/missing" }), /Unknown profile model/);
   assert.throws(() => modelResolution.resolveProfileModel(registry, { model: "m1" }), /multiple providers/);
   assert.equal(modelResolution.resolveProfileModel(registry, {}, undefined), undefined);
});

test("agent prompt contract uses a normal assistant completion", () => {
   assert.equal(agentPrompt.buildAgentPrompt("do the thing"), "do the thing");
   assert.match(agentPrompt.AGENT_SYSTEM_INSTRUCTION, /final assistant message/i);
});

test("context prepending preserves empty context and prefixes tasks", () => {
   assert.deepEqual(domain.prependContext([{ task: "t", name: "n", profile: "w" }], undefined), [
      { task: "t", name: "n", profile: "w" }
   ]);
   const [withContext] = domain.prependContext([{ task: "t", name: "n", profile: "w" }], "ctx");
   assert.equal(withContext.task, "ctx\n\nt");
});

test("run table formatting covers empty and settled rows", () => {
   assert.equal(formatters.formatRunTable([]), "No active runs.");
   assert.equal(formatters.formatDuration(500), "500ms");
   assert.equal(formatters.formatDuration(1500), "1.5s");
   const table = formatters.formatRunTable([
      {
         id: "task-1",
         name: "explore",
         profile: "explorer",
         status: "completed",
         createdAt: 1000,
         startedAt: 1000,
         settledAt: 2500,
         ownerSessionId: "parent",
         promptOrCommand: "explore"
      }
   ]);
   assert.match(table, /task-1/);
   assert.match(table, /completed/);
   assert.match(table, /explorer/);
});

test("async widget keeps settled agents with closed panes until the parent has the result", () => {
   const summary = widget.summarizeAsyncAgentStatus([
      { id: "task-1", name: "a", status: "running", batchId: "b1", batchSize: 2, paneId: "p1", runtimeOwned: true },
      { id: "task-2", name: "b", status: "completed", batchId: "b1", batchSize: 2, paneId: "p2", runtimeOwned: true },
      { id: "task-3", name: "old", status: "completed", runtimeOwned: true },
      { id: "task-4", name: "gone", status: "completed", paneClosed: true, resultDelivered: true, runtimeOwned: true },
      { id: "task-5", name: "quit", status: "cancelled", paneId: "p5", runtimeOwned: true },
      { id: "task-6", name: "restored", status: "completed", paneId: "p6" },
      { id: "task-7", name: "unread", status: "completed", paneClosed: true, runtimeOwned: true }
   ]);
   assert.equal(summary.running, 1);
   assert.equal(summary.settled, 3);
   assert.equal(summary.completed, 3);
   assert.deepEqual(summary.activeNames, ["a"]);
   assert.match(summary.settledSignature, /task-2:completed:p2/);
   assert.match(summary.settledSignature, /task-7:completed::x/);
   assert.doesNotMatch(summary.settledSignature, /task-4/);
   assert.doesNotMatch(summary.settledSignature, /task-6/);
   const idle = widget.summarizeAsyncAgentStatus([]);
   assert.equal(idle.running, 0);
   assert.equal(idle.settled, 0);
});

test("async widget keeps finished agents with panes and hides removed ones", () => {
   const theme = {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text
   };
   const tasks = [
      { id: "task-1", name: "live", profile: "explorer", status: "running", paneId: "w9:p1", createdAt: Date.now() - 65_000, runtimeOwned: true },
      {
         id: "task-2",
         name: "settled",
         profile: "explorer",
         status: "completed",
         paneId: "w9:p2",
         resultData: "a\nb",
         usage: { cost: 0.5, toolCalls: 2, contextTokens: 9000 },
         runtimeOwned: true
      },
      { id: "task-3", name: "quit", profile: "explorer", status: "cancelled", paneId: "w9:p3", runtimeOwned: true },
      { id: "task-4", name: "delivered", profile: "explorer", status: "completed", paneClosed: true, resultDelivered: true, runtimeOwned: true },
      { id: "task-5", name: "restored", profile: "explorer", status: "completed", paneId: "w9:p5", runtimeOwned: false },
      { id: "task-6", name: "unread", profile: "explorer", status: "completed", paneClosed: true, runtimeOwned: true }
   ];
   const component = widget.createAsyncAgentWidget(tasks)({}, theme);
   const text = component.render(160).join("\n");
   assert.match(text, /1 working/);
   assert.match(text, /2 done/);
   assert.match(text, /live.*explorer.*pane w9:p1/);
   assert.match(text, /settled.*explorer.*\$0\.5.*2 calls.*9k ctx.*pane w9:p2/);
   assert.doesNotMatch(text, /quit/);
   assert.doesNotMatch(text, /delivered/);
   assert.match(text, /unread.*pane closed/);
   assert.doesNotMatch(text, /restored/);
   component.dispose();
});

test("markdown extraction prefers output-like fields", () => {
   assert.equal(renderers.extractMarkdownText("plain"), "plain");
   assert.equal(renderers.extractMarkdownText({ output: "o" }), "o");
   assert.equal(renderers.extractMarkdownText({ summary: "s" }), "s");
   assert.equal(renderers.extractMarkdownText(undefined), "");
});
