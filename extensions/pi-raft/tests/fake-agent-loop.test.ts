import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAgentLoop, type FakeAgentLoop } from "./fixtures/fake-agent-loop.js";

// Regression boundary for the approved simplification (remove runtime entropy
// compilation/enforcement and learned catalog repairs; keep strict validation).
//
// The fake agent loop boots the real Raft extension and replays the exact
// host events a live Pi turn emits around a model tool call, so the assertions
// sit on public observable boundaries (raft_exec content/details and the
// session's on-disk artifacts) rather than private helpers. The scripted
// raft_exec programs stand in for the model's tool calls; nothing opens a
// socket or a provider stream.

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const createHarness = async (): Promise<{ loop: FakeAgentLoop; agentDir: string; cwd: string }> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-fake-agent-loop-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "note.txt"), "first line\nsecond line\n");
  fs.writeFileSync(
    path.join(cwd, ".pi", "raft.json"),
    JSON.stringify({
      mesh: { enabled: false },
      mcp: { enabled: false },
      memory: { enabled: false },
      agents: { enabled: false },
      speculation: { enabled: false },
      ui: { enabled: false },
    }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

  const loop = await createFakeAgentLoop({ cwd, agentDir, sessionId: "fake-agent-loop" });
  return { loop, agentDir, cwd };
};

describe("fake Pi agent loop", () => {
  it("still executes canonical raft_exec calls against a strict tool schema", async () => {
    const { loop } = await createHarness();
    const result = await loop.prompt('return await tools.call({ ref: "agents.list", args: {} });');

    expect(result.details.success, result.details.error).toBe(true);
    expect(result.details.trace.operations).toMatchObject([
      { ref: "agents.list", outcome: "succeeded" },
    ]);
    await loop.shutdown();
  });

  it("rejects a call carrying an unknown argument instead of repairing it", async () => {
    const { loop } = await createHarness();
    // The unknown key is observed at the real validation boundary. Under the
    // approved simplification the call must fail strict schema validation
    // instead of being repaired and dispatched.
    const result = await loop.prompt(
      'return await tools.call({ ref: "agents.list", args: { unknownKey: "note.txt" } });',
    );

    expect(result.details.success, JSON.stringify(result.details)).toBe(false);
    expect(result.details.error).toMatch(/Invalid arguments for agents\.list/i);
    expect(result.details.error).toMatch(/file|additional properties/i);
    await loop.shutdown();
  });

  it("leaves no entropy or repair artifacts behind after a session lifecycle", async () => {
    const { loop, agentDir } = await createHarness();
    await loop.prompt('return await tools.call({ ref: "agents.list", args: {} });');
    await loop.prompt(
      'return await tools.call({ ref: "agents.list", args: { unknownKey: "note.txt" } });',
    );
    await loop.shutdown();

    expect(fs.existsSync(path.join(agentDir, "raft", "repairs"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "raft", "entropy"))).toBe(false);
  });

  it("exposes only the approved minimal guest surface and names static refs directly", async () => {
    const { loop } = await createHarness();

    const surfaceResult = await loop.prompt(`
      return JSON.stringify({
        toolsKeys: Object.keys(tools).sort(),
        agentsKeys: Object.keys(agents).sort(),
        absentGlobals: {
          components: typeof (globalThis as any).components,
          mesh: typeof (globalThis as any).mesh,
          state: typeof (globalThis as any).state,
          compact: typeof (globalThis as any).compact,
          workflow: typeof (globalThis as any).workflow,
          council: typeof (globalThis as any).council,
          rlm: typeof (globalThis as any).rlm,
          agent: typeof (globalThis as any).agent,
          parallel: typeof (globalThis as any).parallel,
          pipeline: typeof (globalThis as any).pipeline,
          phase: typeof (globalThis as any).phase,
          log: typeof (globalThis as any).log,
          budget: typeof (globalThis as any).budget,
          setTimeout: typeof (globalThis as any).setTimeout,
          setInterval: typeof (globalThis as any).setInterval,
          clearTimeout: typeof (globalThis as any).clearTimeout,
          clearInterval: typeof (globalThis as any).clearInterval,
        },
      });
    `);

    expect(surfaceResult.details.success, surfaceResult.details.error).toBe(true);
    expect(JSON.parse(surfaceResult.content[0]?.text ?? "{}")).toEqual({
      toolsKeys: ["call", "describe", "progress", "search"],
      agentsKeys: ["list", "log", "run", "spawn", "status", "stop", "wait"],
      absentGlobals: {
        components: "undefined",
        mesh: "undefined",
        state: "undefined",
        compact: "undefined",
        workflow: "undefined",
        council: "undefined",
        rlm: "undefined",
        agent: "undefined",
        parallel: "undefined",
        pipeline: "undefined",
        phase: "undefined",
        log: "undefined",
        budget: "undefined",
        setTimeout: "undefined",
        setInterval: "undefined",
        clearTimeout: "undefined",
        clearInterval: "undefined",
      },
    });

    const removedRefResult = await loop.prompt(`
      return await tools.call({ ref: "memory.sessions", args: {} });
    `);
    expect(removedRefResult.details.success).toBe(false);
    expect(removedRefResult.details.error).toMatch(
      /Unknown (?:Raft )?(?:provider|action|tool)|not found|unrecognized/i,
    );

    // Search covers dynamic namespaces only. A core tool name is not a Raft
    // ref, so it ranks nothing rather than resolving to a callable action.
    const searchResult = await loop.prompt(`
      return JSON.stringify(await tools.search("read"));
    `);
    expect(searchResult.details.success, searchResult.details.error).toBe(true);
    expect(JSON.parse(searchResult.content[0]?.text ?? "[]")).toEqual([]);

    await loop.shutdown();
  });
});
