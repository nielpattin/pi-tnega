import { describe, expect, it } from "vitest";
import type { RaftActivityCall, RaftActivityRun } from "../src/activity/types.js";
import { entitiesForOverview, phasePanels } from "../src/ui/dashboard-model.js";
import type { RaftDashboardSnapshot, RaftUiAgent, RaftUiMain } from "../src/ui/types.js";

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

const agent: RaftUiAgent = {
  id: "agent-1",
  name: "Raft agent",
  status: "completed",
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  startedAt: 1,
  updatedAt: 2,
  runId: "run-1",
};

const call = (id: string, ref: string, entityId?: string): RaftActivityCall => ({
  id,
  ref,
  label: ref,
  kind: "agent",
  status: "completed",
  entityKind: "agent",
  startedAt: 1,
  updatedAt: 2,
  ...(entityId === undefined ? {} : { entityId }),
});

const overview = (calls: RaftActivityCall[]) => {
  const run: RaftActivityRun = {
    id: "run-1",
    name: "run-1",
    status: "completed",
    startedAt: 1,
    updatedAt: 2,
    phases: [],
    calls,
    items: [],
    events: [],
  };
  const snapshot: RaftDashboardSnapshot = {
    now: 3,
    runs: [run],
    main,
    agents: [agent],
    componentGraph: { components: [], edges: [], cycles: [] },
    state: [],
  };
  const panels = phasePanels(snapshot, run);
  const panel = panels[0];
  if (!panel) throw new Error("expected an activity panel");
  return entitiesForOverview(snapshot, run, panel).map((entity) => entity.id);
};

describe("dashboard agent rows", () => {
  it("hides a linked agents.wait call when its agent is visible", () => {
    const ids = overview([
      call("c-spawn", "agents.spawn", "agent-1"),
      call("c-wait", "agents.wait", "agent-1"),
    ]);
    expect(ids).toContain("agent:agent-1");
    expect(ids).toContain("main:main");
    expect(ids).not.toContain("call:c-wait");
  });

  it("keeps hiding linked agents.run and agents.spawn calls", () => {
    const ids = overview([
      call("c-run", "agents.run", "agent-1"),
      call("c-spawn", "agents.spawn", "agent-1"),
    ]);
    expect(ids).not.toContain("call:c-run");
    expect(ids).not.toContain("call:c-spawn");
  });

  it("keeps an unlinked agents.wait call visible as history", () => {
    const ids = overview([call("c-wait", "agents.wait", "ghost")]);
    expect(ids).toContain("call:c-wait");
  });

  it("keeps linked control calls such as agents.status visible", () => {
    const ids = overview([call("c-status", "agents.status", "agent-1")]);
    expect(ids).toContain("call:c-status");
  });
});
