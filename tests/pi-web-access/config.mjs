import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const configModule = await loadExtension("extensions/pi-web-access/src/config.ts");

test("getWebAccessConfigDir resolves to .ext-config under agent directory", () => {
   const dir = configModule.getWebAccessConfigDir();
   assert.ok(dir.endsWith(".ext-config"));
});

test("getWebAccessConfigPath resolves strictly to pi-web-access.json under .ext-config", () => {
   const path = configModule.getWebAccessConfigPath();
   assert.ok(path.endsWith(".ext-config\\pi-web-access.json") || path.endsWith(".ext-config/pi-web-access.json"));
});

test("getAuthFilePath resolves to auth.json in agent directory", () => {
   const path = configModule.getAuthFilePath();
   assert.ok(path.endsWith("auth.json"));
});

test("getWebAccessConfig provides default config values and reads from .ext-config", () => {
   const config = configModule.getWebAccessConfig();
   assert.equal(typeof config.maxBytes, "number");
   assert.ok(config.maxBytes > 0);
   assert.equal(typeof config.timeoutMs, "number");
   assert.ok(config.timeoutMs > 0);
   assert.ok(config.userAgent.includes("PiWebAccess"));

   // Test namespaced objects
   assert.ok(config.search && typeof config.search === "object");
   assert.ok(config.research && typeof config.research === "object");
   assert.ok(config.fetch && typeof config.fetch === "object");
   assert.ok(config.keys && typeof config.keys === "object");
   assert.equal(config.research.provider, "llm");
   assert.equal(config.fetch.maxBytes, config.maxBytes);
   assert.equal(config.fetch.timeoutMs, config.timeoutMs);
   assert.ok(config.research.searchProvider === undefined || typeof config.research.searchProvider === "string");
   assert.ok(config.research.fetchProvider === undefined || typeof config.research.fetchProvider === "string");
});
