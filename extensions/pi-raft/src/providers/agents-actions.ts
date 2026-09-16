import type { RaftActionDescriptor } from "../protocol.js";

const runProperties = {
  task: { type: "string", description: "A self-contained task for the child agent" },
  name: {
    type: "string",
    description:
      'Short label for this agent, shown in agent status, listings, and the dashboard. Write 2-5 words naming what the agent works on, e.g. "settings refactor" or "flaky test triage".',
  },
  runner: {
    type: "string",
    enum: ["pi", "claude"],
    description: "Execution harness. Defaults to agents.runner.",
  },
  kernel: {
    type: "string",
    enum: ["typescript", "python", "inherit"],
    description:
      "Raft execution language. Omitted/inherit uses the caller executor.kernel; concrete choices require Pi with extensions enabled. Python uses the configured backend; CPython is native execution.",
  },
  transport: { type: "string", enum: ["auto", "process", "tmux", "screen", "localterm", "herdr"] },
  model: {
    type: "string",
    description:
      "Pi provider/id, a configured models.aliases name, or a search term resolved to the closest authenticated model (recency from pi-model-sort breaks ties); Claude runtime value is forwarded verbatim.",
  },
  thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  tools: { type: "array", items: { type: "string" } },
  timeoutMs: {
    type: "number",
    description:
      "Optional longer wall-clock limit in milliseconds. Omit to use agents.timeoutMs (60 minutes by default); values below the configured default are ignored.",
  },
  extensions: { type: "boolean" },
  recursive: { type: "boolean" },
  cwd: {
    type: "string",
    description:
      "Filesystem execution directory for leaf or recursive Pi runs; relative paths resolve from the caller cwd. Does not change project/mesh ownership or grant target project trust.",
  },
  worktree: { type: "boolean" },
  schema: { type: "object", description: "Optional JSON Schema for validated structured output" },
};

const runSchema = {
  type: "object",
  properties: runProperties,
  required: ["task"],
  additionalProperties: false,
};

const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};
const agentHandleProperties = {
  id: { type: "string", description: "Run id; the argument for agents.wait/status/stop/log." },
  name: { type: "string" },
  status: {
    type: "string",
    enum: ["queued", "running", "paused", "completed", "failed", "stopped", "timed_out"],
  },
  runner: { type: "string", enum: ["pi", "claude"] },
  kernel: { type: "string", enum: ["typescript", "python"] },
  transport: { type: "string" },
  cwd: { type: "string" },
  model: { type: "string" },
  sessionId: { type: "string" },
  attachCommand: { type: "string" },
};

// Describe is the only place a program can learn what an action hands back, so
// every agents action states its result contract instead of leaving the caller
// to guess field names from the description prose.
const agentHandleOutput: Record<string, unknown> = {
  type: "object",
  description:
    "The run handle. `id` addresses the run for agents.wait/status/stop/log; the remaining fields are launch metadata.",
  properties: agentHandleProperties,
  required: ["id", "name", "status", "runner"],
};

const agentResultOutput: Record<string, unknown> = {
  type: "object",
  description:
    "The settled run. `status` is the terminal state, `text` the bounded final answer, and `value` the schema-validated result when the request declared a schema.",
  properties: {
    ...agentHandleProperties,
    task: { type: "string" },
    text: { type: "string" },
    value: { description: "Present only when the request declared a schema." },
    error: { type: "string" },
    turns: { type: "number" },
    toolCalls: { type: "number" },
    startedAt: { type: "number" },
    updatedAt: { type: "number" },
    finishedAt: { type: "number" },
    usage: {
      type: "object",
      properties: {
        input: { type: "number" },
        output: { type: "number" },
        cacheRead: { type: "number" },
        cacheWrite: { type: "number" },
        cost: { type: "number" },
      },
    },
  },
  required: ["id", "name", "status", "text"],
};

const spawnOutput: Record<string, unknown> = {
  ...agentHandleOutput,
  description:
    "The run handle plus `awaitWith`, the exact agents.wait call that waits for this run. Pass `id` to agents.status/stop/log.",
  properties: {
    ...agentHandleProperties,
    awaitWith: { type: "string", description: "Ready-made agents.wait call for this run." },
  },
  required: ["id", "name", "status", "runner", "awaitWith"],
};

const agentListOutput: Record<string, unknown> = {
  type: "array",
  items: agentHandleOutput,
  description: "Local runs known to this session, settled ones included.",
};

const agentLogOutput: Record<string, unknown> = {
  type: "object",
  description: "A bounded page of the run's event stream; `hasMore` marks older pages.",
  properties: {
    id: { type: "string" },
    runDirectory: { type: "string" },
    logFile: { type: "string" },
    status: agentResultOutput,
    events: { type: "array", items: { type: "object" } },
    hasMore: { type: "boolean" },
    before: { type: "number" },
  },
  required: ["id", "logFile", "events", "hasMore"],
};

export const AGENTS_ACTION_DESCRIPTORS: RaftActionDescriptor[] = [
  {
    name: "run",
    description: "Run a child agent through Pi or Claude Code and wait for its final result",
    inputSchema: runSchema,
    outputSchema: agentResultOutput,
    risk: "agent",
  },
  {
    name: "spawn",
    description:
      "Start a child agent through Pi or Claude Code and return a handle immediately. Detached runs send Main a follow-up on terminal completion when agents.notifyOnComplete is enabled; use wait when this Raft program needs the result and status only for progress inspection.",
    inputSchema: runSchema,
    outputSchema: spawnOutput,
    risk: "agent",
  },
  {
    name: "wait",
    description:
      "Wait for a previously spawned child agent. Pass the `id` from an agents.spawn handle (or call its `awaitWith`), agents.status, or agents.list.",
    inputSchema: idSchema,
    outputSchema: agentResultOutput,
    risk: "read",
  },
  {
    name: "status",
    description: "Get the latest status of a local child agent by id.",
    inputSchema: idSchema,
    outputSchema: agentHandleOutput,
    risk: "read",
  },
  {
    name: "list",
    description: "List local child agents",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: agentListOutput,
    risk: "read",
  },
  {
    name: "stop",
    description: "Stop a running local child agent",
    inputSchema: idSchema,
    outputSchema: agentResultOutput,
    risk: "agent",
  },
  {
    name: "log",
    description:
      "Read an agent run's LLM/agent event stream (events.jsonl: tool calls, model responses, usage)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent run ID" },
        lines: { type: "number", minimum: 1, description: "Page line limit (default 200)" },
        before: {
          type: "number",
          minimum: 0,
          description: "Exclusive line cursor returned by a previous page to load older entries",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: agentLogOutput,
    risk: "read",
  },
];
