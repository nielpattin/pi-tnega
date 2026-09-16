import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  compactionThresholdSubmenu,
  numericSubmenu,
} from "./settings-submenus.js";
import {
  summaryFor,
  COMPACTION_THRESHOLD_SETTING_ID,
  formatCompactionThreshold,
  COMPACTION_ENGINES,
  COMPACTION_TARGET_RATIOS,
  formatRetention,
  BOOLEANS,
  formatMs,
} from "./settings-values.js";

export const buildCompactionSection = ({
  config,
  theme,
  options,
  persist,
}: Pick<
  SettingsSectionContext<"activeModelKey">,
  "config" | "theme" | "options" | "persist"
>): SettingItem => {
  return setting("lifecycle.compaction", "Compaction", summaryFor("lifecycle.compaction", config), {
    description: "Compaction engine used at session compaction boundaries.",
    submenu: sectionSubmenu(
      theme,
      "Compaction",
      "Choose Raft deterministic compaction or Pi core model-driven compaction.",
      [
        ...(options.activeModelKey
          ? [
              setting(
                COMPACTION_THRESHOLD_SETTING_ID,
                "Threshold",
                formatCompactionThreshold(config, options.activeModelKey),
                {
                  description: `Context usage that triggers compaction for ${options.activeModelKey}, as a percent of its window or an exact token count.`,
                  submenu: compactionThresholdSubmenu(theme),
                },
              ),
            ]
          : []),
        setting("lifecycle.compaction.engine", "Engine", config.lifecycle.compaction.engine, {
          description:
            "Raft uses deterministic branch summaries; Pi delegates compaction to Pi core.",
          values: COMPACTION_ENGINES,
        }),
        setting(
          "lifecycle.compaction.targetContextRatio",
          "Max occupancy",
          String(config.lifecycle.compaction.targetContextRatio),
          {
            description:
              "Hard post-compaction occupancy ceiling; Raft normally keeps Pi's bounded recent-token tail instead.",
            values: COMPACTION_TARGET_RATIOS,
          },
        ),
      ],
      persist,
    ),
  });
};

export const buildRetentionSection = ({
  config,
  theme,
  persist,
}: Pick<SettingsSectionContext, "config" | "theme" | "persist">): SettingItem => {
  return setting("lifecycle.retention", "Retention", summaryFor("lifecycle.retention", config), {
    description: "Age-based cleanup for inactive Raft run artifacts.",
    submenu: sectionSubmenu(
      theme,
      "Retention",
      "Cleanup only removes dead temporary roots and terminal run artifacts. Active runs are never modified.",
      [
        setting(
          "lifecycle.retention.orphanedTempRunMs",
          "Orphaned temp runs",
          formatRetention(config.lifecycle.retention.orphanedTempRunMs),
          {
            description: "Remove temporary run roots this long after their owner process dies.",
            submenu: numericSubmenu(
              theme,
              [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000],
              formatRetention,
              "Orphaned temp runs",
              "Remove temporary run roots this long after their owner process dies.",
            ),
          },
        ),
        setting(
          "lifecycle.retention.oneShotRunMs",
          "One-shot runs",
          formatRetention(config.lifecycle.retention.oneShotRunMs),
          {
            description: "Retain completed one-shot agent run artifacts for this duration.",
            submenu: numericSubmenu(
              theme,
              [
                6 * 3_600_000,
                12 * 3_600_000,
                24 * 3_600_000,
                2 * 86_400_000,
                3 * 86_400_000,
                7 * 86_400_000,
              ],
              formatRetention,
              "One-shot runs",
              "Retain completed one-shot agent run artifacts for this duration.",
            ),
          },
        ),
      ],
      persist,
    ),
  });
};
