import { describe, it, expect, vi } from "vitest";
import { buildAgyArgv, createAgyFsmSession } from "../src/backends/agy.js";
import { Effect } from "effect";

describe("AGY Control FSM", () => {
  it("builds long-form --print argv exclusively", () => {
    const argv = buildAgyArgv({
      model: "gemini-3.6-flash-medium",
      effort: "high",
      cwd: "/test",
      conversationId: "conv-1",
      prompt: "Hello agy"
    });
    expect(argv).toContain("--print");
    expect(argv).not.toContain("-p");
    expect(argv[argv.length - 2]).toBe("--print");
    expect(argv[argv.length - 1]).toBe("Hello agy");
  });

  it("handles exit 0 with empty queue: settles Completed once", async () => {
    let settledResult: any = null;
    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      onData("Print mode: conversation=conv-100\nDone output");
      setTimeout(() => onClose(0), 10);
      return { pid: 1234, kill: vi.fn() };
    });

    const session = createAgyFsmSession({
      prompt: "Initial task",
      spawnProc: fakeSpawn,
      onSettled: (res) => {
        settledResult = res;
      }
    });

    await Effect.runPromise(session.start());
    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe("settled");
    expect(settledResult?.status).toBe("completed");
    expect(settledResult?.finalText).toBe("Print mode: conversation=conv-100\nDone output");
  });

  it("handles followUp while running: enqueues FIFO and chains continuation spawn", async () => {
    const spawnedCmds: string[] = [];
    let processClose: any = null;

    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      spawnedCmds.push(cmd);
      processClose = onClose;
      onData("Print mode: conversation=conv-200\n");
      return { pid: 2000, kill: vi.fn() };
    });

    let settledResult: any = null;
    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn,
      onSettled: (res) => {
        settledResult = res;
      }
    });

    await Effect.runPromise(session.start());
    expect(session.state).toBe("running");

    // Add follow-up while running
    await Effect.runPromise(session.control("Follow up prompt 1", "followUp"));
    expect(session.pendingFollowUps).toEqual(["Follow up prompt 1"]);

    // First process exits code 0
    processClose(0);
    await new Promise((r) => setTimeout(r, 20));

    // Should have spawned second step with --conversation conv-200
    expect(spawnedCmds.length).toBe(2);
    expect(spawnedCmds[1]).toContain("--conversation conv-200");
    expect(spawnedCmds[1]).toContain('--print "Follow up prompt 1"');
    expect(session.state).toBe("running");

    // Second process exits code 0
    processClose(0);
    await new Promise((r) => setTimeout(r, 20));

    expect(session.state).toBe("settled");
    expect(settledResult?.status).toBe("completed");
  });

  it("handles steer while running: clears follow-ups, tree kills active process, and spawns steer prompt", async () => {
    const spawnedCmds: string[] = [];
    let processClose: any = null;
    let killed = false;

    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      spawnedCmds.push(cmd);
      processClose = onClose;
      onData("Print mode: conversation=conv-300\n");
      return {
        pid: 3000,
        kill: vi.fn(() => {
          killed = true;
        })
      };
    });

    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn
    });

    await Effect.runPromise(session.start());
    await Effect.runPromise(session.control("Follow up 1", "followUp"));
    expect(session.pendingFollowUps.length).toBe(1);

    // Steer while running
    await Effect.runPromise(session.control("Steer prompt", "steer"));
    expect(session.pendingFollowUps.length).toBe(0); // cleared followUp queue
    expect(session.state).toBe("resumePending");
    expect(killed).toBe(true);

    // Process exits due to kill
    processClose(1);
    await new Promise((r) => setTimeout(r, 20));

    // Should have spawned steer continuation
    expect(spawnedCmds.length).toBe(2);
    expect(spawnedCmds[1]).toContain("--conversation conv-300");
    expect(spawnedCmds[1]).toContain('--print "Steer prompt"');
    expect(session.state).toBe("running");
  });

  it("handles double steer while resumePending: replaces text without second kill", async () => {
    let killCount = 0;
    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      onData("Print mode: conversation=conv-400\n");
      return {
        pid: 4000,
        kill: vi.fn(() => {
          killCount++;
        })
      };
    });

    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn
    });

    await Effect.runPromise(session.start());
    await Effect.runPromise(session.control("Steer 1", "steer"));
    expect(killCount).toBe(1);
    expect(session.pendingSteerText).toBe("Steer 1");

    // Second steer while resumePending
    await Effect.runPromise(session.control("Steer 2", "steer"));
    expect(killCount).toBe(1); // No second kill
    expect(session.pendingSteerText).toBe("Steer 2");
  });

  it("handles followUp while resumePending: appends to queue without second process", async () => {
    let killCount = 0;
    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      onData("Print mode: conversation=conv-450\n");
      return {
        pid: 4500,
        kill: vi.fn(() => {
          killCount++;
        })
      };
    });

    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn
    });

    await Effect.runPromise(session.start());
    await Effect.runPromise(session.control("Steer 1", "steer"));
    expect(killCount).toBe(1);

    await Effect.runPromise(session.control("Follow up after steer", "followUp"));
    expect(session.pendingFollowUps).toEqual(["Follow up after steer"]);
    expect(killCount).toBe(1);
  });

  it("handles steer before conversationId is captured: queues pendingSteer and triggers kill once id arrives", async () => {
    const spawnedCmds: string[] = [];
    let emitData: any = null;

    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      spawnedCmds.push(cmd);
      emitData = onData;
      return {
        pid: 5500,
        kill: vi.fn(() => {
          onClose(1);
        })
      };
    });

    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn
    });

    await Effect.runPromise(session.start());
    expect(session.conversationId).toBeUndefined();

    // Steer before conversationId is known
    await Effect.runPromise(session.control("Early steer", "steer"));
    expect(session.pendingSteerText).toBe("Early steer");

    // Now conversationId is received from stdout
    emitData("Print mode: conversation=conv-550\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(session.conversationId).toBe("conv-550");
    expect(spawnedCmds.length).toBe(2);
    expect(spawnedCmds[1]).toContain("--conversation conv-550");
    expect(spawnedCmds[1]).toContain('--print "Early steer"');
  });

  it("handles non-zero exit with pending follow-ups: clears queue and settles Failed", async () => {
    let processClose: any = null;
    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      processClose = onClose;
      onData("Partial stdout output");
      return { pid: 5000, kill: vi.fn() };
    });

    let settledResult: any = null;
    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn,
      onSettled: (res) => {
        settledResult = res;
      }
    });

    await Effect.runPromise(session.start());
    await Effect.runPromise(session.control("Follow up", "followUp"));
    expect(session.pendingFollowUps.length).toBe(1);

    // Natural non-zero exit
    processClose(1);
    await new Promise((r) => setTimeout(r, 20));

    expect(session.state).toBe("settled");
    expect(session.pendingFollowUps.length).toBe(0);
    expect(settledResult?.status).toBe("failed");
    expect(settledResult?.partialText).toBe("Partial stdout output");
  });

  it("handles user cancel: clears queues, tree kills, and settles Interrupted", async () => {
    let killed = false;
    const fakeSpawn = vi.fn((cmd, opts, onClose, onData) => {
      onData("Print mode: conversation=conv-600\n");
      return {
        pid: 6000,
        kill: vi.fn(() => {
          killed = true;
        })
      };
    });

    let settledResult: any = null;
    const session = createAgyFsmSession({
      prompt: "Initial prompt",
      spawnProc: fakeSpawn,
      onSettled: (res) => {
        settledResult = res;
      }
    });

    await Effect.runPromise(session.start());
    await Effect.runPromise(session.control("Follow up", "followUp"));

    await Effect.runPromise(session.abort());

    expect(killed).toBe(true);
    expect(session.state).toBe("cancelled");
    expect(session.pendingFollowUps.length).toBe(0);
    expect(settledResult?.status).toBe("cancelled");
  });
});
