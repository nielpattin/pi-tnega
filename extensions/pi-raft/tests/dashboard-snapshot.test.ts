import { describe, expect, it } from "vitest";
import type { RaftState } from "../src/raft-state.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import { createDashboardSnapshot } from "../src/ui/snapshot.js";

const record = (id: string, nestedAgents?: AgentRunRecord[]): AgentRunRecord => ({
  id,
  name: id,
  task: `Inspect ${id}`,
  text: `Inspect ${id}`,
  status: "completed",
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  startedAt: 1,
  updatedAt: 2,
  finishedAt: 3,
  turns: 1,
  toolCalls: 0,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
  ...(nestedAgents ? { nestedAgents } : {}),
});

const stateFor = (records: AgentRunRecord[]): RaftState =>
  ({
    activity: { runs: () => [] },
    agents: { list: () => records },
    mainAgentInfo: () => ({
      id: "main",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: "/tmp/project",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    }),
    componentGraph: () => ({ components: [], edges: [], cycles: [] }),
    widgetDismissedAt: undefined,
  }) as unknown as RaftState;

describe("dashboard snapshot local agents", () => {
  it("includes Main and preserves exact one-shot agent fields", () => {
    const snapshot = createDashboardSnapshot(stateFor([record("agent-1")]));
    expect(snapshot.main).toMatchObject({ id: "main", name: "Main", kind: "main" });
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        id: "agent-1",
        name: "agent-1",
        status: "completed",
        task: "Inspect agent-1",
        text: "Inspect agent-1",
        turns: 1,
        toolCalls: 0,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
      }),
    ]);
  });

  it("projects nested one-shot agents with their parent and bounded depth", () => {
    const child = record("child");
    const snapshot = createDashboardSnapshot(stateFor([record("parent", [child])]));
    expect(
      snapshot.agents.map((agent) => ({
        id: agent.id,
        parentId: agent.parentId,
        nestingDepth: agent.nestingDepth,
      })),
    ).toEqual([
      { id: "parent", parentId: undefined, nestingDepth: undefined },
      { id: "child", parentId: "parent", nestingDepth: 1 },
    ]);
  });
});
