import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { COMMAND_CODE_API, loadConfig } from "../src/config.ts";

function tempExtensionRoot(): string {
   return mkdtempSync(join(tmpdir(), "pi-command-code-provider-"));
}

test("loads reasoning metadata and model option fields from config.json", () => {
   const root = tempExtensionRoot();
   writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
         models: [
            {
               id: "reasoning-model",
               name: "Reasoning Model",
               baseUrl: "https://model-specific.example.com",
               reasoning: true,
               thinkingLevelMap: {
                  off: null,
                  minimal: "low",
                  high: "high",
                  xhigh: "xhigh",
               },
               input: ["text", "image"],
               output: ["text"],
               capabilities: { toolUse: true },
               isFree: true,
               importOwnership: "manual",
               contextWindow: 262144,
               maxTokens: 65536,
               cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
               compat: { supportsDeveloperRole: false },
            },
         ],
      }),
   );

   const model = loadConfig(root).config.models[0] as Record<string, unknown>;

   assert.equal(model.api, COMMAND_CODE_API);
   assert.equal(model.reasoning, true);
   assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: "low", high: "high", xhigh: "xhigh" });
   assert.deepEqual(model.input, ["text", "image"]);
   assert.deepEqual(model.output, ["text"]);
   assert.deepEqual(model.capabilities, { toolUse: true });
   assert.equal(model.isFree, true);
   assert.equal(model.importOwnership, "manual");
   assert.equal(model.baseUrl, "https://model-specific.example.com");
   assert.deepEqual(model.compat, { supportsDeveloperRole: false });
});

test("defaults CommandCode request timeout to five minutes", () => {
   const { config } = loadConfig(tempExtensionRoot());

   assert.equal(config.requestTimeoutMs, 300000);
});

test("uses models.dev limits for bundled model context and output ceilings", () => {
   const { config } = loadConfig(tempExtensionRoot());
   const byId = new Map(config.models.map((model) => [model.id, model]));

   assert.equal(byId.get("moonshotai/Kimi-K2.5")?.contextWindow, 262144);
   assert.equal(byId.get("moonshotai/Kimi-K2.5")?.maxTokens, 262144);
   assert.equal(byId.get("deepseek/deepseek-v4-pro")?.contextWindow, 1048576);
   assert.equal(byId.get("deepseek/deepseek-v4-pro")?.maxTokens, 393216);
   assert.equal(byId.get("Qwen/Qwen3.6-Plus")?.contextWindow, 1000000);
   assert.equal(byId.get("Qwen/Qwen3.6-Plus")?.maxTokens, 65536);
   assert.equal(byId.get("gpt-5.5")?.contextWindow, 922000);
   assert.equal(byId.get("gpt-5.5")?.maxTokens, 128000);
   assert.equal(byId.get("gpt-5.3-codex")?.contextWindow, 272000);
   assert.equal(byId.get("gpt-5.3-codex")?.maxTokens, 128000);
   assert.equal(byId.get("claude-opus-4-7")?.contextWindow, 1000000);
   assert.equal(byId.get("claude-opus-4-7")?.maxTokens, 128000);
   assert.equal(byId.get("zai-org/GLM-5")?.contextWindow, 204800);
   assert.equal(byId.get("zai-org/GLM-5")?.maxTokens, 131072);
});

test("uses model-specific thinking level maps without disabling reasoning-capable CommandCode models", () => {
   const { config } = loadConfig(tempExtensionRoot());
   const byId = new Map(config.models.map((model) => [model.id, model]));

   assert.equal(byId.get("deepseek/deepseek-v4-pro")?.reasoning, true);
   assert.equal(byId.get("moonshotai/Kimi-K2.6")?.reasoning, false);
   assert.equal(byId.get("zai-org/GLM-5")?.reasoning, false);
   assert.deepEqual(byId.get("deepseek/deepseek-v4-pro")?.thinkingLevelMap, {
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
   });
   assert.deepEqual(byId.get("Qwen/Qwen3.6-Plus")?.thinkingLevelMap, {
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
   });
   assert.deepEqual(byId.get("gpt-5.5")?.thinkingLevelMap, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
   });
   assert.deepEqual(byId.get("claude-sonnet-4-6")?.thinkingLevelMap, {
      off: "disabled",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
   });
   assert.deepEqual(byId.get("claude-opus-4-7")?.thinkingLevelMap, {
      off: "disabled",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
   });
   assert.deepEqual(byId.get("claude-opus-4-6")?.thinkingLevelMap, {
      off: "disabled",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
   });
});

test("uses CommandCode pricing docs for bundled model costs", () => {
   const { config } = loadConfig(tempExtensionRoot());
   const byId = new Map(config.models.map((model) => [model.id, model]));

   assert.deepEqual(byId.get("moonshotai/Kimi-K2.5")?.cost, { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 });
   assert.deepEqual(byId.get("moonshotai/Kimi-K2.6")?.cost, { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 });
   assert.deepEqual(byId.get("deepseek/deepseek-v4-pro")?.cost, {
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
   });
   assert.deepEqual(byId.get("claude-opus-4-7")?.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
   assert.deepEqual(byId.get("gpt-5.3-codex")?.cost, { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 });
});

test("can source command-code model metadata from an agent models.json provider entry", () => {
   const root = tempExtensionRoot();
   const modelsJsonPath = join(root, "models.json");
   writeFileSync(
      modelsJsonPath,
      JSON.stringify({
         providers: {
            "command-code": {
               baseUrl: "https://api.commandcode.ai",
               api: "command-code-alpha",
               apiKey: "COMMAND_CODE_TOKEN",
               models: [
                  {
                     id: "models-json-model",
                     name: "Models JSON Model",
                     reasoning: true,
                     thinkingLevelMap: { off: null, medium: "medium", high: "high" },
                     input: ["text", "image"],
                     contextWindow: 1048576,
                     maxTokens: 131072,
                     cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.4 },
                     compat: { supportsReasoningEffort: true },
                  },
               ],
            },
         },
      }),
   );
   writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
         providerId: "command-code",
         modelsJsonPath,
         models: [{ id: "fallback-model", name: "Fallback Model", reasoning: false }],
      }),
   );

   const { config } = loadConfig(root);

   assert.equal(config.models.length, 1);
   assert.equal(config.models[0].id, "models-json-model");
   assert.equal(config.models[0].api, COMMAND_CODE_API);
   assert.equal(config.models[0].reasoning, true);
   assert.deepEqual(config.models[0].thinkingLevelMap, { off: null, medium: "medium", high: "high" });
   assert.deepEqual(config.models[0].input, ["text", "image"]);
   assert.equal(config.models[0].contextWindow, 1048576);
   assert.deepEqual(config.models[0].compat, { supportsReasoningEffort: true });
});
