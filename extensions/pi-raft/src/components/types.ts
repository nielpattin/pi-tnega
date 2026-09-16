import type {
  RaftCommittedCapabilityView,
  RaftEffectKind,
  RaftEffectOrdering,
  RaftInvocationContext,
  RaftProvider,
} from "../protocol.js";

export type RaftComponentGuarantee = "managed" | "revertible";

export interface RaftCapabilityRequirement {
  ref: string;
  optional?: boolean;
}

export interface RaftComponentProvision {
  provider: string;
}

export type RaftComponentDisposer = () => void | Promise<void>;

export type RaftModelGuidanceTarget = "main" | "participant";
export type RaftModelGuidancePlacement = "append" | "replace";

export interface RaftModelGuidance {
  label: string;
  models: readonly string[];
  content: string;
  targets?: readonly RaftModelGuidanceTarget[];
  placement?: RaftModelGuidancePlacement;
  slot?: string;
}

type RaftComponentEffectValue =
  | void
  | RaftComponentDisposer
  | Iterable<RaftComponentDisposer, void, void>
  | AsyncIterable<RaftComponentDisposer, void, void>;

export type RaftComponentEffect = RaftComponentEffectValue | Promise<RaftComponentEffectValue>;

export interface RaftComponentEffectOptions {
  label?: string;
  kind?: RaftEffectKind;
  resources?: readonly string[];
  ordering?: RaftEffectOrdering;
}

export type RaftComponentEffectRegistration = string | RaftComponentEffectOptions;

export interface RaftComponentDefinition<TConfig = unknown> {
  name: string;
  description?: string;
  requires?: readonly (string | RaftCapabilityRequirement)[];
  provides?: readonly (string | RaftComponentProvision)[];
  guarantee?: RaftComponentGuarantee;
  activate(context: RaftComponentContext, config: TConfig): RaftComponentEffect;
}

export interface RaftComponentProviderLease {
  readonly bindingId: string;
  readonly name: string;
  readonly generation: number;
  readonly active: boolean;
  retire(): void;
  release(): Promise<void>;
}

export interface RaftComponentChildOptions<TConfig = unknown> {
  id?: string;
  config?: TConfig;
}

export interface RaftComponentStopOptions {
  force?: boolean;
}

export interface RaftComponentHandle {
  readonly id: string;
  status(): RaftComponentInfo;
  stop(options?: RaftComponentStopOptions): Promise<void>;
}

export interface RaftComponentContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly view: RaftCommittedCapabilityView;
  readonly invocation: RaftInvocationContext;
  effect(
    setup: () => RaftComponentEffect,
    registration?: RaftComponentEffectRegistration,
  ): Promise<RaftComponentDisposer>;
  defer(
    disposer: RaftComponentDisposer,
    registration?: RaftComponentEffectRegistration,
  ): RaftComponentDisposer;
  provide(provider: RaftProvider): RaftComponentProviderLease;
  guide(guidance: RaftModelGuidance): RaftComponentDisposer;
  use<TConfig = unknown>(
    definition: RaftComponentDefinition<TConfig>,
    options?: RaftComponentChildOptions<TConfig>,
  ): RaftComponentHandle;
  acquire<T = unknown>(ref: string, args?: Record<string, unknown>): Promise<T>;
  call(ref: string, args?: Record<string, unknown>): Promise<unknown>;
}

export type RaftComponentState =
  | "waiting"
  | "loading"
  | "active"
  | "unloading"
  | "failed"
  | "quarantined"
  | "disposed";

export interface RaftComponentEntry {
  id: string;
  component: string;
  config?: unknown;
  disabled?: boolean;
}

export interface RaftComponentEffectInfo {
  label: string;
  kind: RaftEffectKind;
  resources: string[];
  ordering: RaftEffectOrdering;
}

export interface RaftModelGuidanceInfo {
  label: string;
  models: string[];
  targets: RaftModelGuidanceTarget[];
  placement: RaftModelGuidancePlacement;
  slot?: string;
  contentChars: number;
  contentHash: string;
}

export interface RaftComponentEffectConflict {
  withComponent: string;
  resources: string[];
  reason: "shared_resource" | "unknown_resource";
}

export interface RaftComponentInfo {
  id: string;
  component: string;
  parentId?: string;
  state: RaftComponentState;
  guarantee: RaftComponentGuarantee;
  requirements: string[];
  provisions: string[];
  missing: string[];
  optionalMissing: string[];
  effects?: RaftComponentEffectInfo[];
  effectConflicts?: RaftComponentEffectConflict[];
  guidance?: RaftModelGuidanceInfo[];
  targetDigest?: string;
  error?: string;
  cleanupErrors?: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface RaftComponentGraph {
  components: RaftComponentInfo[];
  edges: Array<{ from: string; to: string; ref: string; kind?: "dependency" | "ownership" }>;
  cycles: string[][];
}

export interface RaftComponentRegistration {
  version: 1;
  component: RaftComponentDefinition;
  overwrite?: boolean;
}

export interface RaftComponentDiscovery {
  version: 1;
  register(component: RaftComponentDefinition, options?: { overwrite?: boolean }): void;
}
