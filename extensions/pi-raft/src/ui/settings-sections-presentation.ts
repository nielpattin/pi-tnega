import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  numericSubmenu,
  stringOptionsSubmenu,
} from "./settings-submenus.js";
import {
  summaryFor,
  BOOLEANS,
  WIDGET_MODES,
  TOOL_DISPLAY_MODES,
  formatDebounce,
  formatMs,
  SHIKI_THEME_PRESETS,
  DIFF_INTENSITIES,
  WORD_EMPHASES,
  TOOL_CALL_BACKGROUNDS,
  PATH_ICON_MODES,
  CODE_PREVIEW_EDIT_LINES_ID,
  CODE_PREVIEW_ALL_LINES,
} from "./settings-values.js";

export const buildUiSection = ({
  config,
  theme,
  persist,
}: Pick<SettingsSectionContext, "config" | "theme" | "persist">): SettingItem => {
  return setting("appearance.ui", "UI", summaryFor("appearance.ui", config), {
    description: "Raft activity widget and dashboard.",
    submenu: sectionSubmenu(
      theme,
      "UI",
      "Raft activity widget and dashboard.",
      [
        setting(
          "appearance.ui.enabled",
          "Enabled",
          config.appearance.ui.enabled ? "true" : "false",
          { description: "Show the Raft activity widget and dashboard.", values: BOOLEANS },
        ),
        setting("appearance.ui.widget", "Widget", config.appearance.ui.widget, {
          description: "When to show the activity widget above the editor.",
          values: WIDGET_MODES,
        }),
        setting("appearance.ui.toolDisplay", "Tool display", config.appearance.ui.toolDisplay, {
          description:
            "Show full Raft TypeScript or a compact intent-and-tools transcript; the tool-expand key (ctrl+o) expands a compact card to full.",
          values: TOOL_DISPLAY_MODES,
        }),
        setting(
          "appearance.ui.showAgentToolPreview",
          "Agent tool preview",
          config.appearance.ui.showAgentToolPreview ? "true" : "false",
          {
            description:
              "Show spawned agent tool trees — including recursive descendants — in Raft tool-call previews.",
            values: BOOLEANS,
          },
        ),
        setting(
          "appearance.ui.updateDebounceMs",
          "Update debounce",
          formatDebounce(config.appearance.ui.updateDebounceMs),
          {
            description:
              "One global coalescing window for live card updates — nested calls, progress, agent previews.",
            submenu: numericSubmenu(
              theme,
              [0, 16, 50, 100, 150, 250, 500, 1000],
              formatDebounce,
              "Update debounce",
              "One global coalescing window for live card updates — nested calls, progress, agent previews. Off emits every update.",
            ),
          },
        ),
        setting("appearance.ui.maxRows", "Max rows", String(config.appearance.ui.maxRows), {
          description: "Maximum rows rendered by the activity widget.",
          submenu: numericSubmenu(
            theme,
            [1, 2, 3, 5, 6, 8, 10, 15, 20],
            String,
            "Widget max rows",
            "Maximum rows rendered by the activity widget.",
          ),
        }),
        setting(
          "appearance.ui.refreshMs",
          "Refresh interval",
          formatMs(config.appearance.ui.refreshMs),
          {
            description: "Refresh interval for the activity widget.",
            submenu: numericSubmenu(
              theme,
              [100, 250, 500, 1000, 2000],
              formatMs,
              "Widget refresh interval",
              "Refresh interval for the activity widget.",
            ),
          },
        ),
        setting(
          "appearance.ui.eventHistory",
          "Event history",
          String(config.appearance.ui.eventHistory),
          {},
        ),
      ],
      persist,
    ),
  });
};

