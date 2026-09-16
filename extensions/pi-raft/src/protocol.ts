import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RAFT_COMPONENT_REGISTER_EVENT = "pi-raft:component:register:v1";
export const RAFT_COMPONENT_DISCOVER_EVENT = "pi-raft:component:discover:v1";

/** Identifies host-side tool lifecycle events replayed for a nested Raft call. */
export const RAFT_NESTED_TOOL_CALL_ID_PREFIX = "raft_";

/** Discriminant for the transient details envelope on a proxied provider result. */
export const RAFT_TOOL_RESULT_PROXY_KIND = "pi-raft.tool-result-proxy.v1";

/**
 * Host-only middleware details for non-Pi Raft providers. `result` is the
 * exact value before maxNestedResultChars is enforced and is not persisted as
 * a separate Pi tool-result message.
 */
export interface RaftToolResultProxyDetailsV1 {
  kind: typeof RAFT_TOOL_RESULT_PROXY_KIND;
  ref: string;
  result: unknown;
}

export const readRaftToolResultProxyDetailsV1 = (
  value: unknown,
): RaftToolResultProxyDetailsV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== RAFT_TOOL_RESULT_PROXY_KIND ||
    typeof record.ref !== "string" ||
    !Object.prototype.hasOwnProperty.call(record, "result")
  ) {
    return undefined;
  }
  return record as unknown as RaftToolResultProxyDetailsV1;
};

export type RaftRisk = "read" | "write" | "execute" | "network" | "agent";
export type RaftEffectKind = "none" | "scoped" | "transactional" | "emission";
export type RaftEffectOrdering = "commutative" | "ordered" | "unknown";

export interface RaftActionEffect {
  kind: RaftEffectKind;
  resources?: string[];
  ordering?: RaftEffectOrdering;
}

/** MCP tool annotations (Model Context Protocol ToolAnnotations), cached when a runtime surfaces them. */
export interface RaftToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}
export type RaftActivityEntityKind = "agent" | "tool" | "extension" | "mcp" | "task" | "custom";

export type RaftInvocationActivityUpdate =
  | { type: "progress"; message: string }
  | { type: "entity"; id: string; kind: RaftActivityEntityKind; name?: string }
  | { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number };

export interface RaftMediaBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface RaftActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: RaftRisk;
  namespace?: string;
  effect?: RaftActionEffect;
  annotations?: RaftToolAnnotations;
}

export interface RaftCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: RaftRisk;
  namespace?: string;
  effect?: RaftActionEffect;
}

export interface RaftCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: RaftCapabilityActionHead[];
}

export interface RaftCapabilityBindingView {
  ref: string;
  provider: string;
  providerBindingId: string;
  generation: number;
  descriptorHash: string;
}

export interface RaftCommittedCapabilityView {
  id: string;
  /** Runtime-local digest including provider binding generations. */
  digest: string;
  /** Portable digest of exact refs and descriptor semantics across runtimes. */
  semanticDigest: string;
  bindings: Record<string, RaftCapabilityBindingView>;
}

export interface RaftCapabilityResolution {
  satisfied: boolean;
  missing: string[];
  optionalMissing: string[];
  view?: RaftCommittedCapabilityView;
}

export interface RaftCapabilityCatalog {
  kind: "pi-raft.capability-catalog";
  version: 1;
  root: {
    key: "capability:raft";
    name: "Raft capabilities";
    description: string;
    descriptorHash: string;
  };
  providers: RaftCapabilityProviderHead[];
  totalActions: number;
  indexedActions: number;
  complete: boolean;
  reasons: string[];
}

export interface RaftProviderListRequest {
  namespace?: string;
  query?: string;
  limit?: number;
}

/** One named action whose arguments should be typed in guest declarations. */
export interface RaftNamedActionTypeSource {
  name: string;
  inputSchema: Record<string, unknown>;
}

/** One MCP server plus the tools to type for `mcp.<server>.*` guest calls. */
export interface RaftMcpServerTypeSource {
  server: string;
  tools: RaftNamedActionTypeSource[];
}

export type {
  RaftKernel,
  RaftKernelRuntime,
  RaftHostCall,
  RaftSandboxOptions,
  RaftSandboxResult,
  RaftSandboxTerminationReason,
} from "./runtime/kernel.js";
export type { RaftPythonRuntime } from "./config.js";

