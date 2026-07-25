import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalSnapshot } from "./src/domain.ts";
import { TerminalManager, type TerminalManagerShape } from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

function nodeCmd(script: string) {
   return `node -e '${script}'`;
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

function settlement(manager: TerminalManagerShape, id: string) {
   return new Promise<{ snap: TerminalSnapshot; consumed: boolean }>((resolve) => {
      const existing = manager.view.get(id);
      if (existing && existing.status !== "running") {
         resolve({ snap: existing, consumed: false });
         return;
      }
      manager.view.setOnSettled((snap, consumed) => {
         if (snap.id === id || (snap as any).name === id) {
            resolve({ snap, consumed });
         }
      });
   });
}

test("stable process names: accepts valid name and resolves by name or id", async () => {
   await withManager(async (manager, runtime) => {
      const snap = await runTool(
         runtime,
         manager.start({
            command: nodeCmd("setTimeout(() => {}, 500)"),
            title: "named server",
            cwd: process.cwd(),
            name: "web-server"
         })
      );

      assert.equal(snap.name, "web-server");
      assert.ok(snap.id.startsWith("bt-"));

      // View lookup by name
      const byName = manager.view.get("web-server");
      assert.ok(byName);
      assert.equal(byName.id, snap.id);

      // Status by name
      const statusSnap = await runTool(runtime, manager.status("web-server"));
      assert.equal(statusSnap.id, snap.id);

      // Clean up
      await runTool(runtime, manager.kill(["web-server"]));
   });
});

test("stable process names: rejects duplicate name while running, allows after settle", async () => {
   await withManager(async (manager, runtime) => {
      const snap1 = await runTool(
         runtime,
         manager.start({
            command: nodeCmd("setTimeout(() => {}, 200)"),
            title: "short worker",
            cwd: process.cwd(),
            name: "worker-1"
         })
      );

      // Attempting duplicate name while running should fail
      await assert.rejects(
         runTool(
            runtime,
            manager.start({
               command: nodeCmd("console.log('hi')"),
               title: "dup worker",
               cwd: process.cwd(),
               name: "worker-1"
            })
         ),
         /already uses that name|already exists/i
      );

      // Wait for snap1 to settle naturally
      await settlement(manager, snap1.id);

      // Now starting with worker-1 should succeed
      const snap2 = await runTool(
         runtime,
         manager.start({
            command: nodeCmd("console.log('done')"),
            title: "new worker",
            cwd: process.cwd(),
            name: "worker-1"
         })
      );
      assert.equal(snap2.name, "worker-1");
      assert.notEqual(snap2.id, snap1.id);
   });
});

test("stable process names: validates length (1 to 48 chars)", async () => {
   await withManager(async (manager, runtime) => {
      // Empty name
      await assert.rejects(
         runTool(
            runtime,
            manager.start({
               command: nodeCmd("console.log(1)"),
               title: "t",
               cwd: process.cwd(),
               name: ""
            })
         ),
         /name/i
      );

      // Name > 48 chars
      const longName = "a".repeat(49);
      await assert.rejects(
         runTool(
            runtime,
            manager.start({
               command: nodeCmd("console.log(1)"),
               title: "t",
               cwd: process.cwd(),
               name: longName
            })
         ),
         /name/i
      );
   });
});
