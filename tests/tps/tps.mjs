import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const extension = await loadExtension("extensions/tps");

function createHarness() {
   const handlers = new Map();
   const statuses = [];
   const notifications = [];

   const pi = {
      on(event, handler) {
         handlers.set(event, handler);
      }
   };

   extension.default(pi);

   const ctx = {
      hasUI: true,
      mode: "tui",
      hasPendingMessages: () => false,
      ui: {
         theme: { fg: (_color, text) => text },
         setStatus(key, text) {
            statuses.push({ key, text });
         },
         notify(text, level) {
            notifications.push({ text, level });
         }
      }
   };

   return { handlers, statuses, notifications, ctx };
}

function assistant(output, model = "test-model") {
   return {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test-provider",
      model,
      usage: {
         input: 10,
         output,
         cacheRead: 2,
         cacheWrite: 1,
         totalTokens: output + 13,
         cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 0
   };
}

function withClock(run) {
   const performanceObject = globalThis.performance;
   const originalNow = performanceObject.now;
   let now = 0;
   Object.defineProperty(performanceObject, "now", {
      configurable: true,
      value: () => now
   });

   try {
      run((value) => {
         now = value;
      });
   } finally {
      Object.defineProperty(performanceObject, "now", {
         configurable: true,
         value: originalNow
      });
   }
}

test("shows live default TPS status without registering a command", async () => {
   const harness = createHarness();

   assert.equal(harness.handlers.has("session_start"), true);
   assert.equal(harness.handlers.has("agent_start"), true);
   assert.equal(harness.handlers.has("message_update"), true);
   assert.equal(harness.handlers.has("agent_end"), true);

   await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
   assert.match(harness.statuses.at(-1).text, /TPS: --/);

   harness.handlers.get("agent_start")({ type: "agent_start" });
   const message = assistant(6);
   harness.handlers.get("message_start")({ message });
   harness.handlers.get("message_update")({
      message,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message }
   }, harness.ctx);
   for (let i = 0; i < 6; i++) {
      harness.handlers.get("message_update")({
         message,
         assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "token",
            partial: message
         }
      }, harness.ctx);
   }

   assert.ok(harness.statuses.some(({ text }) => /tok\/s/.test(text) && !/TPS: --/.test(text)));
});

test("reports the whole agent loop and interim stats while the loop continues", () => {
   withClock((setNow) => {
      const harness = createHarness();
      const { handlers, notifications, statuses, ctx } = harness;
      const first = assistant(4);
      const second = assistant(6);

      setNow(1000);
      handlers.get("agent_start")({ type: "agent_start" });

      setNow(1100);
      handlers.get("message_start")({ message: first });
      for (const type of ["text_start", "text_delta", "text_delta", "text_delta"]) {
         setNow({ text_start: 1200, text_delta: 1300 }[type] ?? 1400);
         handlers.get("message_update")({
            message: first,
            assistantMessageEvent: { type, contentIndex: 0, delta: "token", partial: first }
         }, ctx);
      }
      setNow(1500);
      handlers.get("message_end")({ message: first }, ctx);
      handlers.get("tool_execution_start")({ toolName: "bash" });
      handlers.get("tool_execution_end")({ result: {} });
      setNow(1800);
      handlers.get("turn_end")({ message: first, toolResults: [{ role: "toolResult" }] }, ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0].text, /TPS \d+\.\d+ tok\/s/);
      assert.match(notifications[0].text, /last message 0\.4s/);
      assert.match(notifications[0].text, /loop 0\.8s/);

      setNow(2500);
      handlers.get("message_start")({ message: second });
      for (const time of [2600, 2700, 2800, 2900]) {
         setNow(time);
         handlers.get("message_update")({
            message: second,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token", partial: second }
         }, ctx);
      }
      setNow(3000);
      handlers.get("message_end")({ message: second }, ctx);

      setNow(4000);
      handlers.get("agent_end")({ messages: [first, second] }, ctx);

      assert.equal(notifications.length, 2);
      assert.match(notifications[1].text, /TPS 5\.9 tok\/s/);
      assert.match(notifications[1].text, /out 10/);
      assert.match(notifications[1].text, /loop 3\.0s/);
      assert.match(notifications[1].text, /last message 0\.5s/);
      assert.match(statuses.at(-1).text, /5\.9 tok\/s/);
   });
});
