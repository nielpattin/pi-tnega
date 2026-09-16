import type { AgentWorkerOptions } from "../agents/types.js";

const argumentMap = (argv: readonly string[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid worker argument near ${key ?? "<end>"}`);
    }
    result.set(key.slice(2), value);
  }
  return result;
};

const required = (args: Map<string, string>, name: string): string => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing worker argument: --${name}`);
  return value;
};

const optional = (args: Map<string, string>, name: string): string | undefined =>
  args.get(name) || undefined;

export const parseWorkerOptions = (argv: readonly string[] = process.argv): AgentWorkerOptions => {
  const args = argumentMap(argv);
  const model = optional(args, "model");
  const thinking = optional(args, "thinking");
  const raftExtensionPath = optional(args, "raft-extension");
  const schemaFile = optional(args, "schema-file");
  const imagesFile = optional(args, "images-file");
  const systemPrompt = optional(args, "system-prompt");
  const sessionFile = optional(args, "session-file");
  const sessionExportFile = optional(args, "session-export-file");
  const capabilityRequirementsSource = optional(args, "capability-requirements");
  const capabilityDigest = optional(args, "capability-digest");
  const capabilityRequirements = capabilityRequirementsSource
    ? (JSON.parse(capabilityRequirementsSource) as unknown)
    : undefined;
  if (
    capabilityRequirements !== undefined &&
    (!Array.isArray(capabilityRequirements) ||
      capabilityRequirements.length > 128 ||
      capabilityRequirements.some(
        (ref) => typeof ref !== "string" || ref.length > 256 || !ref.includes("."),
      ))
  ) {
    throw new Error("Invalid worker capability requirements");
  }
  const projectRoot = optional(args, "project-root");
  const runRoot = optional(args, "run-root");
  const steerFile = optional(args, "steer-file");
  const branch = optional(args, "branch");
  const worktree = optional(args, "worktree");
  const maxTokens = optional(args, "max-tokens");
  const runnerSessionId = optional(args, "runner-session-id");
  const mainAgentId = optional(args, "main-agent-id");
  const raftSessionId = optional(args, "raft-session-id");
  const toolAllowlistSource = optional(args, "tool-allowlist");
  const toolAllowlist = toolAllowlistSource
    ? (JSON.parse(toolAllowlistSource) as string[])
    : undefined;
  const runner = required(args, "runner");
  if (runner !== "pi" && runner !== "claude") {
    throw new Error(`Unsupported Raft agent runner: ${runner}`);
  }
  const extensions = required(args, "extensions") === "true";
  const selectedKernel = args.get("kernel");
  const pythonRuntime = args.get("python-runtime") ?? "monty";
  if (pythonRuntime !== "cpython" && pythonRuntime !== "monty") {
    throw new Error(`Invalid worker Python runtime: ${pythonRuntime}`);
  }
  if (
    selectedKernel !== undefined &&
    selectedKernel !== "typescript" &&
    selectedKernel !== "python"
  ) {
    throw new Error(`Invalid worker kernel: ${selectedKernel}`);
  }
  if (selectedKernel !== undefined && (runner !== "pi" || !extensions)) {
    throw new Error("Explicit worker kernel requires the Pi runner with Raft extensions enabled");
  }
  // Old launchers had no flag and always used TypeScript, regardless of ambient env.
  const kernel = runner === "pi" && extensions ? (selectedKernel ?? "typescript") : undefined;
  return {
    id: required(args, "id"),
    runner,
    ...(kernel ? { kernel, pythonRuntime } : {}),
    name: required(args, "name"),
    taskFile: required(args, "task-file"),
    ...(imagesFile ? { imagesFile } : {}),
    statusFile: required(args, "status-file"),
    logFile: required(args, "log-file"),
    ...(schemaFile ? { schemaFile } : {}),
    cwd: required(args, "cwd"),
    piBinary: required(args, "pi-binary"),
    claudeBinary: required(args, "claude-binary"),
    timeoutMs: Number(required(args, "timeout-ms")),
    depth: Number(required(args, "depth")),
    ...(mainAgentId ? { mainAgentId } : {}),
    ...(raftSessionId ? { raftSessionId } : {}),
    extensions,
    tools: JSON.parse(required(args, "tools")) as string[],
    ...(toolAllowlist ? { toolAllowlist } : {}),
    grantedRisks: JSON.parse(required(args, "granted-risks")) as string[],
    transport: required(args, "transport") as AgentWorkerOptions["transport"],
    ...(raftExtensionPath ? { raftExtensionPath } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionExportFile ? { sessionExportFile } : {}),
    ...(capabilityRequirements
      ? { capabilityRequirements: [...new Set(capabilityRequirements as string[])] }
      : {}),
    ...(capabilityDigest ? { capabilityDigest } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(runnerSessionId ? { runnerSessionId } : {}),
    ...(runRoot ? { runRoot } : {}),
    ...(steerFile ? { steerFile } : {}),
    ...(branch ? { branch } : {}),
    ...(worktree ? { worktree } : {}),
    ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
  };
};
