import type { RaftDynamicGuestDeclarations } from "../protocol.js";

export const GUEST_TYPE_DECLARATIONS = `
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RaftTransport = "auto" | "process" | "tmux" | "screen" | "localterm" | "herdr";
type RaftAgentRunner = "pi" | "claude";
type RaftKernel = "typescript" | "python";
type RaftThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface RaftActionEffect {
  kind: "none" | "scoped" | "transactional" | "emission";
  resources?: string[];
  ordering?: "commutative" | "ordered" | "unknown";
}
interface RaftAction {
  ref: string;
  provider: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: "read" | "write" | "execute" | "network" | "agent";
  namespace?: string;
  effect?: RaftActionEffect;
}
interface RaftAgentRequest {
  /** Omitted/inherit uses caller executor.kernel; concrete choices require Pi with extensions. */
  kernel?: RaftKernel | "inherit";
  task: string;
  name?: string;
  runner?: RaftAgentRunner;
  transport?: RaftTransport;
  model?: string;
  thinking?: RaftThinking;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  /** Filesystem execution directory; relative paths resolve from the parent agent cwd. */
  cwd?: string;
  worktree?: boolean;
  schema?: Record<string, unknown>;
  prompt?: string;
  instructions?: string;
  timeout_ms?: number;
}
interface RaftMainAgentInfo {
  id: string;
  name: "Main";
  kind: "main";
  status: "idle" | "running" | "remote";
  runner: "pi";
  transport: "host";
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: boolean;
}
interface RaftAgentHandle {
  /** Resolved Raft kernel, absent for non-Raft runners. */
  kernel?: RaftKernel;
  id: string;
  name: string;
  status: string;
  runner: RaftAgentRunner;
  /** Local execution metadata is absent for hosted participants. */
  transport?: RaftTransport;
  cwd?: string;
  rootId?: string;
  parentId?: string;
  depth?: number;
  generation?: number;
  model?: string;
  thinking?: RaftThinking;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  text?: string;
  value?: unknown;
  error?: string;
  logFile?: string;
}
interface RaftAgentResult extends RaftAgentHandle {
  task: string;
  startedAt: number;
  finishedAt?: number;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  pendingMessages?: { steering: string[]; followUp: string[] };
}
interface RaftModelInfo {
  runner?: RaftAgentRunner;
  provider: string;
  id: string;
  name: string;
  key: string;
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}
interface RaftLogLine {
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}
interface RaftAgentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: RaftAgentResult;
  events: RaftLogLine[];
  hasMore: boolean;
  before?: number;
}
interface RaftCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: "read" | "write" | "execute" | "network" | "agent";
  namespace?: string;
  effect?: RaftActionEffect;
}
interface RaftCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: RaftCapabilityActionHead[];
}
interface RaftCapabilityCatalog {
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
interface RaftToolsApi {
  search(query: string): Promise<RaftAction[]>;
  search(args: { query: string; limit?: number }): Promise<RaftAction[]>;
  describe(args: { ref: string }): Promise<RaftAction>;
  call(args: { ref: string; args?: Record<string, unknown> }): Promise<unknown>;
  progress(args: { message: string }): Promise<void>;
}
interface RaftModelSwitchRequest {
  /** provider/id, a models.aliases name, or a search term; resolution tries aliases first, then exact matches, then the closest fuzzy match (recency from pi-model-sort breaks ties) against authenticated models. */
  model: string;
  /** Optional provider filter applied before matching (e.g. "anthropic"). */
  provider?: string;
}
interface RaftModelSwitchResult {
  switched: boolean;
  /** Active model as provider/id after the call (unchanged when reason is "already-active"). */
  model: string;
  name?: string;
  /** Previously active provider/id when known. Absent for already-active results. */
  previous?: string;
  /** Set when the selector resolved through a configured models.aliases name. */
  alias?: string;
  /** How the selector resolved: the alias name, or one of closest/recent/latest for inexact picks. Absent for exact provider/id or bare-id matches. */
  via?: string;
  reason?: "already-active";
}
// agentId/agent_id spellings repair to id during agent arg normalization.
type RaftAgentTargetArgs = { id: string; agentId?: string; agent_id?: string };
interface RaftAgentsApi {
  run(args: RaftAgentRequest): Promise<RaftAgentResult>;
  spawn(args: RaftAgentRequest): Promise<RaftAgentHandle & { awaitWith: string }>;
  wait(args: RaftAgentTargetArgs): Promise<RaftAgentResult>;
  status(args: RaftAgentTargetArgs): Promise<RaftAgentResult | RaftAgentHandle | RaftMainAgentInfo>;
  list(): Promise<Array<RaftAgentResult | RaftAgentHandle>>;
  stop(args: RaftAgentTargetArgs): Promise<RaftAgentResult>;
  log(args: {
    id: string;
    lines?: number;
    before?: number;
  }): Promise<RaftAgentLog>;
}
interface RaftMcpResult {
  text: string;
  content: unknown[];
  structuredContent: unknown;
}
interface RaftMcpTool {
  (args?: Record<string, unknown>): Promise<RaftMcpResult | unknown>;
}
interface RaftMcpServer {
  [tool: string]: RaftMcpTool;
}
// Management verbs stay members of mcp even when the declare line below is
// replaced by generated per-server declarations (see the dynamic option on
// guestTypeDeclarations), so generated surfaces intersect with this type
// rather than re-declaring them.
interface RaftMcpManagement {
  servers(): Promise<Array<{ name: string; description: string | null; transport: "http" | "stdio" }>>;
  reload(): Promise<{ servers: string[] }>;
  register(args: {
    name: string;
    description?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    overwrite?: boolean;
  }): Promise<{ registered: string }>;
  call(args: { server: string; tool: string; args?: Record<string, unknown> }): Promise<unknown>;
}
// Loose static surface: any server/tool name compiles and argument shapes are
// enforced at dispatch by the registry. With descriptor data available the
// execution service replaces the declare-const-mcp line below with a
// schema-typed rendering of the live cache (runtime/dynamic-guest-types.ts).
type RaftMcpApi = Record<string, RaftMcpServer> & RaftMcpManagement;
// Stable-provider argument bags declare the canonical keys plus the
// near-miss spellings repaired during argument normalization
// (providers/arg-normalization.ts and each provider's per-action table). The
// registry's prepare stage repairs aliases before schema validation, so a
// call spelled with an alias typechecks instead of tripping the
// excess-property check; the canonical key wins on conflict, and anything
// else fails additionalProperties:false validation with the offending
// property path named. Keep these spillover fields in sync with the provider
// normalization tables.
type RaftMemoryBranches = "active" | "all";
type RaftMemoryQueryMode = "literal" | "phrase" | "regex";
type RaftMemoryQueryMatch = "all" | "any";
interface RaftMemoryEntryRange {
  first: number;
  last: number;
}
interface RaftMemoryRecallArgs {
  source?: string;
  query?: string;
  queryMode?: RaftMemoryQueryMode;
  queryMatch?: RaftMemoryQueryMatch;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: RaftMemoryBranches;
  scope?: string;
  offset?: number;
  pageSize?: number;
  snippetChars?: number;
  role?: string;
  tool?: string;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  since?: number;
  until?: number;
  entryRange?: RaftMemoryEntryRange;
  q?: string;
  limit?: number;
  max?: number;
  page_size?: number;
  snippet_chars?: number;
  query_mode?: RaftMemoryQueryMode;
  query_match?: RaftMemoryQueryMatch;
  entry_range?: RaftMemoryEntryRange;
}
interface RaftMemoryExpandArgs {
  source?: string;
  session: string;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: RaftMemoryBranches;
  indices?: number[];
  entryIds?: string[];
  operationAddresses?: string[];
  entryRange?: RaftMemoryEntryRange;
  before?: number;
  after?: number;
  entryOffset?: number;
  textOffset?: number;
  maxChars?: number;
  maxEntries?: number;
  id?: string;
  file?: string;
  path?: string;
  session_id?: string;
  index?: number;
  entry_ids?: string[];
  operation_addresses?: string[];
  entry_range?: RaftMemoryEntryRange;
  entry_offset?: number;
  text_offset?: number;
  max_chars?: number;
  max_entries?: number;
}
interface RaftMemoryCall<Ref extends string, Args> {
  ref: Ref;
  args: Args;
}
interface RaftMemoryRecallEntryHit {
  kind: "entry";
  sessionId: string;
  tier: "hot" | "cold";
  index: number;
  entryId: string | null;
  parentId: string | null;
  operationAddress: string | null;
  type: string;
  role: string | null;
  tool: string | null;
  ref: string | null;
  provider: string | null;
  action: string | null;
  timestamp: number | null;
  isError: boolean;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  score: number;
  snippet: string;
  truncated: boolean;
  follow: RaftMemoryCall<"memory.expand", RaftMemoryExpandArgs>;
}
interface RaftMemoryRecallSessionHit {
  kind: "session";
  sessionId: string;
  tier: "cold";
  cwd: string;
  lastTimestamp: number | null;
  score: number;
  matchedTerms: number;
  matchedStructuralEntries: number;
  follow: RaftMemoryCall<"memory.recall", RaftMemoryRecallArgs>;
}
type RaftMemoryRecallHit = RaftMemoryRecallEntryHit | RaftMemoryRecallSessionHit;
interface RaftMemoryError {
  code: string;
  message: string;
  [key: string]: unknown;
}
interface RaftMemoryCoverage {
  complete: boolean;
  indexedSessions: number;
  eligibleSessions: number;
  staleSessions: number;
  incompleteSessions: number;
  reasons: string[];
  error?: RaftMemoryError;
}
interface RaftMemoryRecallResult {
  total: number;
  hits: RaftMemoryRecallHit[];
  next: RaftMemoryCall<"memory.recall", RaftMemoryRecallArgs> | null;
  coverage: RaftMemoryCoverage;
  error?: RaftMemoryError;
}
interface RaftMemoryExpandedEntry {
  index: number;
  entryId: string | null;
  parentId: string | null;
  type: string | null;
  role: string | null;
  timestamp: number | null;
  isError: boolean;
  anchor?: boolean;
  text: string;
  textRange: { start: number; end: number; total: number; complete: boolean };
  parentEntryId?: string | null;
  operationAddress?: string | null;
  tool?: string | null;
  ref?: string | null;
  provider?: string | null;
  action?: string | null;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  filesTouched?: Array<string | null>;
  operation?: unknown;
  branchFact?: unknown;
  structuredTruncated?: boolean;
  factAddress?: string | null;
  carrierEntryId?: string | null;
  carrierParentId?: string | null;
  carrierFromId?: string | null;
}
interface RaftMemoryExpandResult {
  session?: string;
  sourceHash?: string;
  branches?: RaftMemoryBranches;
  lineageFingerprint?: string;
  entryCount?: number;
  entries: RaftMemoryExpandedEntry[];
  next?: RaftMemoryCall<"memory.expand", RaftMemoryExpandArgs> | null;
  error?: RaftMemoryError;
}
interface RaftMemoryApi {
  recall(args?: RaftMemoryRecallArgs): Promise<RaftMemoryRecallResult>;
  expand(args: RaftMemoryExpandArgs): Promise<RaftMemoryExpandResult>;
}

declare const tools: RaftToolsApi;
declare const agents: RaftAgentsApi;
declare const mcp: RaftMcpApi;
declare const memory: RaftMemoryApi;
interface RaftConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare const console: RaftConsole;
declare const π: Readonly<Record<string, string>>;
declare function print(...args: unknown[]): void;
`;

const MCP_LOOSE_DECLARATION = "declare const mcp: RaftMcpApi;\n";

export interface RaftGuestDeclarationOptions {
  /** Global names to omit (for example providers disabled by configuration). */
  excludeGlobals?: readonly string[];
  /** Pre-rendered replacement blocks from buildDynamicGuestDeclarations(). */
  dynamic?: RaftDynamicGuestDeclarations;
}

const globalDeclarationLine = (name: string): RegExp =>
  new RegExp(`^declare const ${name}: [^\n]*;\n`, "m");

const terminatedDeclaration = (block: string): string =>
  block.endsWith("\n") ? block : `${block}\n`;

export const guestTypeDeclarations = (options: RaftGuestDeclarationOptions = {}): string => {
  let result = GUEST_TYPE_DECLARATIONS;
  result = (options.excludeGlobals ?? []).reduce(
    (declarations, name) => declarations.replace(globalDeclarationLine(name), ""),
    result,
  );
  if (options.dynamic?.mcp && result.includes(MCP_LOOSE_DECLARATION)) {
    result = result.replace(MCP_LOOSE_DECLARATION, terminatedDeclaration(options.dynamic.mcp));
  }
  return result;
};
