import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  thinkingSubmenu,
  modelPickerSubmenu,
  listSubmenu,
  stringInputSubmenu,
  numericSubmenu,
  nonNegativeIntegerSubmenu,
} from "./settings-submenus.js";
import {
  summaryFor,
  BOOLEANS,
  formatToolCount,
  RUNNERS,
  TRANSPORTS,
  formatUsd,
  BUDGET_VALUES,
  formatTokens,
  TOKEN_VALUES,
  formatMs,
} from "./settings-values.js";
import { thinkingLabel } from "../thinking.js";
import {
  childToolPickerCandidates,
  isChildToolEnabled,
  selectionFromChecked,
} from "../agents/child-tools.js";
import { INHERIT_VALUE } from "./model-picker.js";

export const buildAgentsSection = ({
  config,
  theme,
  apply,
  options,
  persist,
}: Pick<
  SettingsSectionContext<"modelSource" | "claudeModelSource" | "extensionToolNames">,
  "config" | "theme" | "apply" | "options" | "persist"
>): SettingItem => {
  const extensionToolNames = options.extensionToolNames ?? [];
  const pickerCandidates = childToolPickerCandidates(extensionToolNames, [
    ...config.agents.defaultTools,
    ...config.agents.excludeTools,
  ]);
  const currentSelection = {
    defaultTools: config.agents.defaultTools,
    excludeTools: config.agents.excludeTools,
  };
  const enabledToolNames = pickerCandidates.filter((name) =>
    isChildToolEnabled(name, extensionToolNames, currentSelection),
  );
  const enableToolsItem = setting(
    "agents.defaultTools",
    "Enable Tools",
    formatToolCount(enabledToolNames.length),
    {
      description:
        "Pi core and loaded extension tools available to newly spawned agents. Extension tools are enabled by default; uncheck a tool to disable it. Does not affect the current session or raft_exec.",
    },
  );

  enableToolsItem.submenu = listSubmenu(
    theme,
    "agents.defaultTools",
    "Enable Tools",
    "Pi core and loaded extension tools available to newly spawned agents. Extension tools are enabled by default; uncheck a tool to disable it. Does not affect the current session or raft_exec.",
    pickerCandidates,
    enabledToolNames,
    (selected) => {
      const nextSelection = selectionFromChecked(selected, extensionToolNames, currentSelection);
      apply("agents.defaultTools", nextSelection.defaultTools);
      apply("agents.excludeTools", nextSelection.excludeTools);
      enableToolsItem.currentValue = formatToolCount(selected.length);
    },
  );

  return setting("agents", "Agents", summaryFor("agents", config), {
    description: "One-shot child agents spawned from inside raft_exec.",
    submenu: sectionSubmenu(
      theme,
      "Agents",
      "One-shot child agents spawned from inside raft_exec.",
      [
        setting("agents.enabled", "Enabled", config.agents.enabled ? "true" : "false", {
          description:
            "Master switch for starting agents. When off, every agents.run and agents.spawn call is rejected; inspecting existing runs still works.",
          values: BOOLEANS,
        }),
        setting("agents.runner", "Default runner", config.agents.runner, {
          description:
            "Execution harness used when agents.run or agents.spawn does not specify runner.",
          values: RUNNERS,
        }),
        setting("agents.transport", "Transport", config.agents.transport, {
          description: "Preferred transport for spawned agents.",
          values: TRANSPORTS,
        }),
        setting("agents.model", "Default model", config.agents.model || INHERIT_VALUE, {
          description:
            "Model forwarded to Pi-backed agents when a call does not specify one. Pick Inherit to use the host session's default. Order matches pi-model-sort (most recently used first).",
          submenu: modelPickerSubmenu(theme, options.modelSource),
        }),
        setting(
          "agents.claude.model",
          "Claude model",
          config.agents.claude.model || INHERIT_VALUE,
          {
            description:
              "Claude Code model used by Claude-backed agents. Models are enumerated from the installed claude runtime; Inherit uses Claude Code's default.",
            submenu: modelPickerSubmenu(
              theme,
              options.claudeModelSource ?? { models: [], lastUsed: {} },
              {
                headerText:
                  "Default model for Claude-backed Raft agents. Pick Inherit to use Claude Code's runtime default.",
                inheritName: "Use Claude Code's runtime default model",
              },
            ),
          },
        ),
        setting("agents.thinking", "Default thinking", thinkingLabel(config.agents.thinking), {
          description:
            "Reasoning effort forwarded to spawned agents when a call does not specify one. Clamped to each model's supported levels (next highest if unsupported).",
          submenu: thinkingSubmenu(theme),
        }),
        setting("agents.maxConcurrent", "Max concurrent", String(config.agents.maxConcurrent), {
          description: "Maximum number of agents that may run at the same time.",
          submenu: numericSubmenu(
            theme,
            [1, 2, 4, 8, 16, 32],
            String,
            "Agent concurrency",
            "Maximum number of agents that may run at the same time.",
          ),
        }),
        setting(
          "agents.maxPerExecution",
          "Max per execution",
          String(config.agents.maxPerExecution),
          {
            description: "Maximum number of agent calls allowed within a single raft_exec program.",
            submenu: numericSubmenu(
              theme,
              [10, 25, 50, 100, 200, 500],
              String,
              "Agents per execution",
              "Maximum number of agent calls allowed within a single raft_exec program.",
            ),
          },
        ),
        setting("agents.maxDepth", "Max depth", String(config.agents.maxDepth), {
          description:
            "How many levels of agents may run below this session. 0 blocks every agent call, including the first; 1 lets this session start agents that cannot start their own.",
          submenu: nonNegativeIntegerSubmenu(
            theme,
            "Agent depth",
            "How many levels of agents may run below this session. 0 blocks every agent call, including the first. Enter any non-negative integer.",
          ),
        }),
        setting("agents.budgetUsd", "Recursion budget", formatUsd(config.agents.budgetUsd), {
          description:
            "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
          submenu: numericSubmenu(
            theme,
            BUDGET_VALUES,
            formatUsd,
            "Recursion budget",
            "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
          ),
        }),
        setting(
          "agents.sessionExport",
          "Usage export",
          config.agents.sessionExport ? "true" : "false",
          {
            description:
              "Write usage-only pi-format session files (tokens/cost, never transcript content) for every agent run so tokscale and ccusage can track Raft subagents.",
            values: BOOLEANS,
          },
        ),
        setting(
          "agents.sessionExportDir",
          "Usage export dir",
          config.agents.sessionExportDir || "~/.pi/agent (co-hosted, hidden .raft namespace)",
          {
            description:
              "Root of the export store; sessions land under <dir>/sessions/.raft/. Default reuses pi's own agent dir (tokscale/ccusage count it with zero setup; pi's resume picker never sees the hidden namespace). PI_RAFT_AGENT_DIR overrides.",
            submenu: stringInputSubmenu(
              theme,
              "Usage export dir",
              "Root of the export store; PI_RAFT_AGENT_DIR overrides this value.",
            ),
          },
        ),
        setting(
          "agents.maxTokensPerChild",
          "Token limit",
          formatTokens(config.agents.maxTokensPerChild),
          {
            description:
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables). Caps a runaway child before the host session compacts.",
            submenu: numericSubmenu(
              theme,
              TOKEN_VALUES,
              formatTokens,
              "Agent token limit",
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables).",
            ),
          },
        ),
        setting("agents.timeoutMs", "Timeout", formatMs(config.agents.timeoutMs), {
          description: "Default wall-clock timeout and minimum for per-call agent timeouts.",
          submenu: numericSubmenu(
            theme,
            [
              60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000,
              28_800_000, 86_400_000,
            ],
            formatMs,
            "Agent timeout",
            "Default wall-clock timeout and minimum for per-call agent timeouts.",
          ),
        }),
        setting("agents.extensions", "Extensions", config.agents.extensions ? "true" : "false", {
          description: "Allow agents to load registered extensions.",
          values: BOOLEANS,
        }),
        enableToolsItem,
        setting("agents.retainRuns", "Retain runs", config.agents.retainRuns ? "true" : "false", {
          description: "Keep completed agent run artifacts for later inspection.",
          values: BOOLEANS,
        }),
        setting(
          "agents.notifyOnComplete",
          "Notify on complete",
          config.agents.notifyOnComplete ? "true" : "false",
          { description: "Post a message when a background agent completes.", values: BOOLEANS },
        ),
      ],
      persist,
    ),
  });
};
