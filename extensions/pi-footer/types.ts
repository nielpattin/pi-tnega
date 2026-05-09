import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

// Theme color - either a pi theme color name or a custom hex color
export type ColorValue = ThemeColor | `#${string}`;
export type ThemeLike = Pick<Theme, "fg">;

// Semantic color names for segments
export type SemanticColor =
   | "model"
   | "shellMode"
   | "path"
   | "gitDirty"
   | "gitClean"
   | "thinking"
   | "thinkingMinimal"
   | "thinkingLow"
   | "thinkingMedium"
   | "context"
   | "contextWarn"
   | "contextError"
   | "cost"
   | "tokens"
   | "separator"
   | "border";

// Color scheme mapping semantic names to actual colors
export type ColorScheme = Partial<Record<SemanticColor, ColorValue>>;

// Built-in segment identifiers
export type BuiltinStatusLineSegmentId =
   | "model"
   | "shell_mode"
   | "path"
   | "git"
   | "subagents"
   | "token_in"
   | "token_out"
   | "token_total"
   | "cost"
   | "context_pct"
   | "context_total"
   | "time_spent"
   | "time"
   | "session"
   | "hostname"
   | "cache_read"
   | "cache_write"
   | "thinking"
   | "verbosity"
   | "extension_statuses"
   | "skills"
   | "mcp";

// Segment identifiers (built-in + dynamically registered custom items)
export type StatusLineSegmentId = BuiltinStatusLineSegmentId | `custom:${string}`;

// Separator styles
export type StatusLineSeparatorStyle =
   | "powerline"
   | "powerline-thin"
   | "slash"
   | "pipe"
   | "block"
   | "none"
   | "ascii"
   | "dot"
   | "chevron"
   | "star";

// Per-segment options
export interface StatusLineSegmentOptions {
   model?: { showThinkingLevel?: boolean };
   path?: {
      mode?: "basename" | "abbreviated" | "full";
      maxLength?: number;
   };
   git?: {
      showBranch?: boolean;
      showStaged?: boolean;
      showUnstaged?: boolean;
      showUntracked?: boolean;
   };
   time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export type CustomItemPosition = "left" | "right" | "secondary";

export interface CustomStatusItem {
   id: string;
   statusKey: string;
   position: CustomItemPosition;
   color?: ColorValue;
   prefix?: string;
   hideWhenMissing: boolean;
   excludeFromExtensionStatuses: boolean;
}

// Layout definition
export interface PresetDef {
   leftSegments: BuiltinStatusLineSegmentId[];
   rightSegments: BuiltinStatusLineSegmentId[];
   /** Secondary row segments (shown in footer, above sub bar) */
   secondarySegments?: BuiltinStatusLineSegmentId[];
   separator: StatusLineSeparatorStyle;
   segmentOptions?: StatusLineSegmentOptions;
   /** Color scheme for this layout */
   colors?: ColorScheme;
}

// Separator definition
export interface SeparatorDef {
   left: string;
   right: string;
   endCaps?: {
      left: string;
      right: string;
      useBgAsFg: boolean;
   };
}

// Git status data
export interface GitStatus {
   branch: string | null;
   staged: number;
   unstaged: number;
   untracked: number;
}

// Usage statistics
export interface UsageStats {
   input: number;
   output: number;
   cacheRead: number;
   cacheWrite: number;
   cost: number;
}

// Context passed to segment render functions
export interface SegmentContext {
   // From pi-mono
   model: { id: string; name?: string; provider?: string; reasoning?: boolean; contextWindow?: number } | undefined;
   thinkingLevel: string;
   verbosityLevel?: string | null;
   sessionId: string | undefined;

   // Computed
   usageStats: UsageStats;
   contextPercent: number;
   contextWindow: number;
   contextUsed: number;
   autoCompactEnabled: boolean;
   customCompactionEnabled: boolean;
   usingSubscription: boolean;
   sessionStartTime: number;
   shellModeActive: boolean;
   shellRunning: boolean;
   shellName: string | null;
   shellCwd: string | null;

   // Git
   git: GitStatus;

   // Available provider count (for showing MCP/powerline provider indicator)
   availableProviderCount: number;

   // Skills
   skillsActive: number;
   skillsTotal: number;

   // Extension statuses
   extensionStatuses: ReadonlyMap<string, string>;
   hiddenExtensionStatusKeys: ReadonlySet<string>;
   customItemsById: ReadonlyMap<string, CustomStatusItem>;

   // Options
   options: StatusLineSegmentOptions;

   // Theming
   theme: ThemeLike;
   colors: ColorScheme;
}

// Rendered segment output
export interface RenderedSegment {
   content: string;
   visible: boolean;
}

// Segment definition
export interface StatusLineSegment {
   id: BuiltinStatusLineSegmentId;
   render(ctx: SegmentContext): RenderedSegment;
}
