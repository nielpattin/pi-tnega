import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CODEX_VERBOSITY_LEVELS, saveCodexUsageConfig, type CodexUsageConfig, type CodexVerbosity } from "./config";

interface SettingsView {
   handleInput(data: string): boolean;
   render(theme: Theme, width: number): string[];
}

/** Open the interactive Codex request options screen (fast mode, verbosity). */
export async function openCodexSettingsScreen(
   ctx: ExtensionContext,
   config: CodexUsageConfig,
   onConfigChange: (next: CodexUsageConfig) => void
): Promise<void> {
   await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const view = createSettingsView(config, onConfigChange, () => tui.requestRender());

      return {
         render(width: number) {
            return view.render(theme, width);
         },
         invalidate() {},
         handleInput(data: string) {
            if (matchesKey(data, "escape")) {
               done(undefined);
               return true;
            }
            return view.handleInput(data);
         }
      };
   });
}

function createSettingsView(
   initial: CodexUsageConfig,
   onConfigChange: (next: CodexUsageConfig) => void,
   requestRender: () => void
): SettingsView {
   let current: CodexUsageConfig = { ...initial };
   let selected = 0;
   let saveError: string | undefined;

   const commit = (next: CodexUsageConfig) => {
      current = next;
      saveError = undefined;
      onConfigChange(next);
      requestRender();
      void saveCodexUsageConfig(next).catch((error: unknown) => {
         saveError = error instanceof Error ? error.message : String(error);
         requestRender();
      });
   };

   const cycleVerbosity = (delta: number) => {
      const index = CODEX_VERBOSITY_LEVELS.indexOf(current.verbosity);
      const next = (index + delta + CODEX_VERBOSITY_LEVELS.length) % CODEX_VERBOSITY_LEVELS.length;
      commit({ ...current, verbosity: CODEX_VERBOSITY_LEVELS[next] as CodexVerbosity });
   };

   return {
      handleInput(data: string) {
         if (matchesKey(data, "up")) {
            selected = 0;
            requestRender();
            return true;
         }
         if (matchesKey(data, "down")) {
            selected = 1;
            requestRender();
            return true;
         }

         if (selected === 0) {
            if (
               matchesKey(data, "enter") ||
               matchesKey(data, "space") ||
               matchesKey(data, "left") ||
               matchesKey(data, "right")
            ) {
               commit({ ...current, fast: !current.fast });
               return true;
            }
            return false;
         }

         if (matchesKey(data, "left")) {
            cycleVerbosity(-1);
            return true;
         }
         if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "space")) {
            cycleVerbosity(1);
            return true;
         }
         return false;
      },
      render(theme: Theme, width: number) {
         return formatSettingsLines(theme, current, selected, saveError, width);
      }
   };
}

export function formatSettingsLines(
   theme: Theme,
   config: CodexUsageConfig,
   selected: number,
   saveError: string | undefined,
   width = 80
): string[] {
   const safeWidth = Math.max(10, width);
   const cursor = (index: number) => (index === selected ? theme.fg("accent", "❯") : " ");
   const fastValue = config.fast ? theme.fg("success", "on") : theme.fg("dim", "off");

   const lines = [
      `  ${theme.bold("Codex settings")}`,
      theme.fg("dim", "  Up/Down to move · Enter/Space to toggle · Esc to close"),
      "",
      `  ${cursor(0)} Fast mode   ${fastValue}   use service_tier "priority" on Codex requests`,
      `  ${cursor(1)} Verbosity   ${theme.fg("text", config.verbosity)}   response detail (low / medium / high)`
   ];
   if (saveError) {
      const errorContentWidth = Math.max(10, safeWidth - 4);
      const wrapped = wrapTextWithAnsi(saveError, errorContentWidth);
      lines.push(...wrapped.map((line) => theme.fg("error", `  ${line}`)));
   }
   return lines.map((line) => truncateToWidth(line, safeWidth));
}
