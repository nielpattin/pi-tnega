import type { RaftState } from "../raft-state.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "../core/agent-dir.js";
import { observeHostExtensionRunner, registeredToolNames } from "../core/host-extension-runner.js";
import { type RaftConfigScope, loadRaftConfigForScope, saveRaftConfig } from "../config.js";
import { RaftSettingsComponent } from "./settings-component.js";
import { modelKey, buildModelSource, type ModelSource } from "./model-picker.js";
import {
  COMPACTION_THRESHOLD_SETTING_ID,
  compactionThresholdPartial,
  type CompactionThresholdSelection,
  buildPartial,
  summaryFor,
  coerceValue,
} from "./settings-values.js";
import { populateClaudeModelSource, buildRaftSettingsItems } from "./settings-sections.js";
import type { SettingItem } from "@earendil-works/pi-tui";
import { openRpcRaftSettings } from "./settings-rpc.js";

const ROOT_ITEM_IDS = [
  "execution.executor",
  "tools.mcp",
  "safety.approvals",
  "agents",
  "appearance.ui",
  "appearance.codePreview",
  "lifecycle",
] as const;

const RELOAD_PREFIXES = ["agents", "tools.mcp", "lifecycle.retention"] as const;

export interface RaftSettingsDeps {
  state: RaftState;
  onConfigApplied?: (id: string) => void;
  reloadResources?: () => Promise<void>;
}

export async function openRaftSettings(
  context: ExtensionContext,
  deps: RaftSettingsDeps,
): Promise<void> {
  await deps.state.ensure(context);

  const agentDir = resolveAgentDir();
  const projectTrusted = context.isProjectTrusted();
  const configLocation = { cwd: context.cwd, agentDir, projectTrusted };
  let saveScope: RaftConfigScope = "global";
  let settingsConfig = loadRaftConfigForScope(configLocation, saveScope);
  let rootComponent: RaftSettingsComponent | undefined;
  const changedSections = new Set<string>();
  let dirty = false;
  // Serialize configuration reloads triggered by each save.
  let pendingReload: Promise<void> = Promise.resolve();

  const activeModelKey = context.model
    ? modelKey(context.model.provider, context.model.id)
    : undefined;

  const apply = (id: string, value: unknown): void => {
    const partial =
      id === COMPACTION_THRESHOLD_SETTING_ID && activeModelKey
        ? compactionThresholdPartial(activeModelKey, value as CompactionThresholdSelection)
        : buildPartial(id, value);
    try {
      saveRaftConfig({ cwd: context.cwd, agentDir, projectTrusted, scope: saveScope }, partial);
    } catch (error) {
      context.ui.notify(
        `Failed to save Raft settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    pendingReload = pendingReload
      .then(() => deps.state.reloadConfig(context))
      .catch((error: unknown) => {
        context.ui.notify(
          `Pi Raft reload failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
    // Render the persisted layers, not the live config: runtime-only
    // environment and session overrides must not change what this editor saves.
    Object.assign(settingsConfig, loadRaftConfigForScope(configLocation, saveScope));
    deps.onConfigApplied?.(id);
    dirty = true;
    changedSections.add(id);
    const list = rootComponent?.settingsList;
    if (list) {
      for (const rootId of ROOT_ITEM_IDS) {
        list.updateValue(rootId, summaryFor(rootId, settingsConfig));
      }
    }
  };

  const persist = (id: string, newValue: string): void => {
    apply(id, coerceValue(id, newValue, settingsConfig));
  };

  const modelSource = buildModelSource(context.modelRegistry, resolveAgentDir());
  const hostRunner = await observeHostExtensionRunner();
  const configuredClaudeModel = deps.state.config.agents.claude.model;
  const claudeModelSource: ModelSource = {
    models: configuredClaudeModel
      ? [{ provider: "claude", id: configuredClaudeModel.replace(/^claude\//, "") }]
      : [],
    lastUsed: {},
  };
  void populateClaudeModelSource(claudeModelSource, () => deps.state.agents.claudeModels()).catch(
    (error: unknown) => {
      if (deps.state.config.agents.runner === "claude") {
        context.ui.notify(
          `Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    },
  );

  const itemsForScope = (scope: RaftConfigScope, theme: Theme): SettingItem[] => {
    settingsConfig = loadRaftConfigForScope(configLocation, scope);
    return buildRaftSettingsItems(theme, settingsConfig, apply, {
      modelSource,
      claudeModelSource,
      extensionToolNames: registeredToolNames(hostRunner.current()),
      ...(activeModelKey ? { activeModelKey } : {}),
    });
  };

  if (context.mode === "rpc") {
    await openRpcRaftSettings(context, {
      projectScopeAvailable: projectTrusted,
      getScope: () => saveScope,
      setScope: (scope) => {
        saveScope = scope;
      },
      itemsForScope: (scope) => itemsForScope(scope, context.ui.theme),
      persist,
    });
  } else if (context.mode !== "tui") {
    context.ui.notify("Raft settings require an interactive UI", "warning");
    return;
  } else {
    await context.ui.custom<void>((tui, theme, _keybindings, done) => {
      const component = new RaftSettingsComponent(
        theme,
        itemsForScope(saveScope, theme),
        persist,
        () => done(),
        {
          initialSaveScope: saveScope,
          projectScopeAvailable: projectTrusted,
          onSaveScopeChange: (scope) => {
            saveScope = scope;
            tui.requestRender();
          },
          itemsForSaveScope: (scope) => itemsForScope(scope, theme),
        },
      );
      rootComponent = component;
      return component;
    });
  }

  if (dirty) {
    await pendingReload;
    if (deps.state.kernelReloadRequired) {
      if (deps.reloadResources) {
        context.ui.notify(
          "Kernel saved. Reloading Pi to switch execution and skill resources together.",
          "info",
        );
        await deps.reloadResources();
        return;
      }
      context.ui.notify(
        "Run /reload to apply the kernel change; the current kernel remains active.",
        "warning",
      );
    }
    const needsReload = [...changedSections].some((id) =>
      RELOAD_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}.`)),
    );
    if (needsReload) {
      context.ui.notify(
        "Raft settings saved. Run /raft reload to apply agent and MCP changes.",
        "info",
      );
    } else {
      context.ui.notify("Raft settings saved.", "info");
    }
  }
}

// Preserve the public settings entrypoint while implementations stay cohesive.
export { executorMemoryLimitOptions } from "./settings-values.js";
export { compactionThresholdPartial } from "./settings-values.js";
export { parseBudgetValue } from "./settings-values.js";
export { parseFormattedNumericValue } from "./settings-values.js";
export { RaftSettingsComponent } from "./settings-component.js";
export { populateClaudeModelSource } from "./settings-sections.js";
export { buildRaftSettingsItems } from "./settings-sections.js";
