import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import { TerminalManager, type TerminalManagerShape } from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

function nodeCmd(script: string) {
   return `node -e '${script.replace(/'/g, "'\\''")}'`;
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

test("readiness: rejects if neither log nor port provided in ready object", async () => {
   await withManager(async (manager, runtime) => {
      await assert.rejects(
         runTool(
            runtime,
            manager.start({
               command: nodeCmd('console.log("hi"); setInterval(() => {}, 1000);'),
               title: "test",
               cwd: process.cwd(),
               ready: {} as any
            })
         ),
         /log.*port|port.*log/i
      );
   });
});

test("readiness: resolves when log regex matches output", async () => {
   await withManager(async (manager, runtime) => {
      const snap = await runTool(
         runtime,
         manager.start({
            command: nodeCmd('setTimeout(() => console.log("Server started on port 3000"), 100); setInterval(() => {}, 1000);'),
            title: "log server",
            cwd: process.cwd(),
            ready: {
               log: "Server started",
               timeoutSec: 5
            }
         })
      );

      assert.equal(snap.status, "running");
      assert.ok(snap.stdout.text.includes("Server started"));
      assert.equal(snap.readyResult?.ready, true);

      await runTool(runtime, manager.kill([snap.id]));
   });
});

test("readiness: resolves when TCP port becomes available", async () => {
   await withManager(async (manager, runtime) => {
      // Find an available port
      const server = net.createServer();
      const port = await new Promise<number>((resolve) => {
         server.listen(0, "127.0.0.1", () => {
            const p = (server.address() as net.AddressInfo).port;
            server.close(() => resolve(p));
         });
      });

      // Start node HTTP server on that port after 100ms delay
      const snap = await runTool(
         runtime,
         manager.start({
            command: nodeCmd(`
               setTimeout(() => {
                  const http = require("http");
                  const s = http.createServer((req, res) => res.end("ok"));
                  s.listen(${port}, "127.0.0.1");
               }, 100);
               setInterval(() => {}, 1000);
            `),
            title: "http server",
            cwd: process.cwd(),
            ready: {
               port,
               timeoutSec: 5
            }
         })
      );

      assert.equal(snap.status, "running");
      assert.equal(snap.readyResult?.ready, true);

      await runTool(runtime, manager.kill([snap.id]));
   });
});

test("readiness: times out without killing process when condition not met", async () => {
   await withManager(async (manager, runtime) => {
      const snap = await runTool(
         runtime,
         manager.start({
            command: nodeCmd('console.log("booting..."); setInterval(() => {}, 1000);'),
            title: "slow server",
            cwd: process.cwd(),
            ready: {
               log: "never-appearing-string",
               timeoutSec: 1
            }
         })
      );

      // Process stays running on timeout!
      assert.equal(snap.status, "running");
      assert.equal(snap.readyResult?.ready, false);
      assert.equal(snap.readyResult?.timedOut, true);

      await runTool(runtime, manager.kill([snap.id]));
   });
});
