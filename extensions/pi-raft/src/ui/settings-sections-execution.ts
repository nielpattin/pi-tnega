import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  numericSubmenu,
  stringInputSubmenu,
  modelPickerSubmenu,
  toolRiskAddSubmenu,
} from "./settings-submenus.js";
import {
  BOOLEANS,
  summaryFor,
  EXECUTOR_KERNELS,
  PYTHON_RUNTIMES,
  EXECUTOR_RUNTIMES,
  formatMs,
  formatBytes,
  executorMemoryLimitOptions,
  RESULT_FORMATS,
  APPROVAL_MODES,
  RISK_CLASSES,
  toolRiskDescription,
  TOOL_RISK_OVERRIDES_SETTING_ID,
  TOOL_RISK_ADD_SETTING_ID,
  formatToolRiskSummary,
  toolRiskCandidateRefs,
  toolRiskRefs,
  toolRiskPartial,
  parseToolRiskEntry,
} from "./settings-values.js";
import { maxExecutorMemoryLimitBytes } from "../config.js";
import { shadowedCoreTools } from "../agents/child-tools.js";
import { defaultToolRisk } from "../core/tool-risk.js";
import { INHERIT_VALUE } from "./model-picker.js";

export const buildExecutorSection = ({
  config,
  theme,
  persist,
}: Pick<SettingsSectionContext, "config" | "theme" | "persist">): SettingItem => {
  const executorMemoryDescription = (): string =>
    config.execution.executor.kernel === "python" &&
    config.execution.executor.pythonRuntime === "monty"
      ? "Monty VM allocation limit. Host bridge result/output limits apply separately. No filesystem or network access is granted to the VM."
      : config.execution.executor.kernel === "python"
        ? "CPython process address-space limit via RLIMIT_AS where the OS supports it; not a portable hard memory cap. Process limits are not a security sandbox."
        : config.execution.executor.runtime === "quickjs"
          ? "Maximum QuickJS heap size. WASM32 limits this to less than 4 GiB."
          : config.execution.executor.runtime === "bun-process"
            ? "Heap target for the disposable Bun process. Bun ignores V8 heap flags, so this limit is not enforced."
            : "V8 old-generation heap limit for the disposable Node process. Large allocations may destabilize the system.";
  const kernelDescription =
    "Exclusive language for all raft_exec calls; no per-call switching. Saving a kernel change reloads Pi after settings close so skill resources switch with execution. Python defaults to sandboxed Monty. CPython 3.10+ requires explicit selection and is trusted native code.";
  const cpythonDescription =
    "CPython 3.10+ executable name or path (default python3), used only by the explicit CPython backend. No shell arguments.";

  return setting("execution.executor", "Executor", summaryFor("execution.executor", config), {
    description:
      "Kernel, Python/TypeScript backends, and resource limits. Node/Bun and CPython are unsafe trusted-code escape hatches.",
    submenu: sectionSubmenu(
      theme,
      "Executor",
      "Kernel, Python/TypeScript backends, and resource limits. Node/Bun and CPython are unsafe trusted-code escape hatches.",
      [
        setting("execution.executor.kernel", "Kernel", config.execution.executor.kernel, {
          description: kernelDescription,
          values: EXECUTOR_KERNELS,
        }),
        setting(
          "execution.executor.pythonRuntime",
          "Runtime (Python)",
          config.execution.executor.pythonRuntime,
          {
            description:
              "Monty (default) is a sandboxed Python subset with no native filesystem, network, or environment access. CPython 3.10+ is an explicit trusted-native escape hatch.",
            values: PYTHON_RUNTIMES,
          },
        ),
        setting(
          "execution.executor.cpython.binary",
          "CPython binary",
          config.execution.executor.cpython.binary,
          {
            description: cpythonDescription,
            submenu: stringInputSubmenu(theme, "CPython binary", cpythonDescription),
          },
        ),
        setting("execution.executor.runtime", "Runtime (TS)", config.execution.executor.runtime, {
          description:
            "TypeScript only; ignored by Python. QuickJS is isolated and limited by WASM32. Node/Bun processes support larger heaps but are an unsafe trusted-code escape hatch, not a security sandbox.",
          values: EXECUTOR_RUNTIMES,
        }),
        setting(
          "execution.executor.timeoutMs",
          "Timeout",
          formatMs(config.execution.executor.timeoutMs),
          {
            description: `Default wall-clock time for a single raft_exec program. A per-invocation timeoutMs or a matching executor.hostCallTimeouts ref can raise it up to the ${formatMs(config.execution.executor.maxTimeoutMs)} policy maximum.`,
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
              formatMs,
              "Executor timeout",
              `Default wall-clock time for a single raft_exec program (policy max ${formatMs(config.execution.executor.maxTimeoutMs)}).`,
            ),
          },
        ),
        setting(
          "execution.executor.maxTimeoutMs",
          "Policy max",
          formatMs(config.execution.executor.maxTimeoutMs),
          {
            description:
              "Ceiling for every executor deadline: per-invocation timeoutMs requests and executor.hostCallTimeouts ref floors are capped at this value. Values above it are normalized on load.",
            submenu: numericSubmenu(
              theme,
              [300_000, 600_000, 900_000, 1_800_000, 3_600_000],
              formatMs,
              "Executor policy maximum",
              "Ceiling for every executor deadline, including per-invocation requests and per-ref floors.",
            ),
          },
        ),
        setting(
          "execution.executor.hostCallTimeouts",
          "Per-ref floors",
          Object.keys(config.execution.executor.hostCallTimeouts).length > 0
            ? Object.keys(config.execution.executor.hostCallTimeouts)
                .map(
                  (ref) =>
                    `${ref}=${formatMs(config.execution.executor.hostCallTimeouts[ref] ?? 0)}`,
                )
                .join(", ")
            : "none",
          {
            description:
              'Exact-ref deadline floors for known long-running host calls (configured in the Raft config file), e.g. "agents.run": 3600000.',
          },
        ),
        setting(
          "execution.executor.memoryLimitBytes",
          "Memory limit",
          formatBytes(config.execution.executor.memoryLimitBytes),
          {
            description: executorMemoryDescription(),
            submenu: (currentValue, done) =>
              numericSubmenu(
                theme,
                executorMemoryLimitOptions(
                  maxExecutorMemoryLimitBytes(
                    config.execution.executor.runtime,
                    config.execution.executor.kernel,
                  ),
                ),
                formatBytes,
                "Executor memory limit",
                executorMemoryDescription(),
              )(currentValue, done),
          },
        ),
        setting(
          "execution.executor.maxOutputChars",
          "Max output chars",
          config.execution.executor.maxOutputChars.toLocaleString(),
          {
            description:
              "Character cap applied to the final raft_exec return value shown to the model.",
            submenu: numericSubmenu(
              theme,
              [20_000, 50_000, 100_000, 200_000, 500_000],
              (n) => n.toLocaleString(),
              "Max output chars",
              "Character cap applied to the final raft_exec return value shown to the model.",
            ),
          },
        ),
        setting(
          "execution.executor.resultFormat",
          "Result format",
          config.execution.executor.resultFormat,
          {
            description:
              "Default formatting for raft_exec return values. Auto renders structured values as syntax-highlighted YAML; each call can override this.",
            values: RESULT_FORMATS,
          },
        ),
        setting(
          "execution.executor.maxNestedResultChars",
          "Max nested result chars",
          config.execution.executor.maxNestedResultChars.toLocaleString(),
          {
            description:
              "Character cap applied to results returned by nested tool calls inside the sandbox.",
            submenu: numericSubmenu(
              theme,
              [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000],
              (n) => n.toLocaleString(),
              "Max nested result chars",
              "Character cap applied to results returned by nested tool calls inside the sandbox.",
            ),
          },
        ),
      ],
      persist,
    ),
  });
};

