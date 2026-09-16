import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameAtomic } from "./core/atomic-write.js";
import { isRaftRisk, normalizeToolRiskRef } from "./core/tool-risk.js";
import { normalizeModelAliases } from "./core/model-resolution.js";
import { CURRENT_RAFT_CONFIG_VERSION, migrateRaftConfigDocument } from "./config-migrations.js";
import type { RaftComponentEntry } from "./components/types.js";
import type { RaftKernel } from "./runtime/kernel.js";
import type { RaftRisk } from "./protocol.js";
import { DEFAULT_RAFT_THINKING, isRaftThinking, type RaftThinking } from "./thinking.js";
import {
  defaultCodePreviewSettings,
  normalizeCodePreviewSettings,
  type CodePreviewSettings,
} from "./ui/code-preview.js";

type RaftApprovalMode = "allow" | "ask" | "auto" | "deny";
export type RaftAgentTransport = "auto" | "process" | "tmux" | "screen" | "localterm" | "herdr";
export type RaftAgentRunner = "pi" | "claude";
export type RaftUiWidgetMode = "auto" | "always" | "hidden";
type RaftToolDisplayMode = "full" | "compact";
export type RaftResultFormat = "auto" | "yaml" | "json" | "text";
export type RaftExecutorRuntime = "quickjs" | "node-process" | "bun-process";
export type RaftConfigScope = "global" | "project";
type RaftCompactionEngine = "pi" | "raft";

export type RaftPythonRuntime = "cpython" | "monty";
type RaftToolRiskOverrides = Record<string, RaftRisk>;

interface RaftExecutorConfig {
  kernel: RaftKernel;
  pythonRuntime: RaftPythonRuntime;
  cpython: { binary: string };
  /** TypeScript backend only; ignored by the Python kernel. */
  runtime: RaftExecutorRuntime;
  timeoutMs: number;
  /** Policy maximum for any executor deadline, including per-invocation
   * requests and per-ref floors. Values above this are visibly normalized. */
  maxTimeoutMs: number;
  /** Exact-ref deadline floors (ms) for known long-running host calls, e.g.
   * "agents.run". Keys are exact refs; no wildcard matching. */
  hostCallTimeouts: Record<string, number>;
  memoryLimitBytes: number;
  maxOutputChars: number;
  maxNestedResultChars: number;
  resultFormat: RaftResultFormat;
}

export interface RaftApprovalConfig {
  read: RaftApprovalMode;
  write: RaftApprovalMode;
  execute: RaftApprovalMode;
  network: RaftApprovalMode;
  agent: RaftApprovalMode;
  model?: string;
}

/** Session-start background revalidation scope for the MCP descriptor cache:
 * "changed" lists only added/reconfigured servers, "all" re-lists every known
 * server, "off" never spawns servers in the background. */
type RaftMcpRevalidatePolicy = "changed" | "all" | "off";

interface RaftMcpCacheConfig {
  /** Serve MCP tool metadata from the on-disk descriptor cache instead of
   * connecting to every configured server on first discovery each session. */
  enabled: boolean;
  revalidate: RaftMcpRevalidatePolicy;
  /** Wall-clock budget for one session-start background revalidation pass. */
  revalidateBudgetMs: number;
}

export interface RaftMcpConfig {
  enabled: boolean;
  configPath?: string;
  disableOAuth: boolean;
  allowDynamicServers: boolean;
  callTimeoutMs: number;
  cache: RaftMcpCacheConfig;
}

interface RaftClaudeRunnerConfig {
  binary: string;
  model?: string;
}

export interface RaftAgentConfig {
  enabled: boolean;
  runner: RaftAgentRunner;
  transport: RaftAgentTransport;
  model?: string;
  claude: RaftClaudeRunnerConfig;
  thinking: RaftThinking;
  maxConcurrent: number;
  maxPerExecution: number;
  maxDepth: number;
  timeoutMs: number;
  extensions: boolean;
  excludeTools: string[];
  defaultTools: string[];
  retainRuns: boolean;
  notifyOnComplete: boolean;
  budgetUsd: number;
  maxTokensPerChild: number;
  /** Write usage-only pi-format session files per agent run for external trackers. */
  sessionExport: boolean;
  /** Export store root override; PI_RAFT_AGENT_DIR wins. Empty = ~/.pi-raft/agent. */
  sessionExportDir: string;
}

interface RaftUiConfig {
  enabled: boolean;
  widget: RaftUiWidgetMode;
  maxRows: number;
  refreshMs: number;
  eventHistory: number;
  haltOnEscape: boolean;
  showAgentToolPreview: boolean;
  toolDisplay: RaftToolDisplayMode;
  updateDebounceMs: number;
}

interface RaftCompactionConfig {
  engine: RaftCompactionEngine;
  targetContextRatio: number;
  thresholds: Record<string, number>;
  tokenThresholds: Record<string, number>;
}

export const MIN_COMPACTION_TOKEN_THRESHOLD = 1_000;
export const MAX_COMPACTION_TOKEN_THRESHOLD = 100_000_000;
export const MIN_COMPACTION_RATIO_THRESHOLD = 0.25;
export const MAX_COMPACTION_RATIO_THRESHOLD = 0.95;

