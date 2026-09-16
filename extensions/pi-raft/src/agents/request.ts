import type { AgentRunRequest } from "./types.js";
import { isRaftThinking } from "../thinking.js";
import { stringifyUnknown } from "../util.js";

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
const checkedKernel = (value: unknown): AgentRunRequest["kernel"] => {
  if (value === undefined || value === "inherit" || value === "typescript" || value === "python")
    return value;
  throw new Error(`Invalid Raft agent kernel: ${stringifyUnknown(value)}`);
};

export const normalizeAgentRunRequest = (
  args: Record<string, unknown>,
  defaults: {
    runner: NonNullable<AgentRunRequest["runner"]>;
    model?: string;
    timeoutMs: number;
    inheritedModel?: { provider: string; id: string };
  },
  options: { allowCwd?: boolean } = {},
): AgentRunRequest => {
  const transport =
    args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm" ||
    args.transport === "herdr"
      ? args.transport
      : undefined;
  const thinking = isRaftThinking(args.thinking) ? args.thinking : undefined;
  const tools = stringArray(args.tools);
  const timeoutMs =
    typeof args.timeoutMs === "number" &&
    Number.isFinite(args.timeoutMs) &&
    args.timeoutMs > defaults.timeoutMs
      ? args.timeoutMs
      : undefined;
  if (args.runner !== undefined && args.runner !== "pi" && args.runner !== "claude") {
    throw new Error(`Unsupported Raft agent runner: ${stringifyUnknown(args.runner)}`);
  }
  const runner = args.runner ?? defaults.runner;
  const inheritedModel =
    runner === "pi" && !defaults.model && defaults.inheritedModel
      ? `${defaults.inheritedModel.provider}/${defaults.inheritedModel.id}`
      : undefined;
  const kernel = checkedKernel(args.kernel);
  if (args.recursive === true && args.extensions === false) {
    throw new Error(
      "Recursive Raft requires extensions enabled; omit recursive or extensions: false",
    );
  }
  return {
    task: String(args.task),
    runner,
    ...(kernel !== undefined ? { kernel } : {}),
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(transport ? { transport } : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : inheritedModel
        ? { model: inheritedModel }
        : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean"
      ? { extensions: args.extensions }
      : args.recursive === true
        ? { extensions: true }
        : {}),
    ...(typeof args.recursive === "boolean" ? { recursive: args.recursive } : {}),
    ...(options.allowCwd !== false && typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
    ...(typeof args.schema === "object" && args.schema !== null && !Array.isArray(args.schema)
      ? { schema: args.schema as Record<string, unknown> }
      : {}),
  };
};
