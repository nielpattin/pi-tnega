type RaftRunStatus = "running" | "completed" | "failed" | "cancelled";
export type RaftActivityStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

export type RaftActivityKind = "agent" | "tool" | "extension" | "mcp" | "task" | "custom";

export interface RaftRunDisplay {
  name?: string;
  description?: string;
}

export interface RaftPhaseInput {
  name: string;
  id?: string;
  description?: string;
  total?: number;
}

export interface RaftActivityItemInput {
  id: string;
  label: string;
  status?: RaftActivityStatus;
  phase?: string;
  detail?: string;
  kind?: RaftActivityKind;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
}

export interface RaftActivityEventInput {
  message: string;
  level?: "info" | "success" | "warning" | "error";
  data?: unknown;
}

export interface RaftActivityPhase {
  id: string;
  name: string;
  description?: string;
  status: RaftActivityStatus;
  total?: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface RaftActivityMetrics {
  tokens?: number;
  toolCalls?: number;
  cost?: number;
}

export interface RaftActivityCall {
  id: string;
  ref: string;
  label: string;
  kind: RaftActivityKind;
  status: RaftActivityStatus;
  phaseId?: string;
  entityId?: string;
  entityKind?: RaftActivityKind;
  args?: Record<string, unknown>;
  result?: unknown;
  preview?: unknown;
  progress?: string;
  error?: string;
  detail?: string;
  metrics?: RaftActivityMetrics;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface RaftActivityItem {
  id: string;
  label: string;
  status: RaftActivityStatus;
  kind: RaftActivityKind;
  phaseId?: string;
  detail?: string;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

interface RaftActivityEvent {
  id: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
  data?: unknown;
  createdAt: number;
}

export interface RaftActivityRun {
  id: string;
  name: string;
  description?: string;
  status: RaftRunStatus;
  phases: RaftActivityPhase[];
  calls: RaftActivityCall[];
  items: RaftActivityItem[];
  events: RaftActivityEvent[];
  currentPhaseId?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
}
