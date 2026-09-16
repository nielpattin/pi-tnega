import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./core/agent-dir.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { RaftActivityStore } from "./activity/store.js";
import { RAFT_PROVIDER_COMPONENT_PREFIX } from "./components/provider-component.js";
import type { RaftOwnedModelGuidance } from "./components/model-guidance.js";
import type { RaftComponentGraph } from "./components/types.js";
import type { RaftMainAgentInfo } from "./main-agent.js";
import { loadRaftConfig, type RaftConfig } from "./config.js";
import { RaftSessionApprovals } from "./core/approval-controller.js";
import type { RaftActionDescriptor, RaftComponentDefinition } from "./protocol.js";
import type { RaftRuntimeState } from "./raft-runtime-state.js";
import type { RaftRuntimePaths } from "./runtime-paths.js";

export interface RaftStateOptions {
  paths?: RaftRuntimePaths;
  runtimeLoader?: () => Promise<typeof import("./raft-runtime-state.js")>;
}

type ActivationHook = (context: ExtensionContext) => void | Promise<void>;
type ActivationFailureHook = () => void | Promise<void>;

export class RaftState {
  #runtime: RaftRuntimeState | undefined;
  #activatingRuntime: RaftRuntimeState | undefined;
  #activation: Promise<RaftRuntimeState> | undefined;
  #activationGeneration: number | undefined;
  #config: RaftConfig | undefined;
  #kernelReloadRequired = false;

  #cwd: string | undefined;
  #generation = 0;
  #everActivated = false;
  #activationHook: ActivationHook | undefined;
  #activationFailureHook: ActivationFailureHook | undefined;
  readonly #externalComponents = new Map<string, RaftComponentDefinition>();
  readonly #options: RaftStateOptions;
  readonly activity = new RaftActivityStore();
  readonly sessionApprovals = new RaftSessionApprovals();
  #widgetDismissedAt = 0;

  constructor(
    readonly pi: ExtensionAPI,
    options: RaftStateOptions = {},
  ) {
    this.#options = options;
  }

  get kernelReloadRequired(): boolean {
    return this.#kernelReloadRequired;
  }

  get initialized(): boolean {
    return this.#current()?.initialized === true;
  }

  // Lightweight bootstrap seam: true once configuration is loaded, with no
  // dependency on the heavyweight runtime. Rendering reads this instead of
  // initialized so a resumed session honors bootstrapped presentation
  // preferences while the runtime is intentionally inactive.
  get bootstrapped(): boolean {
    return this.#config !== undefined;
  }

  get activated(): boolean {
    return this.#everActivated;
  }