export const buildApprovalsSection = ({
  config,
  theme,
  apply,
  options,
  persist,
}: Pick<
  SettingsSectionContext<"modelSource" | "extensionToolNames">,
  "config" | "theme" | "apply" | "options" | "persist"
>): SettingItem => {
  // Overrides are keyed by exact refs, and refs contain dots: the dotted-id
  // persist path cannot address them, so the whole record commits through `apply`.
  const riskOverrides = config.safety.toolRisks;
  const extensionToolNames = options.extensionToolNames ?? [];
  const shadowedRefs = new Set(
    shadowedCoreTools(extensionToolNames).map((name) => `extensions.${name}`),
  );
  const riskItems = toolRiskRefs(riskOverrides, toolRiskCandidateRefs(extensionToolNames)).map(
    (ref) =>
      setting(ref, ref, riskOverrides[ref] ?? defaultToolRisk(ref), {
        description: toolRiskDescription(
          ref,
          Object.hasOwn(riskOverrides, ref),
          shadowedRefs.has(ref),
        ),
        values: [...RISK_CLASSES],
      }),
  );
  const addRiskItem = setting(TOOL_RISK_ADD_SETTING_ID, "Add exact ref", "", {
    description: "Set a class for a ref outside this list, for example mcp.github.search.",
    submenu: toolRiskAddSubmenu(theme),
  });
  riskItems.push(addRiskItem);
  // Refs added in this dialog have no row yet, so they ride alongside the rows
  // until a rebuild turns them into first-class entries.
  const addedRisks = new Map<string, string>();
  const commitRisks = (id: string, value: string): void => {
    if (id === TOOL_RISK_ADD_SETTING_ID) {
      const parsed = parseToolRiskEntry(value);
      if (!parsed) return;
      addedRisks.set(parsed.ref, parsed.risk);
      addRiskItem.currentValue = "";
    }
    const rows = riskItems
      .filter((item) => item.id !== TOOL_RISK_ADD_SETTING_ID)
      .map((item) => ({ ref: item.id, value: item.currentValue }));
    for (const [ref, risk] of addedRisks) {
      const existing = rows.find((row) => row.ref === ref);
      if (existing) existing.value = risk;
      else rows.push({ ref, value: risk });
    }
    apply(TOOL_RISK_OVERRIDES_SETTING_ID, toolRiskPartial(rows, riskOverrides));
  };

  return setting("safety.approvals", "Approvals", summaryFor("safety.approvals", config), {
    description:
      "Per-action approval policy for Raft and model-requested native tool calls. Per-tool classes live under Action risks.",
    submenu: sectionSubmenu(
      theme,
      "Approvals",
      "Approval policy for Raft and model-requested native tool calls. Auto routes each call through a dedicated safety classifier and escalates uncertain actions to you.",
      [
        setting(
          "safety.approvals.model",
          "Auto model",
          config.safety.approvals.model || INHERIT_VALUE,
          {
            description:
              "Pi model used as the auto-mode safety classifier. Inherit uses the active session model. The classifier has no executable tools and returns a structured allow-or-escalate verdict.",
            submenu: modelPickerSubmenu(theme, options.modelSource, {
              headerText:
                "Safety classifier for auto approval policies. Pick Inherit to use the active Pi session model.",
              inheritName: "Use the active Pi session model",
            }),
          },
        ),
        setting("safety.approvals.read", "Read", config.safety.approvals.read, {
          description:
            "Approval policy for read operations. Read is normally safe to leave allowed.",
          values: APPROVAL_MODES,
        }),
        setting("safety.approvals.write", "Write", config.safety.approvals.write, {
          description: "Approval policy for write and edit operations. Auto classifies each call.",
          values: APPROVAL_MODES,
        }),
        setting("safety.approvals.execute", "Execute", config.safety.approvals.execute, {
          description: "Approval policy for shell execution. Auto classifies each command.",
          values: APPROVAL_MODES,
        }),
        setting("safety.approvals.network", "Network", config.safety.approvals.network, {
          description:
            "Approval policy for network operations. Auto classifies each destination and payload.",
          values: APPROVAL_MODES,
        }),
        setting("safety.approvals.agent", "Agent", config.safety.approvals.agent, {
          description: "Approval policy for agent operations. Auto classifies each request.",
          values: APPROVAL_MODES,
        }),
        setting(
          TOOL_RISK_OVERRIDES_SETTING_ID,
          "Action risks",
          formatToolRiskSummary(riskOverrides),
          {
            description:
              "Approval class per exact ref. Rows show the class each tool runs under; cycle to change it.",
            submenu: sectionSubmenu(
              theme,
              "Action risks",
              "Approval class per exact ref. Rows show the class each tool runs under, and cycling back to a tool's built-in class clears its override.",
              riskItems,
              commitRisks,
            ),
          },
        ),
      ],
      persist,
    ),
  });
};