export const clampCompactionTokenThreshold = (value: number): number =>
  Math.min(
    MAX_COMPACTION_TOKEN_THRESHOLD,
    Math.max(MIN_COMPACTION_TOKEN_THRESHOLD, Math.round(value)),
  );

export const clampCompactionRatioThreshold = (value: number): number =>
  Math.min(MAX_COMPACTION_RATIO_THRESHOLD, Math.max(MIN_COMPACTION_RATIO_THRESHOLD, value));

export interface RaftRetentionConfig {
  orphanedTempRunMs: number;
  oneShotRunMs: number;
}

export interface RaftMemoryConfig {
  enabled: boolean;
  indexDir?: string;
  maxSessions: number;
  maxEntryChars: number;
  indexThinking: boolean;
  indexToolOutput: boolean;
  hotSessions?: number;
  digestTerms?: number;
  maxColdVocabularyBytes?: number;
  maxColdCacheBytes?: number;
  maxSyncSessions?: number;
  maxSyncSourceBytes?: number;
  maxCacheCleanupFiles?: number;
  regexMaxPatternBytes?: number;
  regexMaxHaystackTerms?: number;
  regexMaxHaystackBytes?: number;
  regexTimeoutMs?: number;
}

export interface RaftSpeculationConfig {
  /** Master switch for speculative programmatic tool calling during streaming. */
  enabled: boolean;
  /** Maximum simultaneously in-flight speculative calls; excess candidates are dropped. */
  maxConcurrent: number;
  /** Maximum retained unserved speculation entries per turn. */
  maxEntries: number;
  /** Per-stream cap on buffered partial tool-call arguments while extracting the `code` field. */
  maxBufferBytes: number;
  /** Unserved speculation entries older than this are aborted and discarded. */
  entryTtlMs: number;
  /**
   * Tier B: MCP tools that may be speculated despite risk "network". Entries
   * are `server.tool` or `server.*` and match the ref after the `mcp.` prefix.
   * Only enable for tools the operator knows are read-only; cached MCP
   * annotations with destructiveHint=true always refuse.
   */
  mcpAllowlist: string[];
}

export interface RaftModelsConfig {
  /** Alias name → ordered provider/model fallback chain, first available wins. */
  aliases: Record<string, string[]>;
}

export interface RaftConfig {
  execution: { executor: RaftExecutorConfig };
  tools: { mcp: RaftMcpConfig };
  safety: { approvals: RaftApprovalConfig; toolRisks: RaftToolRiskOverrides };
  agents: RaftAgentConfig;
  models: RaftModelsConfig;
  components: RaftComponentEntry[];
  appearance: { ui: RaftUiConfig; codePreview: CodePreviewSettings };
  lifecycle: { compaction: RaftCompactionConfig; retention: RaftRetentionConfig };
  memory: RaftMemoryConfig;
  speculation: RaftSpeculationConfig;
}

/** Hard implementation maximum for any executor deadline. Policy ceilings
 * (executor.maxTimeoutMs) may be raised up to this value by administrators. */
export const MAX_EXECUTOR_TIMEOUT_MS = 24 * 3_600_000;

export const MIN_AGENT_TIMEOUT_MS = 1_000;
const DEFAULT_AGENT_TIMEOUT_MS = 3_600_000;
export const MAX_AGENT_TIMEOUT_MS = 24 * 3_600_000;
export const QUICKJS_MAX_MEMORY_LIMIT_BYTES = 0xffff_ffff;
export const MAX_EXECUTOR_MEMORY_LIMIT_BYTES = Math.max(
  8 * 1024 * 1024,
  Math.min(Number.MAX_SAFE_INTEGER, Math.floor(os.totalmem())),
);

export const maxExecutorMemoryLimitBytes = (
  runtime: RaftExecutorRuntime,
  kernel: RaftKernel = "typescript",
): number =>
  kernel === "typescript" && runtime === "quickjs"
    ? Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES)
    : MAX_EXECUTOR_MEMORY_LIMIT_BYTES;

