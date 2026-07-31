import type { ColorScheme, PresetDef } from "./types.ts";
import { getDefaultColors } from "./theme.ts";

const DEFAULT_COLORS: ColorScheme = getDefaultColors();

export const DEFAULT_LAYOUT: PresetDef = {
   colors: DEFAULT_COLORS,
   leftSegments: ["path", "git"],
   rightSegments: ["mcp", "skills"],
   secondaryRightSegments: ["model", "thinking"],
   secondarySegments: ["shell_mode", "context_pct", "cache_read", "cache_hit", "cost"],
   segmentOptions: {
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
      model: { showThinkingLevel: false },
      path: { mode: "full" }
   },
   separator: "thin",
   tertiarySegments: ["extension_statuses"]
};
