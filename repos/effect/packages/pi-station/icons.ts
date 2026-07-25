import { loadThemeConfig } from "./theme.ts";

export interface IconSet {
   pi: string;
   model: string;
   folder: string;
   branch: string;
   git: string;
   tokens: string;
   context: string;
   cost: string;
   time: string;
   agents: string;
   cache: string;
   input: string;
   output: string;
   host: string;
   session: string;
   auto: string;
   warning: string;
   skills: string;
}

// Separator characters
export const SEP_DOT = " · ";

// Thinking level display text (Unicode/ASCII)
export const THINKING_TEXT_UNICODE: Record<string, string> = {
   high: "[high]",
   low: "[low]",
   medium: "[med]",
   minimal: "[min]",
   xhigh: "[xhi]"
};

// Thinking level display text (Nerd Fonts - with icons)
export const THINKING_TEXT_NERD: Record<string, string> = {
   high: "\u{F111} high", // Circle
   low: "\u{F10C} low", // Circle outline
   medium: "\u{F192} med", // Dot circle
   minimal: "\u{F0E7} min", // Lightning bolt
   xhigh: "\u{F06D} xhi" // Fire
};

// Get thinking text based on font support
export function getThinkingText(level: string): string | undefined {
   if (hasNerdFonts()) {
      return THINKING_TEXT_NERD[level];
   }
   return THINKING_TEXT_UNICODE[level];
}

// Nerd Font icons (matching oh-my-pi exactly)
export const NERD_ICONS: IconSet = {
   agents: "\uF0C0", // Nf-fa-users
   auto: "\u{F0068}", // Nf-md-lightning_bolt (auto-compact)
   branch: "\uF126", // Nf-fa-code_fork (git branch)
   cache: "\uF1C0", // Nf-fa-database (cache)
   context: "\uE70F", // Nf-dev-database (database)
   cost: "\uF155", // Nf-fa-dollar
   folder: "\uF115", // Nf-fa-folder_open
   git: "\uF1D3", // Nf-fa-git (git logo)
   host: "\uF109", // Nf-fa-laptop (host)
   input: "\uF090", // Nf-fa-sign_in (input arrow)
   model: "\uEC19", // Nf-md-chip (model/AI chip)
   output: "\uF08B", // Nf-fa-sign_out (output arrow)
   pi: "\uE22C", // Nf-oct-pi (stylized pi icon)
   session: "\uF550", // Nf-md-identifier (session id)
   skills: "\uF085", // Nf-fa-gears (tools/skills)
   time: "\uF017", // Nf-fa-clock_o
   tokens: "\uE26B", // Nf-seti-html (tokens symbol)
   warning: "\uF071" // Nf-fa-warning
};

// ASCII/Unicode fallback icons (matching oh-my-pi)
export const ASCII_ICONS: IconSet = {
   agents: "AG",
   auto: "AC",
   branch: "",
   cache: "cache",
   context: "",
   cost: "$",
   folder: "",
   git: "⎇",
   host: "host",
   input: "in:",
   model: "",
   output: "out:",
   pi: "π",
   session: "id",
   skills: "SK",
   time: "◷",
   tokens: "⊛",
   warning: "!"
};

type PartialIconSet = Partial<IconSet>;

function sanitizeUserIconOverrides(value: unknown): PartialIconSet {
   if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
   }

   const sanitized: Record<string, string> = {};
   for (const key of Object.keys(NERD_ICONS)) {
      const icon = (value as Record<string, unknown>)[key];
      if (typeof icon === "string") {
         sanitized[key] = icon;
      }
   }

   return sanitized;
}

// Separator characters
export interface SeparatorChars {
   left: string;
   right: string;
   thinLeft: string;
   thinRight: string;
}

export const NERD_SEPARATORS: SeparatorChars = {
   left: "\uE0B0", //
   right: "\uE0B2", //
   thinLeft: "\uE0B1", //
   thinRight: "\uE0B3" //
};

export const ASCII_SEPARATORS: SeparatorChars = {
   left: ">",
   right: "<",
   thinLeft: "|",
   thinRight: "|"
};

// Detect Nerd Font support (check TERM or specific env var)
export function hasNerdFonts(): boolean {
   // User can set this env var to force Nerd Fonts
   if (process.env.STATION_BAR_NERD_FONTS === "1") {
      return true;
   }
   if (process.env.STATION_BAR_NERD_FONTS === "0") {
      return false;
   }

   // Check for Ghostty (survives into tmux via GHOSTTY_RESOURCES_DIR)
   if (process.env.GHOSTTY_RESOURCES_DIR) {
      return true;
   }

   // Check common terminals known to support Nerd Fonts (case-insensitive)
   const term = (process.env.TERM_PROGRAM || "").toLowerCase();
   const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty"];
   return nerdTerms.some((t) => term.includes(t));
}

export function getIcons(): IconSet {
   const baseIcons = hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
   return {
      ...baseIcons,
      ...sanitizeUserIconOverrides(loadThemeConfig().icons)
   };
}

export function getSeparatorChars(): SeparatorChars {
   return hasNerdFonts() ? NERD_SEPARATORS : ASCII_SEPARATORS;
}
