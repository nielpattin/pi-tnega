import { test } from "vitest";

import assert from "node:assert/strict";
import { readCoreContextUsage } from "../context-usage.ts";

test("readCoreContextUsage returns Pi context estimates for branch summaries", () => {
   const usage = readCoreContextUsage({
      getContextUsage() {
         return { contextWindow: 5000, percent: 25, tokens: 1250 };
      },
   });

   assert.deepEqual(usage, {
      contextPercent: 25,
      contextTokens: 1250,
      contextWindow: 5000,
   });
});

test("readCoreContextUsage computes percent when Pi returns only token totals", () => {
   const usage = readCoreContextUsage({
      getContextUsage() {
         return { contextWindow: 4000, tokens: 1000 };
      },
   });

   assert.deepEqual(usage, {
      contextPercent: 25,
      contextTokens: 1000,
      contextWindow: 4000,
   });
});

test("readCoreContextUsage ignores unknown or unusable estimates", () => {
   assert.equal(readCoreContextUsage({}), null);
   assert.equal(readCoreContextUsage({ getContextUsage: () => undefined }), null);
   assert.equal(
      readCoreContextUsage({
         getContextUsage: () => ({ contextWindow: 5000, percent: null, tokens: null }),
      }),
      null,
   );
   assert.equal(
      readCoreContextUsage({
         getContextUsage: () => ({ contextWindow: 0, percent: 0, tokens: 100 }),
      }),
      null,
   );
});
