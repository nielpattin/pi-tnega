import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TerminalSplitCompositor } from "../fixed-editor/terminal-split.ts";
import { readPersistedStashHistory } from "../stash/index.ts";
import type { StationConfig } from "../../station-config.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface LayoutCache {
   lastLayoutWidth: number;
   lastLayoutResult: {
      topContent: string;
      secondaryContent: string;
      tertiaryContent: string;
   } | null;
   lastLayoutTimestamp: number;
   layoutDirty: boolean;
   forceNextLayoutRecompute: boolean;
   lastEditorInputAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// StationBarState
// ═══════════════════════════════════════════════════════════════════════════

export class StationBarState {
   // Extension-scoped config
   config: StationConfig;
   customCompactionEnabled = false;
   enabled = true;

   // Session-scoped state
   currentCtx: any = null;
   sessionStartTime = Date.now();
   isStreaming = false;
   liveAssistantUsage: any = null;
   currentThinkingLevel: string | null = null;
   lastUserPrompt = "";
   showLastPrompt = true;
   stashedPromptHistory: string[] = [];
   currentEditor: any = null;

   // TUI refs
   footerDataRef: ReadonlyFooterDataProvider | null = null;
   getThinkingLevelFn: (() => string) | null = null;
   tuiRef: any = null;
   restoreFooterStatusRepaintHook: (() => void) | null = null;

   // Fixed editor compositor refs
   fixedEditorCompositor: TerminalSplitCompositor | null = null;
   fixedStatusContainer: any = null;
   fixedEditorContainer: any = null;
   fixedWidgetContainerAbove: any = null;
   fixedWidgetContainerBelow: any = null;

   // Layout cache
   lastLayoutWidth = 0;
   lastLayoutResult: {
      topContent: string;
      secondaryContent: string;
      tertiaryContent: string;
   } | null = null;
   lastLayoutTimestamp = 0;
   layoutDirty = true;
   forceNextLayoutRecompute = false;
   lastEditorInputAt = 0;

   constructor(config: StationConfig) {
      this.config = config;
      this.stashedPromptHistory = readPersistedStashHistory();
   }

   /** Called on session_start — resets all session-scoped state. */
   startSession(
      ctx: any,
      settings: {
         showLastPrompt: boolean;
         customCompactionEnabled: boolean;
      }
   ): void {
      this.showLastPrompt = settings.showLastPrompt;
      this.customCompactionEnabled = settings.customCompactionEnabled;

      this.currentCtx = ctx;
      this.sessionStartTime = Date.now();
      this.isStreaming = false;
      this.liveAssistantUsage = null;
      this.currentThinkingLevel = null;
      this.lastUserPrompt = "";
      this.stashedPromptHistory = readPersistedStashHistory();
      this.currentEditor = null;

      this.getThinkingLevelFn = typeof ctx.getThinkingLevel === "function" ? () => ctx.getThinkingLevel() : null;
      this.currentThinkingLevel = this.getThinkingLevelFn?.() ?? null;

      this.layoutDirty = true;
   }

   /** Called on session_shutdown — clears session-scoped state. */
   endSession(): void {
      this.restoreFooterStatusRepaintHook?.();
      this.restoreFooterStatusRepaintHook = null;
      this.clearFixedEditorRefs();
      this.currentCtx = null;
      this.footerDataRef = null;
      this.currentEditor = null;
      this.getThinkingLevelFn = null;
      this.currentThinkingLevel = null;
      this.liveAssistantUsage = null;
      this.tuiRef = null;
      this.resetLayoutCache();
   }

   // ── Layout cache ──

   resetLayoutCache(): void {
      this.lastLayoutResult = null;
      this.layoutDirty = true;
   }

   // ── Fixed editor cleanup ──

   private clearFixedEditorRefs(): void {
      this.fixedEditorCompositor = null;
      this.fixedStatusContainer = null;
      this.fixedEditorContainer = null;
      this.fixedWidgetContainerAbove = null;
      this.fixedWidgetContainerBelow = null;
   }
}