export const buildMcpSection = ({
  config,
  theme,
  persist,
}: Pick<SettingsSectionContext, "config" | "theme" | "persist">): SettingItem => {
  return setting("tools.mcp", "MCP", summaryFor("tools.mcp", config), {
    description: "Model Context Protocol provider discovery and invocation.",
    submenu: sectionSubmenu(
      theme,
      "MCP",
      "Model Context Protocol provider discovery and invocation.",
      [
        setting("tools.mcp.enabled", "Enabled", config.tools.mcp.enabled ? "true" : "false", {
          description: "Enable the MCP provider inside raft_exec.",
          values: BOOLEANS,
        }),
        setting(
          "tools.mcp.disableOAuth",
          "Disable OAuth",
          config.tools.mcp.disableOAuth ? "true" : "false",
          { description: "Skip MCP OAuth flows.", values: BOOLEANS },
        ),
        setting(
          "tools.mcp.allowDynamicServers",
          "Dynamic servers",
          config.tools.mcp.allowDynamicServers ? "true" : "false",
          {
            description: "Allow servers to be added at runtime via the MCP protocol.",
            values: BOOLEANS,
          },
        ),
        setting(
          "tools.mcp.callTimeoutMs",
          "Call timeout",
          formatMs(config.tools.mcp.callTimeoutMs),
          {
            description: "Timeout for individual MCP tool calls.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000],
              formatMs,
              "MCP call timeout",
              "Timeout for individual MCP tool calls.",
            ),
          },
        ),
        setting(
          "tools.mcp.cache.enabled",
          "Descriptor cache",
          config.tools.mcp.cache.enabled ? "true" : "false",
          {
            description:
              "Cache MCP tool metadata across sessions keyed by mcporter config; discovery no longer spawns every server.",
            values: BOOLEANS,
          },
        ),
        setting(
          "tools.mcp.cache.revalidate",
          "Revalidate on start",
          config.tools.mcp.cache.revalidate,
          {
            description:
              "Background re-listing at session start: changed servers only, all servers, or off.",
            values: ["changed", "all", "off"],
          },
        ),
        setting(
          "tools.mcp.cache.revalidateBudgetMs",
          "Revalidate budget",
          formatMs(config.tools.mcp.cache.revalidateBudgetMs),
          {
            description: "Wall-clock budget for the session-start background MCP revalidation.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000],
              formatMs,
              "MCP revalidate budget",
              "Wall-clock budget for the session-start background MCP revalidation.",
            ),
          },
        ),
      ],
      persist,
    ),
  });
};