export const buildCodePreviewSection = ({
  config,
  theme,
  persist,
}: Pick<SettingsSectionContext, "config" | "theme" | "persist">): SettingItem => {
  return setting(
    "appearance.codePreview",
    "Code previews",
    summaryFor("appearance.codePreview", config),
    {
      description: "Core tool previews, diffs, and Shiki syntax highlighting.",
      submenu: sectionSubmenu(
        theme,
        "Code previews",
        "Core tool previews, diffs, and Shiki syntax highlighting. Persisted to raft.json codePreview.",
        [
          setting(
            "appearance.codePreview.shikiTheme",
            "Shiki theme",
            config.appearance.codePreview.shikiTheme,
            {
              description:
                '"auto" follows Pi\'s resolved light/dark variant; "<light>/<dark>" pins both; any other value fixes one theme.',
              submenu: stringOptionsSubmenu(
                theme,
                SHIKI_THEME_PRESETS,
                "Shiki theme",
                '"auto" follows Pi\'s light/dark switching (github-light/dark-plus); "<light>/<dark>" pins both variants.',
              ),
            },
          ),
          setting(
            "appearance.codePreview.syntaxHighlighting",
            "Syntax highlighting",
            config.appearance.codePreview.syntaxHighlighting ? "true" : "false",
            { description: "Highlight code in previews with Shiki.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.diffIntensity",
            "Diff background",
            config.appearance.codePreview.diffIntensity,
            {
              description: "Full-row background tint for added and removed diff lines.",
              values: DIFF_INTENSITIES,
            },
          ),
          setting(
            "appearance.codePreview.wordEmphasis",
            "Word emphasis",
            config.appearance.codePreview.wordEmphasis,
            {
              description: "Highlight changed words inside added and removed diff lines.",
              values: WORD_EMPHASES,
            },
          ),
          setting(
            "appearance.codePreview.toolCallBackground",
            "Tool call background",
            config.appearance.codePreview.toolCallBackground,
            {
              description: "Background treatment for tool call frames.",
              values: TOOL_CALL_BACKGROUNDS,
            },
          ),
          setting(
            "appearance.codePreview.toolCallTiming",
            "Tool call timing",
            config.appearance.codePreview.toolCallTiming ? "true" : "false",
            { description: "Show per-call duration on tool frames.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.pathIcons",
            "Path icons",
            config.appearance.codePreview.pathIcons,
            { description: "Icon set for path tree previews.", values: PATH_ICON_MODES },
          ),
          setting(
            "appearance.codePreview.readCollapsedLines",
            "Read lines",
            String(config.appearance.codePreview.readCollapsedLines),
            {
              description: "Collapsed read preview budget.",
              submenu: numericSubmenu(
                theme,
                [3, 5, 10, 15, 20, 30],
                String,
                "Read lines",
                "Collapsed read preview budget.",
              ),
            },
          ),
          setting(
            "appearance.codePreview.writeCollapsedLines",
            "Write lines",
            String(config.appearance.codePreview.writeCollapsedLines),
            {
              description: "Collapsed write preview budget.",
              submenu: numericSubmenu(
                theme,
                [3, 5, 10, 15, 20, 30],
                String,
                "Write lines",
                "Collapsed write preview budget.",
              ),
            },
          ),
          setting(
            CODE_PREVIEW_EDIT_LINES_ID,
            "Edit diff lines",
            config.appearance.codePreview.editCollapsedLines === "all"
              ? CODE_PREVIEW_ALL_LINES
              : String(config.appearance.codePreview.editCollapsedLines),
            {
              description: "Collapsed edit diff budget, or every diff line.",
              submenu: stringOptionsSubmenu(
                theme,
                ["10", "40", "80", "160", "320", CODE_PREVIEW_ALL_LINES],
                "Edit diff lines",
                "Collapsed edit diff budget, or every diff line.",
              ),
            },
          ),
          setting(
            "appearance.codePreview.grepCollapsedLines",
            "Grep lines",
            String(config.appearance.codePreview.grepCollapsedLines),
            {
              description: "Collapsed grep result budget.",
              submenu: numericSubmenu(
                theme,
                [5, 10, 15, 25, 40],
                String,
                "Grep lines",
                "Collapsed grep result budget.",
              ),
            },
          ),
          setting(
            "appearance.codePreview.pathListCollapsedLines",
            "Path list lines",
            String(config.appearance.codePreview.pathListCollapsedLines),
            {
              description: "Collapsed find/ls path tree budget.",
              submenu: numericSubmenu(
                theme,
                [10, 20, 40, 80],
                String,
                "Path list lines",
                "Collapsed find/ls path tree budget.",
              ),
            },
          ),
          setting(
            "appearance.codePreview.readContentPreview",
            "Read preview",
            config.appearance.codePreview.readContentPreview ? "true" : "false",
            { description: "Show file content previews for read calls.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.writeContentPreview",
            "Write preview",
            config.appearance.codePreview.writeContentPreview ? "true" : "false",
            { description: "Show content previews for write calls.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.editDiffPreview",
            "Edit diff preview",
            config.appearance.codePreview.editDiffPreview ? "true" : "false",
            { description: "Show diffs for edit calls.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.grepResultPreview",
            "Grep results",
            config.appearance.codePreview.grepResultPreview ? "true" : "false",
            { description: "Show grouped grep result previews.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.findResultPreview",
            "Find results",
            config.appearance.codePreview.findResultPreview ? "true" : "false",
            { description: "Show find result path trees.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.lsResultPreview",
            "Ls results",
            config.appearance.codePreview.lsResultPreview ? "true" : "false",
            { description: "Show ls result path trees.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.readLineNumbers",
            "Read line numbers",
            config.appearance.codePreview.readLineNumbers ? "true" : "false",
            { description: "Show line-number gutters in read previews.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.bashResultPreview",
            "Bash results",
            config.appearance.codePreview.bashResultPreview ? "true" : "false",
            { description: "Show bash output previews.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.bashWarnings",
            "Bash warnings",
            config.appearance.codePreview.bashWarnings ? "true" : "false",
            { description: "Annotate risky bash commands.", values: BOOLEANS },
          ),
          setting(
            "appearance.codePreview.secretWarnings",
            "Secret warnings",
            config.appearance.codePreview.secretWarnings ? "true" : "false",
            { description: "Flag suspected secrets in previews.", values: BOOLEANS },
          ),
        ],
        persist,
      ),
    },
  );
};
