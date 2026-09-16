import type {
  RaftActionDescriptor,
  RaftInvocationContext,
  RaftProvider,
  RaftProviderListRequest,
} from "../protocol.js";
import { effectiveAgentTimeoutMs, AgentManager } from "../agents/manager.js";
import type { AgentHandleInfo, AgentRunRequest } from "../agents/types.js";
import { DEFAULT_RAFT_CONFIG, type RaftAgentRunner, type RaftModelsConfig } from "../config.js";
import { resolveAvailablePiModel, type RaftModelCandidate } from "../core/model-resolution.js";
import { loadModelUsage } from "../core/model-usage.js";
import { AGENTS_ACTION_DESCRIPTORS } from "./agents-actions.js";
import { actionArgNormalizer } from "./arg-normalization.js";
import { stringifyUnknown } from "../util.js";
import { normalizeAgentRunRequest } from "../agents/request.js";
import { AgentTranscriptReader } from "../ui/transcript.js";
import { waitWithProgress } from "./agents-progress.js";

export {
  collectAgentToolPreviewNodes,
  type AgentToolPreviewTreeOptions,
} from "./agents-progress.js";

const MAX_ACTIVITY_CWD_CHARS = 240;

const displaySafeCwd = (cwd: string): string => {
  const safe = cwd.replace(
    /[\u0000-\u001f\u007f]/g,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
  if (safe.length <= MAX_ACTIVITY_CWD_CHARS) return safe;
  return `…${safe.slice(-(MAX_ACTIVITY_CWD_CHARS - 1))}`;
};

const agentStartedMessage = (handle: AgentHandleInfo): string =>
  `Agent ${handle.name} started via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""} · cwd ${displaySafeCwd(handle.cwd)}`;

const longerTimeoutOverride = (value: unknown, manager: AgentManager): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const effective = effectiveAgentTimeoutMs(manager.config.timeoutMs, value);
  return effective > manager.config.timeoutMs ? effective : undefined;
};

const checkedKernel = (value: unknown): AgentRunRequest["kernel"] => {
  if (value === undefined || value === "inherit" || value === "typescript" || value === "python")
    return value;
  throw new Error(`Invalid Raft agent kernel: ${stringifyUnknown(value)}`);
};

const runRequest = (
  args: Record<string, unknown>,
  context: RaftInvocationContext,
  manager: AgentManager,
  options: { allowCwd?: boolean } = {},
): AgentRunRequest =>
  normalizeAgentRunRequest(
    { ...args, timeoutMs: longerTimeoutOverride(args.timeoutMs, manager) },
    {
      ...manager.config,
      ...(context.extensionContext.model ? { inheritedModel: context.extensionContext.model } : {}),
    },
    options,
  );

export const normalizeAgentsArgs = actionArgNormalizer(() => AGENTS_ACTION_DESCRIPTORS);

export class AgentsProvider implements RaftProvider {
  readonly #transcripts = new AgentTranscriptReader();
  readonly name = "agents";
  readonly description =
    "One-shot Pi or Claude Code agents over process, tmux, screen, LocalTerm, or Herdr";

  constructor(
    readonly manager: AgentManager,
    readonly agentToolPreviewEnabled: () => boolean = () => true,
    readonly modelsConfig: () => RaftModelsConfig = () => DEFAULT_RAFT_CONFIG.models,
  ) {}

  /** Resolve a Pi participant selector only within this session's visible registry. */
  #resolvePiModel(model: string, context: RaftInvocationContext): string {
    let available: RaftModelCandidate[] = [];
    try {
      available = context.extensionContext.modelRegistry
        .getAvailable()
        .map((candidate) => ({
          provider: String(candidate.provider),
          id: String(candidate.id),
          ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
        }));
    } catch {
      // The authoritative visible set is empty when registry discovery fails.
    }
    const resolved = resolveAvailablePiModel(model, {
      aliases: this.modelsConfig().aliases,
      available,
      lastUsed: loadModelUsage(),
    });
    return `${resolved.provider}/${resolved.id}`;
  }

  #resolvePiModelArgs(
    args: Record<string, unknown>,
    context: RaftInvocationContext,
    runnerOverride?: RaftAgentRunner,
  ): Record<string, unknown> {
    const runner =
      runnerOverride ??
      (args.runner === "pi" || args.runner === "claude" ? args.runner : this.manager.config.runner);
    if (runner !== "pi") return args;
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!model) return args;
    const resolved = this.#resolvePiModel(model, context);
    return resolved === model ? args : { ...args, model: resolved };
  }

  async list(
    request: RaftProviderListRequest,
    _context: RaftInvocationContext,
  ): Promise<RaftActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? AGENTS_ACTION_DESCRIPTORS.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : AGENTS_ACTION_DESCRIPTORS;
  }

  async describe(
    actionName: string,
    _context: RaftInvocationContext,
  ): Promise<RaftActionDescriptor | undefined> {
    return AGENTS_ACTION_DESCRIPTORS.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    return normalizeAgentsArgs(actionName, args);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: RaftInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "run": {
        const handle = await this.manager.spawn(
          runRequest(this.#resolvePiModelArgs(args, context), context, this.manager),
          context.signal,
        );
        context.activity?.({ type: "entity", id: handle.id, kind: "agent", name: handle.name });
        context.update(agentStartedMessage(handle));
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          handle.id,
          context,
          this.agentToolPreviewEnabled,
        );
      }
      case "spawn": {
        const request = runRequest(this.#resolvePiModelArgs(args, context), context, this.manager);
        const kernel = this.manager.resolveKernel(request);
        const { kernel: _requestedKernel, ...baseRequest } = request;
        const spawnRequest = {
          ...baseRequest,
          ...(kernel ? { kernel, pythonRuntime: this.manager.resolvePythonRuntime() } : {}),
          extensions: request.extensions ?? this.manager.config.extensions,
        };
        const handle = await this.manager.spawn(spawnRequest, context.signal);
        this.manager.detachSignal(handle.id);
        context.activity?.({ type: "entity", id: handle.id, kind: "agent", name: handle.name });
        context.update(agentStartedMessage(handle));
        return { ...handle, awaitWith: `agents.wait({ id: "${handle.id}" })` };
      }
      case "wait": {
        const id = String(args.id);
        const status = this.manager.status(id);
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          id,
          context,
          this.agentToolPreviewEnabled,
        );
      }
      case "status": {
        const id = String(args.id);
        return this.manager.status(id);
      }
      case "list":
        return this.manager.list();
      case "stop":
        return this.manager.stop(String(args.id));
      case "log": {
        const id = String(args.id);
        const lines = typeof args.lines === "number" ? args.lines : 200;
        const before = typeof args.before === "number" ? args.before : undefined;
        return this.manager.readLog(id, { lines, ...(before !== undefined ? { before } : {}) });
      }
      default:
        throw new Error(`Unknown agents action: ${actionName}`);
    }
  }

  async close(): Promise<void> {
    this.#transcripts.clear();
    await this.manager.close();
  }
}