  get config(): RaftConfig {
    if (!this.#config) throw new Error("Pi Raft has not bootstrapped");
    return this.#config;
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  get widgetDismissedAt(): number {
    return this.#current()?.widgetDismissedAt ?? this.#widgetDismissedAt;
  }

  set widgetDismissedAt(value: number) {
    this.#widgetDismissedAt = value;
    const runtime = this.#current();
    if (runtime) runtime.widgetDismissedAt = value;
  }

  get registry(): RaftRuntimeState["registry"] {
    return this.#required().registry;
  }
  get execution(): RaftRuntimeState["execution"] {
    return this.#required().execution;
  }

  /** Speculative-PTC stream tap; undefined pre-init or when speculation is disabled. */
  get speculationTap(): RaftRuntimeState["speculationTap"] {
    return this.#runtime?.speculationTap;
  }

  /** Turn-boundary backstop for the speculation store; safe before initialization. */
  resetSpeculation(): void {
    this.#runtime?.resetSpeculation();
  }
  get agents(): RaftRuntimeState["agents"] {
    return this.#required().agents;
  }
  get compact(): RaftRuntimeState["compact"] {
    return this.#required().compact;
  }
  get components(): RaftRuntimeState["components"] {
    return this.#required().components;
  }

  setActivationHook(hook: ActivationHook, onFailure?: ActivationFailureHook): void {
    this.#activationHook = hook;
    this.#activationFailureHook = onFailure;
  }

  async bootstrap(context: ExtensionContext): Promise<void> {
    const generation = ++this.#generation;
    this.#cwd = context.cwd;
    // A failed config load must not leak the previous session's configuration
    // into this one: clear before the read so bootstrapped stays false and
    // presentation falls back to the safe default until a load succeeds.
    this.#config = undefined;
    const config = loadRaftConfig({
      cwd: context.cwd,
      agentDir: resolveAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
    this.#config = config;
    this.#kernelReloadRequired = false;
    this.activity.reset();
    this.sessionApprovals.approvedRisks.clear();
    this.#widgetDismissedAt = 0;

    const pending = this.#activation;
    if (pending) await pending.catch(() => undefined);
    if (generation !== this.#generation) return;
    if (this.#everActivated) await this.#activate(context, true);
  }

  async initialize(context: ExtensionContext): Promise<void> {
    if (!this.#config || this.#cwd !== context.cwd) {
      await this.bootstrap(context);
    } else {
      const next = loadRaftConfig({
        cwd: context.cwd,
        agentDir: resolveAgentDir(),
        projectTrusted: context.isProjectTrusted(),
      });
      this.#kernelReloadRequired =
        next.execution.executor.kernel !== this.#config.execution.executor.kernel;
      next.execution.executor.kernel = this.#config.execution.executor.kernel;
      this.#config = next;
    }
    await this.#activate(context, true);
  }

  async ensure(context: ExtensionContext): Promise<void> {
    if (!this.#config || this.#cwd !== context.cwd) await this.bootstrap(context);
    await this.#activate(context, false);
  }

  shouldEagerlyActivate(context: ExtensionContext): boolean {
    if (
      process.env.PI_RAFT_CAPABILITY_REQUIREMENTS !== undefined &&
      Boolean(process.env.PI_RAFT_CAPABILITY_DIGEST)
    )
      return true;
    if (this.config.components.some((component) => component.disabled !== true)) return true;
    return false;
  }

  mainAgentInfo(context?: ExtensionContext): RaftMainAgentInfo {
    return this.#required().mainAgentInfo(context);
  }
  componentGraph(): RaftComponentGraph {
    return this.#current()?.componentGraph() ?? { components: [], edges: [], cycles: [] };
  }
  modelGuidance(): RaftOwnedModelGuidance[] {
    return this.#current()?.modelGuidance() ?? [];
  }

  registerExternalComponent(
    component: RaftComponentDefinition,
    options: { overwrite?: boolean } = {},
  ): void {
    if (component.name.startsWith(RAFT_PROVIDER_COMPONENT_PREFIX)) {
      throw new Error(`Reserved Raft component name: ${component.name}`);
    }
    if (this.#externalComponents.has(component.name) && !options.overwrite) {
      throw new Error(`Raft component already registered: ${component.name}`);
    }
    this.#externalComponents.set(component.name, component);
    this.#current()?.registerExternalComponent(component, options);
  }

  reloadConfig(context: ExtensionContext): Promise<void> {
    const next = loadRaftConfig({
      cwd: context.cwd,
      agentDir: resolveAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
    if (this.#config) {
      // Pi skill discovery is additive. Keep execution aligned with the loaded
      // skill tree until Pi reload creates a fresh extension/resource runtime.
      this.#kernelReloadRequired =
        next.execution.executor.kernel !== this.#config.execution.executor.kernel;
      next.execution.executor.kernel = this.#config.execution.executor.kernel;
    }
    this.#config = next;
    return this.#runtime?.reloadConfig(context, next) ?? Promise.resolve();
  }

  async shutdown(): Promise<void> {
    const generation = ++this.#generation;
    const activation = this.#activation;
    if (activation) await activation.catch(() => undefined);
    if (generation !== this.#generation) return;

    const runtime = this.#runtime;
    this.#runtime = undefined;
    try {
      await runtime?.shutdown();
    } finally {
      if (generation === this.#generation) {
        this.#config = undefined;
        this.#cwd = undefined;
        this.#externalComponents.clear();
        this.#everActivated = false;
        this.activity.reset();
      }
    }
  }

  async #activate(context: ExtensionContext, reinitialize: boolean): Promise<RaftRuntimeState> {
    if (this.#activation) {
      if (this.#activationGeneration === this.#generation) return this.#activation;
      await this.#activation.catch(() => undefined);
      return this.#activate(context, reinitialize);
    }
    if (this.#runtime?.initialized && !reinitialize) return this.#runtime;

    const generation = this.#generation;
    const config = this.config;
    const existing = this.#runtime;
    const reusable = existing?.initialized ? existing : undefined;
    const orphan = existing && !existing.initialized ? existing : undefined;
    this.#runtime = undefined;
    let candidate: RaftRuntimeState | undefined;
    const assertCurrent = (): void => {
      if (generation !== this.#generation) {
        throw new Error("Pi Raft activation was superseded by a session change");
      }
    };
    const activation = (async () => {
      try {
        await orphan?.shutdown().catch(() => undefined);
        assertCurrent();
        candidate = reusable ?? (await this.#createRuntime());
        if (!reusable) {
          for (const component of this.#externalComponents.values()) {
            candidate.registerExternalComponent(component, { overwrite: true });
          }
        }
        await candidate.initialize(context, config);
        assertCurrent();
        await candidate.settleComponents?.();
        assertCurrent();
        this.#activatingRuntime = candidate;
        candidate.widgetDismissedAt = this.#widgetDismissedAt;
        await this.#activationHook?.(context);
        assertCurrent();
        this.#runtime = candidate;
        this.#activatingRuntime = undefined;
        this.#everActivated = true;
        return candidate;
      } catch (error) {
        try {
          await this.#activationFailureHook?.();
        } catch {
          // Cleanup is best-effort; preserve the activation failure.
        }
        if (this.#activatingRuntime === candidate) this.#activatingRuntime = undefined;
        if (candidate) await candidate.shutdown().catch(() => undefined);
        if (this.#runtime === candidate) this.#runtime = undefined;
        throw error;
      }
    })();
    this.#activation = activation;
    this.#activationGeneration = generation;
    void activation
      .finally(() => {
        if (this.#activation === activation) {
          this.#activation = undefined;
          this.#activationGeneration = undefined;
        }
      })
      .catch(() => undefined);
    return activation;
  }

  async #createRuntime(): Promise<RaftRuntimeState> {
    const module = await (this.#options.runtimeLoader?.() ?? import("./raft-runtime-state.js"));
    return new module.RaftRuntimeState(this.pi, {
      activity: this.activity,
      sessionApprovals: this.sessionApprovals,
      ...(this.#options.paths ? { paths: this.#options.paths } : {}),
    });
  }

  #current(): RaftRuntimeState | undefined {
    return this.#runtime ?? this.#activatingRuntime;
  }

  #required(): RaftRuntimeState {
    const runtime = this.#current();
    if (!runtime?.initialized) throw new Error("Pi Raft has not activated");
    return runtime;
  }
}
