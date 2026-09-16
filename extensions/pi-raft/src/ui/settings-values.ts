import {
  MIN_COMPACTION_RATIO_THRESHOLD,
  MAX_COMPACTION_RATIO_THRESHOLD,
  clampCompactionRatioThreshold,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  type RaftConfig,
  clampCompactionTokenThreshold,
} from "../config.js";
import { INHERIT_VALUE } from "./model-picker.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";

import {
  CHILD_CORE_TOOLS,
  extensionToolCandidates,
  shadowedCoreTools,
} from "../agents/child-tools.js";
import { defaultToolRisk, isRaftRisk, normalizeToolRiskRef } from "../core/tool-risk.js";
import type { RaftRisk } from "../protocol.js";
export const BOOLEANS = ["true", "false"] as const;
export const APPROVAL_MODES = ["allow", "ask", "auto", "deny"] as const;
export const RUNNERS = ["pi", "claude"] as const;
export const TRANSPORTS = ["auto", "process", "tmux", "screen", "localterm", "herdr"] as const;
export const WIDGET_MODES = ["auto", "always", "hidden"] as const;
export const TOOL_DISPLAY_MODES = ["full", "compact"] as const;
export const RISK_CLASSES = ["read", "write", "execute", "network", "agent"] as const;
export const RISK_CLASS_DESCRIPTIONS: Record<RaftRisk, string> = {
  read: "Inspection with no side effects",
  write: "Creates or modifies stored state",
  execute: "Runs commands or processes",
  network: "Reaches services outside this machine",
  agent: "Spawns or controls child agents",
};
const TOOL_RISK_ORIGINS: Readonly<Record<string, string>> = {
  pi: "Pi core tool",
  extensions: "Extension tool",
  mcp: "MCP action",
  raft: "Raft action",
};
export const TOOL_RISK_OVERRIDES_SETTING_ID = "safety.toolRisks";
export const TOOL_RISK_ADD_SETTING_ID = "safety.toolRisks.add";
export const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
export const EXECUTOR_KERNELS = ["typescript", "python"] as const;
export const PYTHON_RUNTIMES = ["monty", "cpython"] as const;
export const EXECUTOR_RUNTIMES = ["quickjs", "node-process", "bun-process"] as const;
export const COMPACTION_ENGINES = ["raft", "pi"] as const;
export const COMPACTION_THRESHOLD_SETTING_ID = "lifecycle.compaction.threshold";
export const COMPACTION_DEFAULT_THRESHOLD_LABEL = "Pi default";
export const COMPACTION_PERCENT_OPTION_LABEL = "Custom percent…";
export const COMPACTION_TOKENS_OPTION_LABEL = "Custom tokens…";
export const COMPACTION_PERCENT_MIN = Math.round(MIN_COMPACTION_RATIO_THRESHOLD * 100);
export const COMPACTION_PERCENT_MAX = Math.round(MAX_COMPACTION_RATIO_THRESHOLD * 100);
export const clampCompactionPercentThreshold = (value: number): number =>
  Math.round(clampCompactionRatioThreshold(value / 100) * 100);

export const COMPACTION_TARGET_RATIOS = Array.from({ length: 13 }, (_, index) =>
  String((25 + index * 5) / 100),
);

export const DIFF_INTENSITIES = ["off", "subtle", "medium"] as const;
export const WORD_EMPHASES = ["all", "smart", "off"] as const;
export const TOOL_CALL_BACKGROUNDS = ["on", "border", "off"] as const;
export const PATH_ICON_MODES = ["unicode", "nerd", "off"] as const;
export const CODE_PREVIEW_EDIT_LINES_ID = "appearance.codePreview.editCollapsedLines";
export const CODE_PREVIEW_ALL_LINES = "All lines";
export const SHIKI_THEME_PRESETS = [
  "auto",
  "github-light/github-dark",
  "light-plus/dark-plus",
  "solarized-light/solarized-dark",
  "catppuccin-latte/catppuccin-mocha",
  "github-light",
  "light-plus",
  "solarized-light",
  "dark-plus",
  "github-dark",
  "solarized-dark",
  "nord",
  "one-dark-pro",
] as const;

export const BUDGET_VALUES = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
export const TOKEN_VALUES = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
export const unique = (values: readonly string[]): string[] => [...new Set(values)];
export const formatDebounce = (ms: number): string =>
  ms === 0 ? "Off" : ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;