export const DEFAULT_RAFT_CONFIG: RaftConfig = {
  execution: {
    executor: {
      kernel: "typescript",
      pythonRuntime: "monty",
      cpython: { binary: "python3" },
      runtime: "quickjs",
      timeoutMs: 120_000,
      maxTimeoutMs: 900_000,
      hostCallTimeouts: {},
      memoryLimitBytes: 64 * 1024 * 1024,
      maxOutputChars: 50_000,
      maxNestedResultChars: 2_000_000,
      resultFormat: "auto",
    },
  },
  tools: {
    mcp: {
      enabled: true,
      disableOAuth: true,
      allowDynamicServers: true,
      callTimeoutMs: 120_000,
      cache: { enabled: true, revalidate: "changed", revalidateBudgetMs: 60_000 },
    },
  },
  safety: {
    approvals: {
      read: "allow",
      write: "allow",
      execute: "allow",
      network: "allow",
      agent: "allow",
    },
    toolRisks: {},
  },
  appearance: {
    ui: {
      enabled: true,
      widget: "auto",
      maxRows: 6,
      refreshMs: 500,
      eventHistory: 80,
      haltOnEscape: true,
      showAgentToolPreview: true,
      toolDisplay: "compact",
      updateDebounceMs: 100,
    },
    codePreview: defaultCodePreviewSettings(),
  },
  lifecycle: {
    compaction: { engine: "raft", targetContextRatio: 0.65, thresholds: {}, tokenThresholds: {} },
    retention: { orphanedTempRunMs: 6 * 60 * 60 * 1_000, oneShotRunMs: 24 * 60 * 60 * 1_000 },
  },
  agents: {
    enabled: true,
    runner: "pi",
    transport: "process",
    claude: { binary: "claude" },
    thinking: DEFAULT_RAFT_THINKING,
    maxConcurrent: 4,
    maxPerExecution: 100,
    maxDepth: 2,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    extensions: true,
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    excludeTools: [],
    retainRuns: false,
    notifyOnComplete: true,
    budgetUsd: 0,
    maxTokensPerChild: 0,
    sessionExport: true,
    sessionExportDir: "",
  },
  components: [],
  models: { aliases: {} },
  memory: {
    enabled: true,
    maxSessions: 500,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
    hotSessions: 50,
    digestTerms: 200,
    maxColdVocabularyBytes: 512 * 1024,
    maxColdCacheBytes: 1024 * 1024,
    maxSyncSessions: 10_000,
    maxSyncSourceBytes: 512 * 1024 * 1024,
    maxCacheCleanupFiles: 100_000,
    regexMaxPatternBytes: 1_024,
    regexMaxHaystackTerms: 20_000,
    regexMaxHaystackBytes: 2 * 1024 * 1024,
    regexTimeoutMs: 250,
  },
  speculation: {
    enabled: true,
    maxConcurrent: 4,
    maxEntries: 64,
    maxBufferBytes: 2 * 1024 * 1024,
    entryTtlMs: 180_000,
    mcpAllowlist: [],
  },
};

interface JsonObjectFile {
  document: Record<string, unknown>;
  source: string;
}

