import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const { runAgent } = await loadExtension(
   "extensions/pi-subagent/src/shared/agent-runner.ts"
);

test("runAgent propagates parent modelRuntime to createSession", async () => {
   const fakeRuntime = { id: "custom-parent-model-runtime" };
   const fakeModel = { provider: "antigravity", id: "gemini-3.8-flash" };
   let capturedSessionOptions;

   const fakeModelRegistry = {
      runtime: fakeRuntime,
      find(provider, id) {
         if (provider === fakeModel.provider && id === fakeModel.id) return fakeModel;
         return undefined;
      },
      getAll() {
         return [fakeModel];
      }
   };

   const profile = {
      name: "critic",
      model: "antigravity/gemini-3.8-flash",
      tools: ["read", "bash"],
      thinking: "medium",
      systemPrompt: "test",
      enabled: true,
      source: "global"
   };

   await runAgent({
      prompt: "audit code",
      profile,
      cwd: process.cwd(),
      modelRegistry: fakeModelRegistry,
      createSessionFn: async (opts) => {
         capturedSessionOptions = opts;
         // Return dummy session that can abort cleanly
         return {
            session: {
               messages: [],
               getContextUsage: () => undefined,
               prompt: async () => {},
               abort: async () => {},
               dispose: () => {},
               extensionRunner: { hasHandlers: () => false, emit: async () => {} }
            }
         };
      }
   });

   assert.ok(capturedSessionOptions, "createSessionFn should have been called");
   assert.equal(
      capturedSessionOptions.modelRuntime,
      fakeRuntime,
      "expected modelRuntime to be forwarded to createSession"
   );
});
