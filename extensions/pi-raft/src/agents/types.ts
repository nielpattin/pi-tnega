import type { ImageContent } from "@earendil-works/pi-ai";
import type { RaftAgentRunner, RaftAgentTransport, RaftPythonRuntime } from "../config.js";
import type { RaftKernel } from "../runtime/kernel.js";
import type { RaftThinking } from "../thinking.js";

export interface AgentRunRequest {
  task: string;
  images?: ImageContent[];
  name?: string;
  runner?: RaftAgentRunner;
  /** Omitted/inherit uses the caller kernel; concrete kernels require Pi with Raft extensions. */
  kernel?: RaftKernel | "inherit";
  pythonRuntime?: RaftPythonRuntime;
  transport?: RaftAgentTransport;
  model?: string;
  thinking?: RaftThinking;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  /** Leaf or recursive execution cwd; relative to the immediate caller, independent of project/mesh lineage. */
  cwd?: string;
  worktree?: boolean;
  schema?: Record<string, unknown>;
  systemPrompt?: string;
  sessionFile?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  runnerSessionId?: string;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface RaftBudgetSummary {
  limit: number;
  spent: number;
  remaining: number;
  tokens: number;
}

export interface AgentCompactionStatus {
  status: "queued" | "in_flight" | "completed" | "failed";
  requestedAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  coalescedRequests: number;
  queued?: boolean;
  error?: string;
}

export interface AgentRunRecord {
  /** Requested launch model; model below follows verified state/assistant attribution. */
  requestedModel?: string;
  id: string;
  name: string;
  task: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "stopped" | "timed_out";
  runner: RaftAgentRunner;
  /** Resolved Raft kernel; absent for runners without Raft. */
  kernel?: RaftKernel;
  transport: RaftAgentTransport;
  cwd: string;
  model?: string;
  thinking?: RaftThinking;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  recursive?: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  currentTool?: string;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  usage: AgentUsage;
  budget?: RaftBudgetSummary;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  logFile?: string;
  nestedAgents?: AgentRunRecord[];
  pendingMessages?: { steering: string[]; followUp: string[] };
  compaction?: AgentCompactionStatus;
}

export interface AgentRunResult extends AgentRunRecord {
  status: "completed" | "failed" | "stopped" | "timed_out";
}

export interface AgentHandleInfo {
  id: string;
  name: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "stopped" | "timed_out";
  runner: RaftAgentRunner;
  /** Resolved Raft kernel; absent for runners without Raft. */
  kernel?: RaftKernel;
  transport: RaftAgentTransport;
  cwd: string;
  model?: string;
  thinking?: RaftThinking;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  recursive?: boolean;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface AgentWorkerOptions {
  id: string;
  runner: RaftAgentRunner;
  kernel?: RaftKernel;
  pythonRuntime?: RaftPythonRuntime;
  name: string;
  taskFile: string;
  imagesFile?: string;
  statusFile: string;
  logFile: string;
  schemaFile?: string;
  cwd: string;
  piBinary: string;
  claudeBinary: string;
  timeoutMs: number;
  depth: number;
  mainAgentId?: string;
  raftSessionId?: string;
  extensions: boolean;
  tools: string[];
  toolAllowlist?: string[];
  grantedRisks: string[];
  maxTokens?: number;
  raftExtensionPath?: string;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  sessionFile?: string;
  sessionExportFile?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  projectRoot?: string;
  runnerSessionId?: string;
  runRoot?: string;
  steerFile?: string;
  transport: RaftAgentTransport;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface AgentTransportLaunch {
  id: string;
  name: string;
  cwd: string;
  workerPath: string;
  workerArguments: string[];
}

export interface AgentTransportHandle {
  kind: RaftAgentTransport;
  sessionId?: string;
  attachCommand?: string;
  livenessPollIntervalMs?: number;
  isAlive(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface AgentTransportAdapter {
  kind: RaftAgentTransport;
  available(): Promise<boolean>;
  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle>;
}

export interface RaftLogLine {
  /** Legacy absolute line index; newer paged readers expose byte offset instead. */
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}

export interface RaftAgentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: AgentRunRecord;
  events: RaftLogLine[];
  hasMore: boolean;
  before?: number;
}

export type RaftSteeringMode = "all" | "one-at-a-time";

export interface AgentSteerEntry {
  type: "steer" | "follow_up" | "set_steering_mode" | "set_follow_up_mode" | "compact";
  id: string;
  message?: string;
  mode?: RaftSteeringMode;
  instructions?: string;
  data?: unknown;
  ts: number;
}

export interface AgentSteerResult {
  queued: true;
  messageId: string;
}