const readJsonObjectFile = (filePath: string): JsonObjectFile | undefined => {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration root must be an object");
    }
    return { document: parsed as Record<string, unknown>, source };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${filePath}: ${message}`, { cause: error });
  }
};

const readJsonObject = (filePath: string): Record<string, unknown> | undefined =>
  readJsonObjectFile(filePath)?.document;

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    if (
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const approvalMode = (value: unknown, fallback: RaftApprovalMode): RaftApprovalMode =>
  value === "allow" || value === "ask" || value === "auto" || value === "deny" ? value : fallback;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const boundedFloat = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const runnerValue = (value: unknown, fallback: RaftAgentRunner): RaftAgentRunner =>
  value === "pi" || value === "claude" ? value : fallback;

const transportValue = (value: unknown, fallback: RaftAgentTransport): RaftAgentTransport =>
  value === "auto" ||
  value === "process" ||
  value === "tmux" ||
  value === "screen" ||
  value === "localterm" ||
  value === "herdr"
    ? value
    : fallback;

const thinkingValue = (value: unknown, fallback: RaftThinking): RaftThinking =>
  isRaftThinking(value) ? value : fallback;

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const normalizeToolRisks = (value: unknown): RaftToolRiskOverrides => {
  const normalized: Array<[string, RaftRisk]> = [];
  for (const [ref, risk] of Object.entries(objectValue(value))) {
    const normalizedRef = normalizeToolRiskRef(ref);
    if (!normalizedRef || !isRaftRisk(risk)) continue;
    normalized.push([normalizedRef, risk]);
    if (normalized.length === 256) break;
  }
  return Object.fromEntries(normalized);
};

/**
 * A null-valued tool risk override is the settings UI's delete marker: the merge
 * cannot drop a key, so clearing a row writes null and this prunes it before the
 * document reaches disk.
 */
const pruneClearedToolRisks = (document: Record<string, unknown>): void => {
  const safety = document.safety;
  if (typeof safety !== "object" || safety === null || Array.isArray(safety)) return;
  const toolRisks = (safety as Record<string, unknown>).toolRisks;
  if (typeof toolRisks !== "object" || toolRisks === null || Array.isArray(toolRisks)) {
    return;
  }
  for (const [ref, risk] of Object.entries(toolRisks)) {
    if (risk === null) delete (toolRisks as Record<string, unknown>)[ref];
  }
};

const widgetModeValue = (value: unknown, fallback: RaftUiWidgetMode): RaftUiWidgetMode =>
  value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const toolDisplayModeValue = (
  value: unknown,
  fallback: RaftToolDisplayMode,
): RaftToolDisplayMode => (value === "full" || value === "compact" ? value : fallback);

const executorKernelValue = (value: unknown, fallback: RaftKernel): RaftKernel =>
  value === "typescript" || value === "python" ? value : fallback;

const executorRuntimeValue = (
  value: unknown,
  fallback: RaftExecutorRuntime,
): RaftExecutorRuntime =>
  value === "quickjs" || value === "node-process" || value === "bun-process" ? value : fallback;

const resultFormatValue = (value: unknown, fallback: RaftResultFormat): RaftResultFormat =>
  value === "auto" || value === "yaml" || value === "json" || value === "text" ? value : fallback;

const compactionEngineValue = (
  value: unknown,
  fallback: RaftCompactionEngine,
): RaftCompactionEngine => (value === "pi" || value === "raft" ? value : fallback);

const mcpRevalidatePolicyValue = (
  value: unknown,
  fallback: RaftMcpRevalidatePolicy,
): RaftMcpRevalidatePolicy =>
  value === "changed" || value === "all" || value === "off" ? value : fallback;

export const normalizeRaftConfig = (input: Record<string, unknown>): RaftConfig => {
  const execution = objectValue(input.execution);
  const executor = objectValue(execution.executor);
  const cpython = objectValue(executor.cpython);
  const executorKernel = executorKernelValue(
    executor.kernel,
    DEFAULT_RAFT_CONFIG.execution.executor.kernel,
  );
  const executorMaxTimeoutMs = boundedInteger(
    executor.maxTimeoutMs,
    DEFAULT_RAFT_CONFIG.execution.executor.maxTimeoutMs,
    1_000,
    MAX_EXECUTOR_TIMEOUT_MS,
  );
  const tools = objectValue(input.tools);
  const safety = objectValue(input.safety);
  const approvals = objectValue(safety.approvals);
  const mcp = objectValue(tools.mcp);
  const mcpCache = objectValue(mcp.cache);
  const agents = objectValue(input.agents);
  const claude = objectValue(agents.claude);
  const appearance = objectValue(input.appearance);
  // Existing versioned migrations retain top-level ui keys; read them while loading,
  // without writing a new migration or changing the current nested schema.
  const ui = objectValue(appearance.ui ?? input.ui);
  const lifecycle = objectValue(input.lifecycle);
  const compaction = objectValue(lifecycle.compaction);
  const retention = objectValue(lifecycle.retention);
  const memory = objectValue(input.memory);
  const modelsSection = objectValue(input.models);
  const speculation = objectValue(input.speculation);
  const configuredExecutorRuntime = executorRuntimeValue(
    executor.runtime,
    DEFAULT_RAFT_CONFIG.execution.executor.runtime,
  );
  const executorRuntime = configuredExecutorRuntime;
  const configuredTools = Array.isArray(agents.defaultTools)
    ? agents.defaultTools.filter(
        (tool): tool is string => typeof tool === "string" && Boolean(tool),
      )
    : DEFAULT_RAFT_CONFIG.agents.defaultTools;
  const configuredExcludedTools = Array.isArray(agents.excludeTools)
    ? agents.excludeTools.filter(
        (tool): tool is string => typeof tool === "string" && Boolean(tool),
      )
    : DEFAULT_RAFT_CONFIG.agents.excludeTools;
  const approvalModel = stringValue(approvals.model);
  const configPath = stringValue(mcp.configPath);
  const memoryIndexDir = stringValue(memory.indexDir);
  const compactionThresholds = Object.fromEntries(
    Object.entries(objectValue(compaction.thresholds))
      .filter(
        ([model, threshold]) =>
          model.includes("/") && typeof threshold === "number" && Number.isFinite(threshold),
      )
      .map(([model, threshold]) => [model, clampCompactionRatioThreshold(threshold as number)]),
  );
  const compactionTokenThresholds = Object.fromEntries(
    Object.entries(objectValue(compaction.tokenThresholds))
      .filter(
        ([model, tokens]) =>
          model.includes("/") && typeof tokens === "number" && Number.isFinite(tokens),
      )
      .map(([model, tokens]) => [model, clampCompactionTokenThreshold(tokens as number)]),
  );
  const agentModel = stringValue(agents.model);
  const claudeBinary = stringValue(claude.binary);
  const claudeModel = stringValue(claude.model);
  const agentThinking = thinkingValue(agents.thinking, DEFAULT_RAFT_CONFIG.agents.thinking);
  const configuredComponents: RaftComponentEntry[] = Array.isArray(input.components)
    ? input.components
        .flatMap((raw) => {
          const componentEntry = objectValue(raw);
          const id = stringValue(componentEntry.id);
          const component = stringValue(componentEntry.component);
          if (!id || !component) return [];
          return [
            {
              id,
              component,
              ...(Object.prototype.hasOwnProperty.call(componentEntry, "config")
                ? { config: componentEntry.config }
                : {}),
              ...(typeof componentEntry.disabled === "boolean"
                ? { disabled: componentEntry.disabled }
                : {}),
            },
          ];
        })
        .slice(0, 256)
    : DEFAULT_RAFT_CONFIG.components;

  return {
    execution: {
      executor: {
        kernel: executorKernel,
        pythonRuntime: executor.pythonRuntime === "cpython" ? "cpython" : "monty",
        cpython: {
          binary:
            stringValue(cpython.binary)?.trim() ??
            DEFAULT_RAFT_CONFIG.execution.executor.cpython.binary,
        },
        runtime: executorRuntime,
        maxTimeoutMs: boundedInteger(
          executor.maxTimeoutMs,
          DEFAULT_RAFT_CONFIG.execution.executor.maxTimeoutMs,
          1_000,
          MAX_EXECUTOR_TIMEOUT_MS,
        ),
        hostCallTimeouts: Object.fromEntries(
          Object.entries(objectValue(executor.hostCallTimeouts))
            .filter(
              ([ref, value]) =>
                typeof ref === "string" &&
                Boolean(ref.trim()) &&
                typeof value === "number" &&
                Number.isFinite(value) &&
                value >= 1,
            )
            .map(([ref, value]) => [
              ref,
              boundedInteger(value, 1_000, 1_000, executorMaxTimeoutMs),
            ]),
        ),
        timeoutMs: boundedInteger(
          executor.timeoutMs,
          DEFAULT_RAFT_CONFIG.execution.executor.timeoutMs,
          1_000,
          executorMaxTimeoutMs,
        ),
        memoryLimitBytes: boundedInteger(
          executor.memoryLimitBytes,
          DEFAULT_RAFT_CONFIG.execution.executor.memoryLimitBytes,
          8 * 1024 * 1024,
          maxExecutorMemoryLimitBytes(executorRuntime, executorKernel),
        ),
        maxOutputChars: boundedInteger(
          executor.maxOutputChars,
          DEFAULT_RAFT_CONFIG.execution.executor.maxOutputChars,
          1_000,
          1_000_000,
        ),
        maxNestedResultChars: boundedInteger(
          executor.maxNestedResultChars,
          DEFAULT_RAFT_CONFIG.execution.executor.maxNestedResultChars,
          10_000,
          20_000_000,
        ),
        resultFormat: resultFormatValue(
          executor.resultFormat,
          DEFAULT_RAFT_CONFIG.execution.executor.resultFormat,
        ),
      },
    },
    tools: {
      mcp: {
        enabled: booleanValue(mcp.enabled, DEFAULT_RAFT_CONFIG.tools.mcp.enabled),
        ...(configPath ? { configPath } : {}),
        disableOAuth: booleanValue(mcp.disableOAuth, DEFAULT_RAFT_CONFIG.tools.mcp.disableOAuth),
        allowDynamicServers: booleanValue(
          mcp.allowDynamicServers,
          DEFAULT_RAFT_CONFIG.tools.mcp.allowDynamicServers,
        ),
        callTimeoutMs: boundedInteger(
          mcp.callTimeoutMs,
          DEFAULT_RAFT_CONFIG.tools.mcp.callTimeoutMs,
          1_000,
          900_000,
        ),
        cache: {
          enabled: booleanValue(mcpCache.enabled, DEFAULT_RAFT_CONFIG.tools.mcp.cache.enabled),
          revalidate: mcpRevalidatePolicyValue(
            mcpCache.revalidate,
            DEFAULT_RAFT_CONFIG.tools.mcp.cache.revalidate,
          ),
          revalidateBudgetMs: boundedInteger(
            mcpCache.revalidateBudgetMs,
            DEFAULT_RAFT_CONFIG.tools.mcp.cache.revalidateBudgetMs,
            1_000,
            600_000,
          ),
        },
      },
    },
    safety: {
      approvals: {
        read: approvalMode(approvals.read, DEFAULT_RAFT_CONFIG.safety.approvals.read),
        write: approvalMode(approvals.write, DEFAULT_RAFT_CONFIG.safety.approvals.write),
        execute: approvalMode(approvals.execute, DEFAULT_RAFT_CONFIG.safety.approvals.execute),
        network: approvalMode(approvals.network, DEFAULT_RAFT_CONFIG.safety.approvals.network),
        agent: approvalMode(approvals.agent, DEFAULT_RAFT_CONFIG.safety.approvals.agent),
        ...(approvalModel ? { model: approvalModel } : {}),
      },
      toolRisks: normalizeToolRisks(safety.toolRisks),
    },
    appearance: {
      ui: {
        enabled: booleanValue(ui.enabled, DEFAULT_RAFT_CONFIG.appearance.ui.enabled),
        widget: widgetModeValue(ui.widget, DEFAULT_RAFT_CONFIG.appearance.ui.widget),
        maxRows: boundedInteger(ui.maxRows, DEFAULT_RAFT_CONFIG.appearance.ui.maxRows, 1, 20),
        refreshMs: boundedInteger(
          ui.refreshMs,
          DEFAULT_RAFT_CONFIG.appearance.ui.refreshMs,
          100,
          10_000,
        ),
        eventHistory: boundedInteger(
          ui.eventHistory,
          DEFAULT_RAFT_CONFIG.appearance.ui.eventHistory,
          1,
          500,
        ),
        haltOnEscape: booleanValue(ui.haltOnEscape, DEFAULT_RAFT_CONFIG.appearance.ui.haltOnEscape),
        // Renamed from ui.showNestedToolCalls; the v2 migration rewrites persisted
        // files, and this fallback covers configs normalized without migration.
        showAgentToolPreview: booleanValue(
          ui.showAgentToolPreview ?? ui.showNestedToolCalls,
          DEFAULT_RAFT_CONFIG.appearance.ui.showAgentToolPreview,
        ),
        toolDisplay: toolDisplayModeValue(
          ui.toolDisplay,
          DEFAULT_RAFT_CONFIG.appearance.ui.toolDisplay,
        ),
        // Renamed from ui.nestedToolDebounceMs (v3): the window coalesces every
        // live raft_exec card update — nested calls, progress, agent previews.
        updateDebounceMs: boundedInteger(
          ui.updateDebounceMs ?? ui.nestedToolDebounceMs,
          DEFAULT_RAFT_CONFIG.appearance.ui.updateDebounceMs,
          0,
          2_000,
        ),
      },
      codePreview: normalizeCodePreviewSettings(appearance.codePreview),
    },
    lifecycle: {
      compaction: {
        engine: compactionEngineValue(
          compaction.engine,
          DEFAULT_RAFT_CONFIG.lifecycle.compaction.engine,
        ),
        targetContextRatio: boundedFloat(
          compaction.targetContextRatio,
          DEFAULT_RAFT_CONFIG.lifecycle.compaction.targetContextRatio,
          0.25,
          0.85,
        ),
        thresholds: compactionThresholds,
        tokenThresholds: compactionTokenThresholds,
      },
      retention: {
        orphanedTempRunMs: boundedInteger(
          retention.orphanedTempRunMs,
          DEFAULT_RAFT_CONFIG.lifecycle.retention.orphanedTempRunMs,
          60 * 60 * 1_000,
          365 * 24 * 60 * 60 * 1_000,
        ),
        oneShotRunMs: boundedInteger(
          retention.oneShotRunMs,
          DEFAULT_RAFT_CONFIG.lifecycle.retention.oneShotRunMs,
          60 * 60 * 1_000,
          365 * 24 * 60 * 60 * 1_000,
        ),
      },
    },
    agents: {
      enabled: booleanValue(agents.enabled, DEFAULT_RAFT_CONFIG.agents.enabled),
      runner: runnerValue(agents.runner, DEFAULT_RAFT_CONFIG.agents.runner),
      transport: transportValue(agents.transport, DEFAULT_RAFT_CONFIG.agents.transport),
      ...(agentModel ? { model: agentModel } : {}),
      claude: {
        binary: claudeBinary ?? DEFAULT_RAFT_CONFIG.agents.claude.binary,
        ...(claudeModel ? { model: claudeModel } : {}),
      },
      thinking: agentThinking,
      maxConcurrent: boundedInteger(
        agents.maxConcurrent,
        DEFAULT_RAFT_CONFIG.agents.maxConcurrent,
        1,
        32,
      ),
      maxPerExecution: boundedInteger(
        agents.maxPerExecution,
        DEFAULT_RAFT_CONFIG.agents.maxPerExecution,
        1,
        1_000,
      ),
      maxDepth: boundedInteger(
        agents.maxDepth,
        DEFAULT_RAFT_CONFIG.agents.maxDepth,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      timeoutMs: boundedInteger(
        agents.timeoutMs,
        DEFAULT_RAFT_CONFIG.agents.timeoutMs,
        MIN_AGENT_TIMEOUT_MS,
        MAX_AGENT_TIMEOUT_MS,
      ),
      extensions: booleanValue(agents.extensions, DEFAULT_RAFT_CONFIG.agents.extensions),
      defaultTools: configuredTools,
      excludeTools: configuredExcludedTools,
      retainRuns: booleanValue(agents.retainRuns, DEFAULT_RAFT_CONFIG.agents.retainRuns),
      notifyOnComplete: booleanValue(
        agents.notifyOnComplete,
        DEFAULT_RAFT_CONFIG.agents.notifyOnComplete,
      ),
      budgetUsd: boundedFloat(agents.budgetUsd, DEFAULT_RAFT_CONFIG.agents.budgetUsd, 0, 1_000_000),
      maxTokensPerChild: boundedInteger(
        agents.maxTokensPerChild,
        DEFAULT_RAFT_CONFIG.agents.maxTokensPerChild,
        0,
        100_000_000,
      ),
      sessionExport: booleanValue(agents.sessionExport, DEFAULT_RAFT_CONFIG.agents.sessionExport),
      sessionExportDir:
        typeof agents.sessionExportDir === "string"
          ? agents.sessionExportDir
          : DEFAULT_RAFT_CONFIG.agents.sessionExportDir,
    },
    components: configuredComponents.map((entry) => structuredClone(entry)),
    models: { aliases: normalizeModelAliases(modelsSection.aliases) },
    memory: {
      enabled: booleanValue(memory.enabled, DEFAULT_RAFT_CONFIG.memory.enabled),
      ...(memoryIndexDir ? { indexDir: memoryIndexDir } : {}),
      maxSessions: boundedInteger(
        memory.maxSessions,
        DEFAULT_RAFT_CONFIG.memory.maxSessions,
        1,
        100_000,
      ),
      maxEntryChars: boundedInteger(
        memory.maxEntryChars,
        DEFAULT_RAFT_CONFIG.memory.maxEntryChars,
        100,
        1_000_000,
      ),
      indexThinking: booleanValue(
        memory.indexThinking,
        DEFAULT_RAFT_CONFIG.memory.indexThinking ?? false,
      ),
      indexToolOutput: booleanValue(
        memory.indexToolOutput,
        DEFAULT_RAFT_CONFIG.memory.indexToolOutput ?? true,
      ),
      hotSessions: boundedInteger(
        memory.hotSessions,
        DEFAULT_RAFT_CONFIG.memory.hotSessions ?? 50,
        0,
        100_000,
      ),
      digestTerms: boundedInteger(
        memory.digestTerms,
        DEFAULT_RAFT_CONFIG.memory.digestTerms ?? 200,
        1,
        10_000,
      ),
      maxColdVocabularyBytes: boundedInteger(
        memory.maxColdVocabularyBytes,
        DEFAULT_RAFT_CONFIG.memory.maxColdVocabularyBytes ?? 512 * 1024,
        2,
        64 * 1024 * 1024,
      ),
      maxColdCacheBytes: boundedInteger(
        memory.maxColdCacheBytes,
        DEFAULT_RAFT_CONFIG.memory.maxColdCacheBytes ?? 1024 * 1024,
        512,
        128 * 1024 * 1024,
      ),
      maxSyncSessions: boundedInteger(
        memory.maxSyncSessions,
        DEFAULT_RAFT_CONFIG.memory.maxSyncSessions ?? 10_000,
        1,
        1_000_000,
      ),
      maxSyncSourceBytes: boundedInteger(
        memory.maxSyncSourceBytes,
        DEFAULT_RAFT_CONFIG.memory.maxSyncSourceBytes ?? 512 * 1024 * 1024,
        1_024,
        8 * 1024 * 1024 * 1024,
      ),
      maxCacheCleanupFiles: boundedInteger(
        memory.maxCacheCleanupFiles,
        DEFAULT_RAFT_CONFIG.memory.maxCacheCleanupFiles ?? 100_000,
        1,
        1_000_000,
      ),
      regexMaxPatternBytes: boundedInteger(
        memory.regexMaxPatternBytes,
        DEFAULT_RAFT_CONFIG.memory.regexMaxPatternBytes ?? 1_024,
        1,
        64 * 1024,
      ),
      regexMaxHaystackTerms: boundedInteger(
        memory.regexMaxHaystackTerms,
        DEFAULT_RAFT_CONFIG.memory.regexMaxHaystackTerms ?? 20_000,
        1,
        1_000_000,
      ),
      regexMaxHaystackBytes: boundedInteger(
        memory.regexMaxHaystackBytes,
        DEFAULT_RAFT_CONFIG.memory.regexMaxHaystackBytes ?? 2 * 1024 * 1024,
        1_024,
        128 * 1024 * 1024,
      ),
      regexTimeoutMs: boundedInteger(
        memory.regexTimeoutMs,
        DEFAULT_RAFT_CONFIG.memory.regexTimeoutMs ?? 250,
        10,
        10_000,
      ),
    },
    speculation: {
      enabled: booleanValue(speculation.enabled, DEFAULT_RAFT_CONFIG.speculation.enabled),
      maxConcurrent: boundedInteger(
        speculation.maxConcurrent,
        DEFAULT_RAFT_CONFIG.speculation.maxConcurrent,
        1,
        32,
      ),
      maxEntries: boundedInteger(
        speculation.maxEntries,
        DEFAULT_RAFT_CONFIG.speculation.maxEntries,
        1,
        1_024,
      ),
      maxBufferBytes: boundedInteger(
        speculation.maxBufferBytes,
        DEFAULT_RAFT_CONFIG.speculation.maxBufferBytes,
        64 * 1024,
        64 * 1024 * 1024,
      ),
      entryTtlMs: boundedInteger(
        speculation.entryTtlMs,
        DEFAULT_RAFT_CONFIG.speculation.entryTtlMs,
        5_000,
        30 * 60_000,
      ),
      mcpAllowlist: [
        ...new Set(
          (Array.isArray(speculation.mcpAllowlist) ? speculation.mcpAllowlist : [])
            .filter(
              (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
            )
            .map((entry) => entry.trim().slice(0, 256)),
        ),
      ].slice(0, 256),
    },
  };
};

interface RaftConfigFilePlan {
  path: string;
  document: Record<string, unknown>;
  source: string;
  changed: boolean;
}

const planConfigFile = (filePath: string): RaftConfigFilePlan | undefined => {
  const input = readJsonObjectFile(filePath);
  if (!input) return undefined;
  const migration = migrateRaftConfigDocument(input.document);
  return {
    path: filePath,
    document: migration.document,
    source: input.source,
    changed: migration.changed,
  };
};

const writeJsonAtomic = (
  filePath: string,
  document: Record<string, unknown>,
  expectedSource: string | null,
): void => {
  const resolvedPath = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const directory = path.dirname(resolvedPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const mode = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).mode & 0o777 : 0o600;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (expectedSource === null) {
      if (fs.existsSync(resolvedPath)) {
        throw new Error(`Raft configuration changed while updating ${filePath}`);
      }
    } else {
      let currentSource: string;
      try {
        currentSource = fs.readFileSync(resolvedPath, "utf8");
      } catch (error) {
        throw new Error(`Raft configuration changed while updating ${filePath}`, { cause: error });
      }
      if (currentSource !== expectedSource) {
        throw new Error(`Raft configuration changed while updating ${filePath}`);
      }
    }
    renameAtomic(temporaryPath, resolvedPath);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM")
        throw error;
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

const resolveRaftConfig = (
  options: { cwd: string; agentDir: string },
  includeProject: boolean,
  applyEnvironmentOverrides: boolean,
): RaftConfig => {
  let merged = structuredClone(DEFAULT_RAFT_CONFIG) as RaftConfig;
  const plans = [
    planConfigFile(path.join(options.agentDir, "raft.json")),
    ...(includeProject ? [planConfigFile(path.join(options.cwd, ".pi", "raft.json"))] : []),
  ].filter((plan): plan is RaftConfigFilePlan => plan !== undefined);
  for (const plan of plans) {
    if (plan.changed) writeJsonAtomic(plan.path, plan.document, plan.source);
    // Legacy migrations keep top-level ui on disk; fold it into the runtime
    // shape without rewriting the document as a new migration.
    const legacyUi = objectValue(plan.document.ui);
    const persistedAppearance = objectValue(plan.document.appearance);
    const documentForMerge =
      Object.keys(legacyUi).length === 0
        ? plan.document
        : {
            ...plan.document,
            appearance: {
              ...persistedAppearance,
              ui: { ...legacyUi, ...objectValue(persistedAppearance.ui) },
            },
          };
    merged = mergeObjects(
      merged as unknown as Record<string, unknown>,
      documentForMerge,
    ) as unknown as RaftConfig;
  }
  const inheritedKernel = process.env.PI_RAFT_KERNEL;
  if (applyEnvironmentOverrides && inheritedKernel !== undefined) {
    // This can select trusted native execution: never repair an unsafe selector.
    if (inheritedKernel !== "typescript" && inheritedKernel !== "python") {
      throw new Error(`Invalid PI_RAFT_KERNEL: ${inheritedKernel}; expected typescript or python`);
    }
    merged.execution.executor = { ...merged.execution.executor, kernel: inheritedKernel };
  }
  const inheritedPythonRuntime = process.env.PI_RAFT_PYTHON_RUNTIME;
  if (applyEnvironmentOverrides && inheritedPythonRuntime !== undefined) {
    if (inheritedPythonRuntime !== "cpython" && inheritedPythonRuntime !== "monty") {
      throw new Error(
        `Invalid PI_RAFT_PYTHON_RUNTIME: ${inheritedPythonRuntime}; expected cpython or monty`,
      );
    }
    merged.execution.executor = {
      ...merged.execution.executor,
      pythonRuntime: inheritedPythonRuntime,
    };
  }
  return normalizeRaftConfig(merged as unknown as Record<string, unknown>);
};

export const loadRaftConfigForScope = (
  options: { cwd: string; agentDir: string; projectTrusted: boolean },
  scope: RaftConfigScope,
): RaftConfig => {
  if (scope === "project" && !options.projectTrusted) {
    throw new Error("Cannot load project Raft configuration for an untrusted project");
  }
  return resolveRaftConfig(options, scope === "project", false);
};

export const loadRaftConfig = (options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): RaftConfig => {
  const config = resolveRaftConfig(options, options.projectTrusted, true);
  if (config.lifecycle.compaction.engine === "raft") {
    process.env.PI_RAFT_COMPACTION_ENGINE = "raft";
  } else {
    delete process.env.PI_RAFT_COMPACTION_ENGINE;
  }
  return config;
};

export const saveRaftConfig = (
  options: { cwd: string; agentDir: string; projectTrusted: boolean; scope?: RaftConfigScope },
  partial: Record<string, unknown>,
): { scope: RaftConfigScope; path: string } => {
  const scope = options.scope ?? (options.projectTrusted ? "project" : "global");
  if (scope === "project" && !options.projectTrusted) {
    throw new Error("Cannot save project Raft configuration for an untrusted project");
  }
  const targetPath =
    scope === "project"
      ? path.join(options.cwd, ".pi", "raft.json")
      : path.join(options.agentDir, "raft.json");
  if (Object.hasOwn(partial, "configVersion") || Object.hasOwn(partial, "subagents")) {
    throw new Error("Raft configuration updates must use the current schema");
  }
  const input = readJsonObjectFile(targetPath);
  const existing = migrateRaftConfigDocument(input?.document ?? {}).document;
  const merged = mergeObjects(existing, partial) as Record<string, unknown>;
  // Never stamp down: preserve version markers written by newer builds.
  merged.configVersion = Math.max(
    typeof merged.configVersion === "number" ? merged.configVersion : 0,
    CURRENT_RAFT_CONFIG_VERSION,
  );
  writeJsonAtomic(targetPath, merged, input?.source ?? null);
  return { scope, path: targetPath };
};
