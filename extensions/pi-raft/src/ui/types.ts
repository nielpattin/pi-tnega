import type { RaftActivityRun } from "../activity/types.js";
import type { RaftComponentGraph } from "../components/types.js";
import type { RaftMainAgentInfo } from "../main-agent.js";
import type { AgentUsage } from "../agents/types.js";

export type RaftUiMain = RaftMainAgentInfo;

export interface RaftUiAgent {
  id: string;
  name: string;
  status: string;
  runner?: "pi" | "claude";
  transport: string;
  cwd: string;
  task?: string;
  model?: string;
  thinking?: string;
  currentTool?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  turns?: number;
  toolCalls?: number;
  usage?: AgentUsage;
  text?: string;
  value?: unknown;
  error?: string;
  logFile?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  runId?: string;
  phaseId?: string;
  parentId?: string;
  nestingDepth?: number;
  rootId?: string;
}

interface RaftUiStateEntry {
  key: string;
  label: string;
  status: string;
  owner?: string;
  detail?: string;
  value: unknown;
  version: number;
  updatedAt: number;
}

export interface RaftDashboardSnapshot {
  now: number;
  widgetDismissedAt?: number;
  runs: RaftActivityRun[];
  main: RaftUiMain;
  agents: RaftUiAgent[];
  componentGraph: RaftComponentGraph;
  state: RaftUiStateEntry[];
}

export const activeStatuses = new Set([
  "queued",
  "pending",
  "ready",
  "claimed",
  "running",
  "in_progress",
  "blocked",
  "loading",
  "active",
  "unloading",
]);
export const isActiveStatus = (status: string): boolean => activeStatuses.has(status);
export const orderAgentsByCreation = (agents: RaftUiAgent[]): RaftUiAgent[] =>
  agents
    .map((agent, index) => ({ agent, index }))
    .sort(
      (left, right) =>
        (left.agent.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.agent.startedAt ?? Number.MAX_SAFE_INTEGER) || left.index - right.index,
    )
    .map(({ agent }) => agent);
