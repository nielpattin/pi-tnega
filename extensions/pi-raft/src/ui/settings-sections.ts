import { type ModelSource, buildClaudeModelSource } from "./model-picker.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RaftConfig } from "../config.js";
import { coerceValue, summaryFor } from "./settings-values.js";
import { setting, markDrillIn, sectionSubmenu } from "./settings-submenus.js";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  buildExecutorSection,
  buildApprovalsSection,
  buildMcpSection,
} from "./settings-sections-execution.js";
import { buildAgentsSection } from "./settings-sections-agents.js";
import { buildUiSection, buildCodePreviewSection } from "./settings-sections-presentation.js";
import { buildCompactionSection, buildRetentionSection } from "./settings-sections-lifecycle.js";

export const populateClaudeModelSource = async (
  source: ModelSource,
  load: () => Promise<Parameters<typeof buildClaudeModelSource>[0]>,
): Promise<void> => {
  const loaded = buildClaudeModelSource(await load());
  source.models.splice(0, source.models.length, ...loaded.models);
  source.lastUsed = loaded.lastUsed;
};

const buildSettingsGroup = (
  theme: Theme,
  config: RaftConfig,
  id: string,
  label: string,
  description: string,
  items: SettingItem[],
  persist: (id: string, value: string) => void,
): SettingItem =>
  setting(id, label, summaryFor(id, config), {
    description,
    submenu: sectionSubmenu(theme, label, description, items, persist),
  });

export const buildRaftSettingsItems = (
  theme: Theme,
  config: RaftConfig,
  apply: (id: string, value: unknown) => void,
  options: {
    modelSource: ModelSource;
    claudeModelSource?: ModelSource;
    extensionToolNames?: string[];
    activeModelKey?: string;
  },
): SettingItem[] => {
  const persist = (id: string, newValue: string): void => {
    apply(id, coerceValue(id, newValue, config));
  };
  const context = { theme, config, apply, options, persist };
  const lifecycle = buildSettingsGroup(
    theme,
    config,
    "lifecycle",
    "Lifecycle",
    "Context compaction and retained run artifacts.",
    [buildCompactionSection(context), buildRetentionSection(context)],
    persist,
  );
  // Groups only earn a drill-in row when they hold more than one section, so
  // presentation stays flat here: an `Appearance` row wrapping exactly `UI` and
  // `Code previews` was a redundant drill-in level.
  return markDrillIn([
    buildExecutorSection(context),
    buildMcpSection(context),
    buildApprovalsSection(context),
    buildAgentsSection(context),
    buildUiSection(context),
    buildCodePreviewSection(context),
    lifecycle,
  ]);
};
