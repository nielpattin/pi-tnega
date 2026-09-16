import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./core/agent-dir.js";
import { resolveAvailablePiModel, type RaftModelCandidate } from "./core/model-resolution.js";
import { loadModelUsage } from "./core/model-usage.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { RaftActivityStore } from "./activity/store.js";
import { RaftComponentCatalog } from "./components/catalog.js";
import { RaftComponentLoader } from "./components/loader.js";
import {
  resolveRaftModelGuidance,
  type RaftOwnedModelGuidance,
} from "./components/model-guidance.js";
import { RaftComponentSupervisor } from "./components/supervisor.js";
import {
  createProviderComponent,
  RAFT_COMPONENT_PROVIDER_NAMES,
  RAFT_PROVIDER_COMPONENT_PREFIX,
  RaftProviderComponentManifest,
} from "./components/provider-component.js";
import type { RaftComponentDefinition, RaftComponentGraph } from "./components/types.js";
import { DEFAULT_RAFT_CONFIG, loadRaftConfig, type RaftConfig } from "./config.js";
import { ActionRegistry, type RaftCapabilityViewLease } from "./core/action-registry.js";
import { RaftSessionApprovals } from "./core/approval-controller.js";
import { CompactController } from "./core/compact-controller.js";
import { RaftToolResultProxy } from "./core/tool-result-proxy.js";
import { observeHostExtensionRunner, registeredToolNames } from "./core/host-extension-runner.js";
import { RaftExecutionService } from "./execution-service.js";
import { RuntimeStateSpeculation } from "./runtime-state-speculation.js";
import type { RaftSpeculationStreamTap } from "./speculation/stream-tap.js";
import { MainAgentController, resolveRaftIdentity, type RaftMainAgentInfo } from "./main-agent.js";
import { AgentsProvider } from "./providers/agents-provider.js";
import type { McpProviderHooks } from "./providers/mcp-provider.js";
import { RuntimeStateBuiltins } from "./runtime-state-builtins.js";
import {
  RAFT_COMPONENT_DISCOVER_EVENT,
  type RaftActionDescriptor,
  type RaftComponentDiscovery,
} from "./protocol.js";
import { AgentManager } from "./agents/manager.js";
import type { RaftRuntimePaths } from "./runtime-paths.js";

const BACKGROUND_COMPLETION_MAX_CHARS = 8_000;
const inheritedCapabilityRequirements = (): string[] => {
  const source = process.env.PI_RAFT_CAPABILITY_REQUIREMENTS;
  if (!source) return [];
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.length > 128) {
    throw new Error("PI_RAFT_CAPABILITY_REQUIREMENTS must be an array of at most 128 refs");
  }
  const refs = parsed.filter((value): value is string => typeof value === "string");
  if (refs.length !== parsed.length || refs.some((ref) => ref.length > 256 || !ref.includes("."))) {
    throw new Error("PI_RAFT_CAPABILITY_REQUIREMENTS contains an invalid provider.action ref");
  }
  return [...new Set(refs)];
};

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export interface RaftRuntimeStateOptions {
  activity?: RaftActivityStore;
  sessionApprovals?: RaftSessionApprovals;
  paths?: RaftRuntimePaths;
}

export class RaftRuntimeState {
  #registry: ActionRegistry | undefined;
  #config: RaftConfig | undefined;
  #execution: RaftExecutionService | undefined;
  #speculation: RuntimeStateSpeculation | undefined;
  #agents: AgentManager | undefined;
  #mainAgent: MainAgentController | undefined;
  #compact: CompactController | undefined;
  #componentSupervisor: RaftComponentSupervisor | undefined;
  #componentLoader: RaftComponentLoader | undefined;
  #builtins: RuntimeStateBuiltins | undefined;
  #sessionCapabilityLease: RaftCapabilityViewLease | undefined;
  #unsubscribeCapturedCatalog: (() => void) | undefined;
  #cwd: string | undefined;
  readonly #builtinComponentNames = new Set<string>();
  readonly componentCatalog = new RaftComponentCatalog();
  readonly activity: RaftActivityStore;
  readonly sessionApprovals: RaftSessionApprovals;
  readonly #paths: RaftRuntimePaths | undefined;
  #widgetDismissedAt = 0;

