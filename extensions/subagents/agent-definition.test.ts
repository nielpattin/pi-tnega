import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentMarkdown, serializeAgentMarkdown } from "./src/agents/types.ts";

test("parseAgentMarkdown parses valid markdown with frontmatter and body", () => {
   const content = `---
description: Fast codebase exploration agent (read-only)
display_name: explore
tools: read, bash, grep, find
model: opencode-go/deepseek-v4-flash
thinking: high
prompt_mode: replace
guidance: Use this agent for read-only codebase exploration.
harness: pi
enabled: true
---

# CRITICAL: READ-ONLY MODE
You are a file search specialist.`;

   const result = parseAgentMarkdown("explore", content);
   assert.ok(result.definition);
   assert.equal(result.definition.name, "explore");
   assert.equal(result.definition.description, "Fast codebase exploration agent (read-only)");
   assert.equal(result.definition.display_name, "explore");
   assert.deepEqual(result.definition.tools, ["read", "bash", "grep", "find"]);
   assert.equal(result.definition.model, "opencode-go/deepseek-v4-flash");
   assert.equal(result.definition.thinking, "high");
   assert.equal(result.definition.guidance, "Use this agent for read-only codebase exploration.");
   assert.equal(result.definition.harness, "pi");
   assert.equal(result.definition.enabled, true);
   assert.equal(result.definition.body, "# CRITICAL: READ-ONLY MODE\nYou are a file search specialist.");
});

test("parseAgentMarkdown rejects empty/whitespace body", () => {
   const content = `---
description: Empty agent
---

   `;

   const result = parseAgentMarkdown("empty", content);
   assert.ok(result.error);
   assert.match(result.error, /has no system prompt body/);
});

test("parseAgentMarkdown ignores unknown keys like prompt_mode", () => {
   const content = `---
description: Test agent
prompt_mode: replace
unknown_field: foo
---

You are a worker agent.`;

   const result = parseAgentMarkdown("test", content);
   assert.ok(result.definition);
   assert.equal(result.definition.body, "You are a worker agent.");
   assert.equal((result.definition as any).prompt_mode, undefined);
   assert.equal((result.definition as any).unknown_field, undefined);
});

test("serializeAgentMarkdown roundtrip", () => {
   const def = {
      name: "scout",
      description: "Codebase scout",
      display_name: "scout",
      tools: ["read", "find"],
      model: "test/model",
      thinking: "low" as const,
      guidance: "Scout ahead",
      harness: "pi" as const,
      enabled: true,
      body: "# Scout\nFind files."
   };

   const serialized = serializeAgentMarkdown(def);
   const parsed = parseAgentMarkdown("scout", serialized);
   assert.ok(parsed.definition);
   assert.equal(parsed.definition.name, "scout");
   assert.equal(parsed.definition.description, "Codebase scout");
   assert.deepEqual(parsed.definition.tools, ["read", "find"]);
   assert.equal(parsed.definition.body, "# Scout\nFind files.");
});
