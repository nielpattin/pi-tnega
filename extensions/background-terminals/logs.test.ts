import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, type TerminalManagerShape } from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

function nodeCmd(script: string) {
   return `node -e "${script.replace(/"/g, '\\"')}"`;
}

async function withManager(
   run: (manager: TerminalManagerShape, runtime: ReturnType<typeof createTerminalRuntime>) => Promise<void>
) {
   const runtime = createTerminalRuntime();
   try {
      const manager = await runtime.runPromise(TerminalManager);
      await run(manager, runtime);
   } finally {
      await runtime.dispose();
   }
}

test("bg_logs: retrieves logs with lines, head, grep, cursor", async () => {
   await withManager(async (manager, runtime) => {
      const snap = await runTool(
         runtime,
         manager.start({
            command: nodeCmd('console.log("line 1: apple"); console.log("line 2: banana"); console.log("line 3: cherry"); setInterval(() => {}, 1000);'),
            title: "log producer",
            cwd: process.cwd()
         })
      );

      // Wait a moment for output to collect
      await new Promise((r) => setTimeout(r, 200));

      // Test grep
      const grepRes = await runTool(
         runtime,
         manager.logs({
            id: snap.id,
            grep: "banana"
         })
      );
      assert.ok(grepRes.text.includes("banana"));
      assert.ok(!grepRes.text.includes("apple"));

      // Test head vs tail
      const headRes = await runTool(
         runtime,
         manager.logs({
            id: snap.id,
            lines: 1,
            head: true
         })
      );
      assert.ok(headRes.text.includes("apple"));

      const tailRes = await runTool(
         runtime,
         manager.logs({
            id: snap.id,
            lines: 1,
            head: false
         })
      );
      assert.ok(tailRes.text.includes("cherry"));

      // Test cursor
      const initialRes = await runTool(runtime, manager.logs({ id: snap.id }));
      assert.ok(typeof initialRes.cursor === "number");
      assert.ok(initialRes.cursor > 0);

      const cursorRes = await runTool(runtime, manager.logs({ id: snap.id, cursor: initialRes.cursor }));
      assert.equal(cursorRes.text, "");
      assert.equal(cursorRes.cursor, initialRes.cursor);

      await runTool(runtime, manager.kill([snap.id]));
   });
});

test("bg_logs: follow mode waits for new output past cursor", async () => {
   await withManager(async (manager, runtime) => {
      const snap = await runTool(
         runtime,
         manager.start({
            command: nodeCmd('console.log("part 1"); setTimeout(() => console.log("part 2"), 300); setInterval(() => {}, 1000);'),
            title: "streaming log",
            cwd: process.cwd()
         })
      );

      await new Promise((r) => setTimeout(r, 100));

      const firstLog = await runTool(runtime, manager.logs({ id: snap.id }));
      assert.ok(firstLog.text.includes("part 1"));

      // Follow for new output
      const followLog = await runTool(
         runtime,
         manager.logs({
            id: snap.id,
            cursor: firstLog.cursor,
            follow: true,
            timeoutSec: 3
         })
      );

      assert.ok(followLog.text.includes("part 2"));
      assert.ok(followLog.cursor > firstLog.cursor);

      await runTool(runtime, manager.kill([snap.id]));
   });
});