  constructor(
    readonly pi: ExtensionAPI,
    options: RaftRuntimeStateOptions = {},
  ) {
    this.activity = options.activity ?? new RaftActivityStore();
    this.sessionApprovals = options.sessionApprovals ?? new RaftSessionApprovals();
    this.#paths = options.paths;
  }

  get initialized(): boolean {
    return Boolean(this.#execution);
  }

  get widgetDismissedAt(): number {
    return this.#widgetDismissedAt;
  }

  set widgetDismissedAt(value: number) {
    this.#widgetDismissedAt = value;
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  get config(): RaftConfig {
    if (!this.#config) throw new Error("Pi Raft has not initialized");
    return this.#config;
  }

  /** Stream tap for speculative PTC; undefined when speculation is disabled. */
  get speculationTap(): RaftSpeculationStreamTap | undefined {
    return this.#speculation?.tap;
  }

  /** Turn-boundary backstop: tap state and unserved entries never outlive a turn. */
  resetSpeculation(): void {
    this.#speculation?.reset();
  }

  get registry(): ActionRegistry {
    if (!this.#registry) throw new Error("Pi Raft has not initialized");
    return this.#registry;
  }

  get components(): RaftComponentLoader {
    if (!this.#componentLoader) throw new Error("Pi Raft has not initialized");
    return this.#componentLoader;
  }

  get execution(): RaftExecutionService {
    if (!this.#execution) throw new Error("Pi Raft has not initialized");
    return this.#execution;
  }

  get agents(): AgentManager {
    if (!this.#agents) throw new Error("Pi Raft has not initialized");
    return this.#agents;
  }

  mainAgentInfo(context?: ExtensionContext): RaftMainAgentInfo {
    if (!this.#mainAgent) throw new Error("Pi Raft has not initialized");
    return this.#mainAgent.info(context);
  }

  componentGraph(): RaftComponentGraph {
    return this.#componentLoader?.graph() ?? { components: [], edges: [], cycles: [] };
  }

  modelGuidance(): RaftOwnedModelGuidance[] {
    return this.#componentSupervisor?.guidance() ?? [];
  }

  async stopParticipant(targetId: string): Promise<unknown> {
    if (!this.#agents) throw new Error("Pi Raft has not initialized");
    return this.#agents.stop(targetId);
  }
  get compact(): CompactController {
    if (!this.#compact) throw new Error("Pi Raft has not initialized");
    return this.#compact;
  }

  async initialize(context: ExtensionContext, bootstrapConfig?: RaftConfig): Promise<void> {
    await this.#closeInternal();
    for (const name of this.#builtinComponentNames) this.componentCatalog.unregister(name);
    this.#builtinComponentNames.clear();
    this.#speculation = undefined;
    this.activity.reset();
    this.sessionApprovals.approvedRisks.clear();
    this.#cwd = context.cwd;
    const projectTrusted = context.isProjectTrusted();
    this.#config =
      bootstrapConfig ??
      loadRaftConfig({ cwd: context.cwd, agentDir: resolveAgentDir(), projectTrusted });
    const hostRunner = await observeHostExtensionRunner();
    this.#registry = new ActionRegistry(new RaftToolResultProxy(hostRunner.current));
    this.#registry.setRiskOverrides(this.#config.safety.toolRisks);
    this.#configureSpeculation();
    this.#componentSupervisor = new RaftComponentSupervisor(this.#registry, {
      invocationContext: () => ({
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "raft-component",
        nestedToolCallId: "raft-component",
        extensionContext: context,
        update() {},
      }),
      maxResultChars: this.#config.execution.executor.maxNestedResultChars,
      acquire: async (ref, args, invocation) => {
        const action = await this.#registry!.describe(ref, invocation);
        return this.#registry!.acquireScoped(ref, args, invocation);
      },
      invoke: (ref, args, invocation) =>
        this.#registry!.invoke(ref, args, {
          ...invocation,
          approve: async () => {},
          audits: [],
          maxResultChars: this.#config!.execution.executor.maxNestedResultChars,
        }),
    });
    this.#componentLoader = new RaftComponentLoader(
      this.componentCatalog,
      this.#componentSupervisor,
    );
    const builtinManifest = new RaftProviderComponentManifest(
      this.componentCatalog,
      this.#componentLoader,
    );
    const builtins = new RuntimeStateBuiltins(builtinManifest, this.#registry, (name) =>
      this.#builtinComponentNames.add(name),
    );
    this.#builtins = builtins;
    await builtins.tools(context.cwd, this.#config);
    const sessionId = context.sessionManager.getSessionId();
    const { identity, mainAgentId } = resolveRaftIdentity(sessionId);
    const raftSessionId = process.env.PI_RAFT_SESSION_ID?.trim() || sessionId;
    const mainAgent = new MainAgentController(
      this.pi,
      mainAgentId,
      identity.kind === "main" && identity.id === mainAgentId,
      context.cwd,
      identity.kind === "main" ? sessionId : undefined,
    );
    this.#mainAgent = mainAgent;
    const projectRoot = process.env.PI_RAFT_PROJECT_ROOT ?? context.cwd;
    this.#compact = new CompactController();
    const agentConfig = this.#config.agents;
    const modelsConfig = this.#config.models;
    const visiblePiModels = () => {
      try {
        return context.modelRegistry.getAvailable();
      } catch {
        return [];
      }
    };
    const piModelState = (models = visiblePiModels()) => {
      const available: RaftModelCandidate[] = models.map((model) => ({
        provider: String(model.provider),
        id: String(model.id),
        ...(typeof model.name === "string" ? { name: model.name } : {}),
      }));
      const defaultModel = context.model
        ? `${context.model.provider}/${context.model.id}`
        : undefined;
      return {
        available,
        aliases: structuredClone(modelsConfig.aliases),
        ...(defaultModel ? { defaultModel } : {}),
      };
    };
    const resolveParticipantPiModel = (selector?: string) => {
      const models = visiblePiModels();
      const state = piModelState(models);
      const query = selector?.trim() || state.defaultModel || "";
      const resolved = resolveAvailablePiModel(query, {
        aliases: state.aliases,
        available: state.available,
        lastUsed: loadModelUsage(),
      });
      const model = models.find(
        (candidate) =>
          String(candidate.provider).toLowerCase() === resolved.provider.toLowerCase() &&
          String(candidate.id).toLowerCase() === resolved.id.toLowerCase(),
      );
      if (!model) {
        throw new Error(
          `Model ${JSON.stringify(query)} is not available to this Pi session. ` +
            "Choose a configured provider/model visible to this Pi session, or inspect Pi's model selector.",
        );
      }
      return { key: `${resolved.provider}/${resolved.id}`, model };
    };
    this.#agents = new AgentManager(context.cwd, agentConfig, {
      kernel: () => this.#config?.execution.executor.kernel ?? "typescript",
      pythonRuntime: () => this.#config?.execution.executor.pythonRuntime ?? "monty",
      projectRoot,
      listExtensionTools: () => registeredToolNames(hostRunner.current()),
      retention: this.#config.lifecycle.retention,
      ...(this.#paths
        ? { workerPath: this.#paths.worker, raftExtensionPath: this.#paths.extension }
        : {}),
      resolveParticipantGuidance: ({ model, runner }) => {
        const targetModel =
          model ??
          (runner === "pi" && context.model
            ? `${context.model.provider}/${context.model.id}`
            : undefined);
        if (!targetModel) return undefined;
        return (
          resolveRaftModelGuidance(this.modelGuidance(), {
            model: targetModel,
            target: "participant",
            includeSlots: false,
          }).appendText || undefined
        );
      },
      preparePiModel: async (modelKey) => {
        const resolved = resolveParticipantPiModel(modelKey);
        const auth = await context.modelRegistry.getApiKeyAndHeaders(resolved.model);
        if (!auth.ok) throw new Error(auth.error);
        return resolved.key;
      },
      onBackgroundComplete: (result) => {
        const durationMs = Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt);
        const duration =
          durationMs < 60_000
            ? `${Math.round(durationMs / 1_000)}s`
            : `${(durationMs / 60_000).toFixed(1)}m`;
        const summary = result.text || result.error || "no result";
        const clippedSummary =
          summary.length > BACKGROUND_COMPLETION_MAX_CHARS
            ? `${summary.slice(0, BACKGROUND_COMPLETION_MAX_CHARS)}\n[completion truncated]`
            : summary;
        this.pi.sendMessage(
          {
            customType: "pi-raft-agent-complete",
            content: `Raft agent ${result.id.slice(0, 8)} ${result.status} after ${duration}: ${clippedSummary}`,
            display: true,
            details: result,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    });
    const agentsProvider = new AgentsProvider(
      this.#agents,
      () => this.#config?.appearance.ui.showAgentToolPreview ?? true,
      () => this.#config?.models ?? DEFAULT_RAFT_CONFIG.models,
    );
    await builtins.install(
      createProviderComponent({
        provider: "agents",
        description:
          "One-shot Pi or Claude Code agents over process, tmux, screen, LocalTerm, or Herdr",
        create: () => agentsProvider,
      }),
    );
    await builtins.memory(context, this.#config, sessionId);
    builtins.assertActive(this.#config);
    await this.#mountExecution(context);
    const inheritedRequirements = inheritedCapabilityRequirements();
    const inheritedDigest = process.env.PI_RAFT_CAPABILITY_DIGEST;
    const hasInheritedCommit =
      process.env.PI_RAFT_CAPABILITY_REQUIREMENTS !== undefined && Boolean(inheritedDigest);
    if (inheritedRequirements.length > 0 || hasInheritedCommit) {
      const lease = await this.#registry.acquireCapabilityView(inheritedRequirements, {
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "raft-capability-commit",
        nestedToolCallId: "raft-capability-commit",
        extensionContext: context,
        update() {},
      });
      if (!lease.satisfied || !lease.view) {
        await lease.release();
        throw new Error(`Required Raft capabilities are unavailable: ${lease.missing.join(", ")}`);
      }
      const expectedDigest = inheritedDigest;
      if (expectedDigest && lease.view.semanticDigest !== expectedDigest) {
        await lease.release();
        throw new Error(
          `Raft capability commitment mismatch: expected ${expectedDigest}, resolved ${lease.view.semanticDigest}`,
        );
      }
      this.#sessionCapabilityLease = lease;
      this.execution.setCapabilityView(lease.view);
    }
  }

  async #mountExecution(context: ExtensionContext): Promise<void> {
    this.#execution = new RaftExecutionService(
      this.registry,
      this.config,
      this.activity,
      undefined,
      undefined,
      this.sessionApprovals,
      undefined,
    );
    const componentDiscovery: RaftComponentDiscovery = {
      version: 1,
      register: (component, options) => this.registerExternalComponent(component, options),
    };
    this.pi.events.emit(RAFT_COMPONENT_DISCOVER_EVENT, componentDiscovery);
    await this.components.reconcile(this.config.components);
  }

  async ensure(context: ExtensionContext): Promise<void> {
    if (!this.initialized || this.#cwd !== context.cwd) await this.initialize(context);
  }

  async reloadConfig(context: ExtensionContext, next: RaftConfig): Promise<void> {
    if (!this.#config || !this.#cwd) return;
    this.#speculation?.reset();
    const previousComponents = structuredClone(this.#config.components);
    deepAssign(
      this.#config as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
    this.#registry?.setRiskOverrides(next.safety.toolRisks);
    this.#configureSpeculation();
    try {
      await this.#componentLoader?.reconcile(next.components);
      this.#builtins?.assertActive(this.#config);
    } catch (error) {
      if (this.#config) this.#config.components = previousComponents;
      const detail = error instanceof Error ? error.message : String(error);
      if (context.hasUI) context.ui.notify(`Pi Raft reload failed: ${detail}`, "error");
    }
  }

  #configureSpeculation(): void {
    this.#speculation?.reset();
    this.#speculation = undefined;
    this.#registry?.setSpeculation(undefined);
    const config = this.#config;
    // Native runtimes can mutate outside registry epochs; only isolated backends speculate.
    // Recreate the tap/store for every policy change so limits, epochs and
    // pending asynchronous scans cannot leak across an execution boundary.
    const eligible = (): boolean => {
      const current = this.#config;
      if (!current?.speculation.enabled) return false;
      return current.execution.executor.kernel === "python"
        ? current.execution.executor.pythonRuntime === "monty"
        : current.execution.executor.runtime === "quickjs";
    };
    if (!config || !this.#registry || !eligible()) return;
    this.#speculation = new RuntimeStateSpeculation(
      this.#registry,
      () => (eligible() ? this.#config?.speculation : undefined),
      () => this.#sessionCapabilityLease?.view,
      (ref) => {
        const current = this.#config!;
        if (current.safety.approvals[ref.startsWith("mcp.") ? "network" : "read"] !== "allow")
          return false;
        return true;
      },
      config.execution.executor.kernel,
    );
  }

  registerExternalComponent(
    component: RaftComponentDefinition,
    options: { overwrite?: boolean } = {},
  ): void {
    if (component.name.startsWith(RAFT_PROVIDER_COMPONENT_PREFIX)) {
      throw new Error(`Reserved Raft component name: ${component.name}`);
    }
    this.componentCatalog.register(component, options);
  }

  async settleComponents(): Promise<void> {
    await this.#componentLoader?.settle();
  }

  async shutdown(): Promise<void> {
    await this.#componentLoader?.close();
    await this.#sessionCapabilityLease?.release().catch(() => undefined);
    this.#sessionCapabilityLease = undefined;
    await this.#agents?.close();
    await this.#registry?.close();
    this.#registry = undefined;
    this.#config = undefined;
    this.#execution = undefined;
    this.#agents = undefined;
    this.#compact = undefined;
    this.#componentSupervisor = undefined;
    this.#componentLoader = undefined;
    this.#builtins = undefined;
    this.componentCatalog.clear();
    this.#builtinComponentNames.clear();
    this.#cwd = undefined;
    this.activity.reset();
    this.#widgetDismissedAt = 0;
  }

  async #closeInternal(): Promise<void> {
    if (!this.#registry) return;
    await this.#componentLoader?.close();
    await this.#sessionCapabilityLease?.release().catch(() => undefined);
    this.#sessionCapabilityLease = undefined;
    await this.#agents?.close();
    await this.#registry.close();
    this.#registry = undefined;
    this.#execution = undefined;
    this.#agents = undefined;
    this.#compact = undefined;
    this.#componentSupervisor = undefined;
    this.#componentLoader = undefined;
    this.#builtins = undefined;
    this.#sessionCapabilityLease = undefined;
    this.#unsubscribeCapturedCatalog?.();
    this.#unsubscribeCapturedCatalog = undefined;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepAssign = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const targetValue = target[key];
    if (isPlainObject(value) && isPlainObject(targetValue)) {
      deepAssign(targetValue, value);
    } else {
      target[key] = value;
    }
  }
};
