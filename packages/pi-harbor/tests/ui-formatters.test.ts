import { describe, expect, it } from "vitest";
import { formatJobRow, formatProcessRow, formatDuration, formatJobTable, formatProcessTable } from "../src/ui/formatters.js";
import type { Job, ProcessEntry } from "../src/domain.js";

describe("UI Formatters", () => {
  it("formats duration helper properly", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(3500)).toBe("3.5s");
    expect(formatDuration(125000)).toBe("2m 5s");
    expect(formatDuration(3700000)).toBe("1h 1m");
  });

  it("formats a job row with stable columns (id, name, status, agent/harness, duration/age)", () => {
    const mockJob: Job = {
      id: "task-1",
      ownerSessionId: "parent",
      name: "lint-code",
      kind: "agent",
      harness: "pi",
      agent: "scout",
      promptOrCommand: "lint src/",
      status: "completed",
      createdAt: 1000,
      startedAt: 1000,
      settledAt: 5000,
      waitInterest: 0,
      killInterest: 0
    };

    const row = formatJobRow(mockJob);
    expect(row).toContain("task-1");
    expect(row).toContain("lint-code");
    expect(row).toContain("completed");
    expect(row).toContain("scout (pi)");
    expect(row).toContain("4s");
  });

  it("formats a process row with stable columns", () => {
    const mockProc: ProcessEntry = {
      id: "bash-1",
      name: "dev-server",
      command: "npm run dev",
      cwd: "/app",
      pid: 1234,
      status: "running",
      readyState: { ready: true, logMatched: false, portMatched: false },
      spawnTime: 1000,
      stdoutBytes: 100,
      stderrBytes: 0,
      processWaitInterest: 0,
      processKillInterest: 0
    };

    const now = 6000;
    const row = formatProcessRow(mockProc, now);
    expect(row).toContain("bash-1");
    expect(row).toContain("dev-server");
    expect(row).toContain("running");
    expect(row).toContain("1234");
    expect(row).toContain("5s");
  });

  it("formats job tables and process tables", () => {
    const jobs: Job[] = [
      {
        id: "task-1",
        ownerSessionId: "parent",
        name: "test",
        kind: "agent",
        harness: "pi",
        agent: "task",
        promptOrCommand: "do test",
        status: "running",
        createdAt: 1000,
        waitInterest: 0,
        killInterest: 0
      }
    ];

    const table = formatJobTable(jobs, 3000);
    expect(table).toContain("task-1");
    expect(table).toContain("running");
  });
});