/**
 * Live descriptor snapshot the registry hands to the guest declaration
 * builder so dynamic surfaces (mcp, extensions) get argument checking before
 * the sandbox runs. Empty/absent sections keep the loose static declarations.
 */
export interface RaftGuestTypeSources {
  mcpServers?: RaftMcpServerTypeSource[];
  extensionTools?: RaftNamedActionTypeSource[];
}

/**
 * Pre-rendered `declare const` blocks replacing the loose mcp/extensions
 * declaration lines. Values are full replacement text (helpers + declare).
 */
export interface RaftDynamicGuestDeclarations {
  mcp?: string;
}

export interface RaftInvocationContext {
  cwd: string;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  nestedToolCallId: string;
  extensionContext: ExtensionContext;
  update(message: string): void;
  activity?(update: RaftInvocationActivityUpdate): void;
  // Out-of-band image content blocks a provider (currently only pi.read of an
  // image file) wants attached to the call audit, so the single-call render can
  // re-attach them to the raft_exec result content for pi core's kitty image
  // preview. Bypasses the result char bound that would truncate the base64.
  // `note` is the read tool's own text output (e.g. "Read image file [image/png]"),
  // captured after any tool_result patch so a handoff that strips pi's
  // non-vision note has run; used as the single-call body + content text so the
  // preview shows the clean note instead of the swapped description.
  attachMedia?(blocks: RaftMediaBlock[], note?: string): void;
  // Providers call this after mutable tool_call middleware has run so live and
  // durable audit surfaces reflect the arguments actually passed to the tool.
  updateArguments?(args: Record<string, unknown>): void;
  // Ephemeral renderer-only metadata. It is exposed to live Raft previews but
  // never projected into the durable execution trace.
  attachPreview?(preview: unknown): void;
  capabilityView?: RaftCommittedCapabilityView;
  /** Advisory for ordinary calls; strict components reject concurrent conflicting effects. */
  effectPolicy?: "advisory" | "strict";
}

export interface RaftScopedProviderResult {
  value: unknown;
  dispose(): void | Promise<void>;
}

export interface RaftProvider {
  name: string;
  description: string;
  list(
    request: RaftProviderListRequest,
    context: RaftInvocationContext,
  ): Promise<RaftActionDescriptor[]>;
  describe(
    actionName: string,
    context: RaftInvocationContext,
  ): Promise<RaftActionDescriptor | undefined>;
  prepareArguments?(
    actionName: string,
    args: Record<string, unknown>,
    context: RaftInvocationContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: RaftInvocationContext,
  ): Promise<unknown>;
  acquire?(
    actionName: string,
    args: Record<string, unknown>,
    context: RaftInvocationContext,
  ): Promise<RaftScopedProviderResult>;
  invocationEnded?(parentToolCallId: string): Promise<void>;
  subscribeCatalog?(listener: () => void): () => void;
  close?(): Promise<void>;
}

export type {
  RaftCapabilityRequirement,
  RaftComponentChildOptions,
  RaftComponentContext,
  RaftComponentDefinition,
  RaftComponentDiscovery,
  RaftComponentDisposer,
  RaftComponentEffect,
  RaftComponentEffectConflict,
  RaftComponentEffectInfo,
  RaftComponentEffectOptions,
  RaftComponentEffectRegistration,
  RaftComponentEntry,
  RaftComponentGraph,
  RaftComponentGuarantee,
  RaftComponentHandle,
  RaftComponentInfo,
  RaftComponentProviderLease,
  RaftModelGuidance,
  RaftModelGuidanceInfo,
  RaftModelGuidancePlacement,
  RaftModelGuidanceTarget,
  RaftComponentProvision,
  RaftComponentRegistration,
  RaftComponentState,
  RaftComponentStopOptions,
} from "./components/types.js";

export {
  RAFT_EXECUTION_GUIDANCE_SLOT,
  MAX_RAFT_MODEL_GUIDANCE_CONTENT_CHARS,
  MAX_RAFT_MODEL_GUIDANCE_PER_COMPONENT,
  MAX_RAFT_MODEL_GUIDANCE_REGISTRATIONS,
  MAX_RAFT_MODEL_GUIDANCE_SNAPSHOT_CHARS,
  MAX_RAFT_MODEL_GUIDANCE_TOTAL_CHARS,
} from "./components/model-guidance.js";
