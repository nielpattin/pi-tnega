import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { RaftActivityRun } from "../src/activity/types.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import { RaftDashboard } from "../src/ui/dashboard.js";
import type { RaftTranscriptEntry } from "../src/ui/transcript.js";
import type { RaftDashboardSnapshot, RaftUiAgent, RaftUiMain } from "../src/ui/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = { requestRender: () => {}, terminal: { rows: 40 } } as never;

const main: RaftUiMain = {
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
};

const agentRecord = (id: string, status: AgentRunRecord["status"] = "running"): AgentRunRecord => ({
  id,
  name: id,
  task: `Task ${id}`,
  text: `Task ${id}`,
  status,
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  startedAt: 1,
  updatedAt: 2,
  turns: 1,
  toolCalls: 3,
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
});

const uiAgent = (id: string, overrides: Partial<RaftUiAgent> = {}): RaftUiAgent => ({
  id,
  name: id,
  status: "running",
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  startedAt: 1,
  updatedAt: 2,
  ...overrides,
});

const run: RaftActivityRun = {
  id: "run-1",
  name: "run-1",
  status: "running",
  startedAt: 1,
  updatedAt: 2,
  phases: [],
  calls: [],
  items: [],
  events: [],
};

const snapshotFor = (agents: RaftUiAgent[]): RaftDashboardSnapshot => ({
  now: 3,
  runs: [run],
  main,
  agents,
  componentGraph: { components: [], edges: [], cycles: [] },
  state: [],
});

const open = (
  snapshot: RaftDashboardSnapshot,
  transcripts: Record<string, RaftTranscriptEntry[]>,
): RaftDashboard => {
  let current = snapshot;
  return new RaftDashboard(
    tui,
    theme,
    () => current,
    () => {},
    {
      agentTranscript: (agent) => ({
        entries: transcripts[agent.id] ?? [],
        truncated: false,
        hasMore: false,
        hasNewer: false,
      }),
    },
  );
};

const text = (component: RaftDashboard): string => component.render(100).join("\n");

describe("dashboard child-agent drill-in", () => {
  it("moves selection from Main to a spawned child with j and shows it highlighted", () => {
    const component = open(snapshotFor([uiAgent("agent-1")]), {});
    // Focus the entities pane, then move down past Main to the child row.
    component.handleInput("\t");
    const initial = text(component)
      .split("\n")
      .filter((line) => line.includes("›"));
    expect(initial.some((line) => line.includes("Main"))).toBe(true);
    component.handleInput("j");
    const output = text(component);
    expect(output).toContain("agent-1");
    const selected = output.split("\n").filter((line) => line.includes("›"));
    expect(selected.some((line) => line.includes("agent-1"))).toBe(true);
  });

  it("opens the child summary with enter and switches to its transcript with t", () => {
    const entries: RaftTranscriptEntry[] = [
      { id: "e1", kind: "assistant", label: "thinking", text: "reading files" },
      { id: "e2", kind: "tool", label: "read", toolName: "read", status: "completed" },
    ];
    const component = open(snapshotFor([uiAgent("agent-1")]), { "agent-1": entries });
    component.handleInput("\t");
    component.handleInput("j");
    component.handleInput("\r");
    expect(text(component)).toContain("agent-1");
    component.handleInput("t");
    const output = text(component);
    expect(output).toContain("transcript");
    expect(output).toContain("reading files");
  });

  it("expands a nested tool body with ctrl+o once the transcript is open", () => {
    const entries: RaftTranscriptEntry[] = [
      {
        id: "e2",
        kind: "tool",
        label: "read",
        toolName: "read",
        status: "completed",
        args: { path: "src/index.ts" },
        text: "first line",
      },
    ];
    const component = open(snapshotFor([uiAgent("agent-1")]), { "agent-1": entries });
    component.handleInput("\t");
    component.handleInput("j");
    component.handleInput("\r");
    component.handleInput("t");
    const collapsed = text(component);
    expect(collapsed).toContain("read");
    component.handleInput("\x0f");
    const expanded = text(component);
    expect(expanded).toContain("read");
  });

  it("keeps agentRecord nested fixtures projecting through the snapshot", () => {
    const child = agentRecord("child", "completed");
    const parent: AgentRunRecord = { ...agentRecord("parent"), nestedAgents: [child] };
    expect(parent.nestedAgents?.[0]?.id).toBe("child");
  });
});
