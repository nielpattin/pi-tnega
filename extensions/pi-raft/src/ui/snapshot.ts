import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RaftActivityRun } from "../activity/types.js";
import type { RaftState } from "../raft-state.js";
import type { AgentHandleInfo, AgentRunRecord } from "../agents/types.js";
import {
  activeStatuses,
  orderAgentsByCreation,
  type RaftDashboardSnapshot,
  type RaftUiAgent,
} from "./types.js";

const MAX_UI_AGENTS = 240;
const isRunRecord = (value: AgentRunRecord | AgentHandleInfo): value is AgentRunRecord =>
  "startedAt" in value;
const boundedUiAgents = (agents: RaftUiAgent[]): RaftUiAgent[] => {
  const selected = new Map<string, RaftUiAgent>();
  for (const agent of agents) if (activeStatuses.has(agent.status)) selected.set(agent.id, agent);
  for (const agent of orderAgentsByCreation(agents).slice(-MAX_UI_AGENTS))
    selected.set(agent.id, agent);
  return orderAgentsByCreation([...selected.values()]);
};

export class RaftDashboardSnapshotCache {
  private inputs: unknown;
  private snapshot: RaftDashboardSnapshot | undefined;
  get(inputs: unknown): RaftDashboardSnapshot | undefined {
    return this.snapshot && isDeepStrictEqual(this.inputs, inputs)
      ? { ...this.snapshot, now: Date.now() }
      : undefined;
  }
  set(inputs: unknown, snapshot: RaftDashboardSnapshot, immutableActivity = false): void {
    this.inputs =
      immutableActivity && inputs && typeof inputs === "object"
        ? structuredClone(inputs)
        : structuredClone(inputs);
    this.snapshot = snapshot;
  }
  clear(): void {
    this.inputs = undefined;
    this.snapshot = undefined;
  }
}

export const createDashboardSnapshot = (
  state: RaftState,
  context?: ExtensionContext,
  activityRuns?: RaftActivityRun[],
  cache?: RaftDashboardSnapshotCache,
  immutableActivity = false,
): RaftDashboardSnapshot => {
  const runs = activityRuns ?? state.activity.runs();
  const records =
    typeof state.agents.listForUi === "function" ? state.agents.listForUi() : state.agents.list();
  const main = state.mainAgentInfo(context);
  const componentGraph =
    typeof state.componentGraph === "function"
      ? state.componentGraph()
      : { components: [], edges: [], cycles: [] };
  const inputs = {
    runs,
    records,
    main,
    componentGraph,
    widgetDismissedAt: state.widgetDismissedAt,
  };
  const previous = cache?.get(inputs);
  if (previous) return previous;
  const links = runs.flatMap((run) =>
    run.calls.filter((call) => call.entityId).map((call) => ({ runId: run.id, call })),
  );
  const fromRecord = (
    record: AgentRunRecord | AgentHandleInfo,
    depth: number,
    parentId?: string,
    parent?: RaftUiAgent,
  ): RaftUiAgent => {
    const link = parentId
      ? undefined
      : links.find(
          ({ call }) =>
            record.id.startsWith(call.entityId!) || call.entityId!.startsWith(record.id),
        );
    const base: RaftUiAgent = {
      id: record.id,
      name: record.name,
      status: record.status,
      runner: record.runner,
      transport: record.transport,
      cwd: record.cwd,
      ...(link ? { startedAt: link.call.startedAt, runId: link.runId } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      ...(record.attachCommand ? { attachCommand: record.attachCommand } : {}),
      ...(isRunRecord(record) && record.logFile ? { logFile: record.logFile } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.worktree ? { worktree: record.worktree } : {}),
      ...(parentId ? { parentId } : {}),
      ...(depth > 0 ? { nestingDepth: depth } : {}),
      ...(parent?.runId && !link ? { runId: parent.runId } : {}),
      ...(link?.call.phaseId
        ? { phaseId: link.call.phaseId }
        : parent?.phaseId
          ? { phaseId: parent.phaseId }
          : {}),
    };
    if (!isRunRecord(record)) return base;
    return {
      ...base,
      task: record.task,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(record.currentTool ? { currentTool: record.currentTool } : {}),
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: { ...record.usage },
      ...(record.text ? { text: record.text } : {}),
      ...(record.value !== undefined ? { value: structuredClone(record.value) } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  };
  const agents: RaftUiAgent[] = [];
  const append = (
    record: AgentRunRecord | AgentHandleInfo,
    depth: number,
    parentId?: string,
    parent?: RaftUiAgent,
  ): void => {
    const agent = fromRecord(record, depth, parentId, parent);
    agents.push(agent);
    if (isRunRecord(record))
      for (const nested of record.nestedAgents ?? []) append(nested, depth + 1, record.id, agent);
  };
  for (const record of records) append(record, 0);
  const activeRun = (run: RaftActivityRun): number =>
    agents.some((agent) => agent.runId === run.id && activeStatuses.has(agent.status)) ? 1 : 0;
  const orderedRuns = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => activeRun(b.run) - activeRun(a.run) || a.index - b.index)
    .map(({ run }) => run);
  const snapshot: RaftDashboardSnapshot = {
    now: Date.now(),
    runs: orderedRuns,
    main,
    agents: boundedUiAgents(agents),
    componentGraph,
    state: [],
    widgetDismissedAt: state.widgetDismissedAt,
  };
  cache?.set(inputs, snapshot, immutableActivity);
  return snapshot;
};