export const formatMs = (ms: number): string =>
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${ms / 1_000}s`
      : ms < 3_600_000
        ? `${ms / 60_000}m`
        : `${ms / 3_600_000}h`;

export const formatRetention = (ms: number): string =>
  ms >= 24 * 60 * 60 * 1_000 && ms % (24 * 60 * 60 * 1_000) === 0
    ? `${ms / (24 * 60 * 60 * 1_000)}d`
    : formatMs(ms);

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${Number((bytes / (1024 * 1024 * 1024)).toFixed(2))} GB`
    : bytes >= 1024 * 1024
      ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`
      : `${Number((bytes / 1024).toFixed(2))} KB`;

export const executorMemoryLimitOptions = (
  maximumBytes = QUICKJS_MAX_MEMORY_LIMIT_BYTES,
): number[] => {
  const minimumBytes = 16 * 1024 * 1024;
  const values: number[] = [];
  for (let value = minimumBytes; value <= maximumBytes; value *= 2) values.push(value);
  if (maximumBytes >= minimumBytes && values.at(-1) !== maximumBytes) values.push(maximumBytes);
  return values;
};

export const formatUsd = (value: number): string => (value <= 0 ? "Off" : `$${value.toFixed(2)}`);

export const formatTokens = (value: number): string =>
  value <= 0
    ? "Off"
    : value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value >= 1_000
        ? `${value / 1_000}k`
        : String(value);

export const formatToolCount = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

// Exact-ref risk overrides surface every class the runtime knows about: Pi core
// tools, loaded extension tools, and any ref already configured by hand (MCP and
// other dynamic namespaces, which the settings layer cannot enumerate).
export const toolRiskCandidateRefs = (registered: readonly string[]): string[] => [
  ...CHILD_CORE_TOOLS.map((name) => `pi.${name}`),
  ...extensionToolCandidates(registered).map((name) => `extensions.${name}`),
  ...shadowedCoreTools(registered).map((name) => `extensions.${name}`),
];

export const toolRiskRefs = (
  configured: Readonly<Record<string, string>>,
  candidates: readonly string[],
): string[] => unique([...Object.keys(configured).sort(), ...candidates]);

export const formatToolRiskSummary = (configured: Readonly<Record<string, unknown>>): string => {
  const count = Object.keys(configured).length;
  return count === 0 ? "Built-in classes" : `${count} override${count === 1 ? "" : "s"}`;
};

/** Where a ref's class comes from, for the row description. */
const toolRiskOrigin = (ref: string): string => {
  const provider = ref.slice(0, Math.max(0, ref.indexOf(".")));
  return TOOL_RISK_ORIGINS[provider] ?? `${provider} action`;
};

export const toolRiskDescription = (
  ref: string,
  overridden: boolean,
  shadowsCoreTool = false,
): string => {
  const shadow = shadowsCoreTool
    ? ` Overrides Pi core ${ref.slice(ref.indexOf(".") + 1)}; this row governs the implementation that runs.`
    : "";
  return overridden
    ? `${toolRiskOrigin(ref)}.${shadow} Overridden; its built-in class is ${defaultToolRisk(ref)}.`
    : `${toolRiskOrigin(ref)}.${shadow} Built-in class; cycle to change its approval policy.`;
};

/**
 * Settings-list rows carry their own current value, so the row set is the source
 * of truth. A row is only persisted when it differs from its built-in class;
 * cycling one back to that class writes a delete marker instead.
 */
export const toolRiskPartial = (
  rows: ReadonlyArray<{ ref: string; value: string }>,
  configured: Readonly<Record<string, unknown>> = {},
): Record<string, RaftRisk | null> => {
  const partial: Record<string, RaftRisk | null> = {};
  for (const row of rows) {
    const ref = normalizeToolRiskRef(row.ref);
    if (!ref || !isRaftRisk(row.value)) continue;
    if (row.value === defaultToolRisk(ref)) {
      if (Object.hasOwn(configured, ref)) partial[ref] = null;
      continue;
    }
    partial[ref] = row.value;
  }
  return partial;
};

export const formatToolRiskEntry = (ref: string, risk: RaftRisk): string => `${ref}=${risk}`;

export const parseToolRiskEntry = (token: string): { ref: string; risk: RaftRisk } | undefined => {
  const separator = token.lastIndexOf("=");
  if (separator <= 0) return undefined;
  const ref = normalizeToolRiskRef(token.slice(0, separator));
  const risk = token.slice(separator + 1).trim();
  if (!ref || !isRaftRisk(risk)) return undefined;
  return { ref, risk };
};
// The threshold row is a mode selection: Pi default, a window-occupancy
// percent, or an exact token count. mode: "default" clears both maps so Pi's
// built-in threshold applies.
export type CompactionThresholdSelection =
  | { mode: "default" }
  | { mode: "percent"; value: number }
  | { mode: "tokens"; value: number };

export const formatCompactionThreshold = (config: RaftConfig, modelKey: string): string => {
  const tokens = config.lifecycle.compaction.tokenThresholds[modelKey];
  if (tokens !== undefined) return `${formatTokens(tokens)} tokens`;
  const ratio = config.lifecycle.compaction.thresholds[modelKey];
  return ratio === undefined ? COMPACTION_DEFAULT_THRESHOLD_LABEL : `${Math.round(ratio * 100)}%`;
};

export const compactionThresholdPartial = (
  modelKey: string,
  selection: CompactionThresholdSelection,
): Record<string, unknown> => ({
  lifecycle: {
    compaction: {
      thresholds: { [modelKey]: selection.mode === "percent" ? selection.value : null },
      tokenThresholds: { [modelKey]: selection.mode === "tokens" ? selection.value : null },
    },
  },
});

const getPath = (config: RaftConfig, id: string): unknown => {
  const segments = id.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const parseBudgetValue = (value: string): number => {
  if (value === "Off") return 0;
  const digits = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(digits) ? digits : 0;
};

export const parseFormattedNumericValue = (value: string): number => {
  const normalized = value.trim();
  if (normalized === "Off") return 0;
  if (normalized.startsWith("$")) return parseBudgetValue(normalized);

  const bytes = normalized.match(/^([0-9]+(?:\.[0-9]+)?) (KB|MB|GB)$/);
  if (bytes) {
    const amount = Number(bytes[1]);
    const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
    return Math.round(amount * units[bytes[2] as keyof typeof units]);
  }

  const duration = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return Math.round(amount * units[duration[2] as keyof typeof units]);
  }

  const tokens = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(k|M)$/);
  if (tokens) return Math.round(Number(tokens[1]) * (tokens[2] === "M" ? 1_000_000 : 1_000));
  return Number(normalized.replaceAll(",", ""));
};

export const coerceValue = (id: string, value: string, config: RaftConfig): unknown => {
  if (id === COMPACTION_THRESHOLD_SETTING_ID) {
    if (value === COMPACTION_DEFAULT_THRESHOLD_LABEL) return { mode: "default" };
    const tokens = /^(.+?) tokens$/.exec(value);
    if (tokens?.[1] !== undefined) {
      return {
        mode: "tokens",
        value: clampCompactionTokenThreshold(parseFormattedNumericValue(tokens[1])),
      };
    }
    return { mode: "percent", value: Number(value.replace("%", "")) / 100 };
  }
  if (id === CODE_PREVIEW_EDIT_LINES_ID) {
    if (value === CODE_PREVIEW_ALL_LINES || value === "all") return "all";
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const current = getPath(config, id);
    return typeof current === "number" ? current : 160;
  }
  const current = getPath(config, id);
  if (typeof current === "boolean") return value === "true";
  if (typeof current === "number") return parseFormattedNumericValue(value);
  // The model picker stores the canonical "provider/id" string, or "Inherit"
  // for no override; persist an empty string so normalizeRaftConfig drops it.
  if (id === "safety.approvals.model" || id === "agents.model" || id === "agents.claude.model") {
    return value === INHERIT_VALUE ? "" : value;
  }
  if (id === "agents.thinking") {
    return THINKING_LEVELS.find((level) => thinkingLabel(level) === value) ?? value;
  }
  return value;
};

export const buildPartial = (id: string, value: unknown): Record<string, unknown> => {
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === undefined) break;
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
};

export const summaryFor = (id: string, config: RaftConfig): string => {
  switch (id) {
    case "lifecycle":
      return `${summaryFor("lifecycle.compaction", config)} · ${summaryFor("lifecycle.retention", config)}`;
    case "execution.executor": {
      const refFloors = Object.keys(config.execution.executor.hostCallTimeouts).length;
      const kernel =
        config.execution.executor.kernel === "python"
          ? `python · ${config.execution.executor.pythonRuntime === "monty" ? "monty" : config.execution.executor.cpython.binary}`
          : `typescript · ${config.execution.executor.runtime}`;
      return `${kernel} · ${formatMs(config.execution.executor.timeoutMs)} · max ${formatMs(config.execution.executor.maxTimeoutMs)}${refFloors > 0 ? ` · ${refFloors} ref floor${refFloors === 1 ? "" : "s"}` : ""}`;
    }
    case "safety.approvals": {
      const overrides = Object.keys(config.safety.toolRisks).length;
      return `${config.safety.approvals.execute}${overrides > 0 ? ` · ${overrides} tool risk override${overrides === 1 ? "" : "s"}` : ""}`;
    }
    case "tools.mcp":
      return config.tools.mcp.enabled ? "enabled" : "disabled";
    case "agents":
      return `${config.agents.runner}/${config.agents.transport}`;
    case "appearance.ui":
      return config.appearance.ui.widget;
    case "lifecycle.compaction":
      return config.lifecycle.compaction.engine;
    case "lifecycle.retention":
      return `${formatRetention(config.lifecycle.retention.orphanedTempRunMs)} · ${formatRetention(config.lifecycle.retention.oneShotRunMs)}`;
    case "appearance.codePreview":
      return config.appearance.codePreview.shikiTheme;
    default:
      return "";
  }
};
