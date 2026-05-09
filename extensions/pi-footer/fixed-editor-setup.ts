import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PowerlineConfig } from "./powerline-config";
import type { PowerlineShortcuts } from "./helpers";
import type { RenderFunctions } from "./powerline-render";
import { copyTextToClipboard } from "./stash-commands";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.ts";
import { emergencyTerminalModeReset, TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Fixed Editor State
// ═══════════════════════════════════════════════════════════════════════════

export interface FixedEditorState {
   compositor: TerminalSplitCompositor | null;
   statusContainer: any;
   editorContainer: any;
   widgetContainerAbove: any;
   widgetContainerBelow: any;
   transcriptScrollState: { offset: number; maxScroll: number; totalLines: number; prevCommandCount: number };
}

export function createFixedEditorState(): FixedEditorState {
   return {
      compositor: null,
      statusContainer: null,
      editorContainer: null,
      widgetContainerAbove: null,
      widgetContainerBelow: null,
      transcriptScrollState: { offset: 0, maxScroll: 0, totalLines: 0, prevCommandCount: 0 },
   };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixed Editor Context
// ═══════════════════════════════════════════════════════════════════════════

export interface FixedEditorContext {
   renderFns: RenderFunctions;
   state: FixedEditorState;
   getConfig: () => PowerlineConfig;
   getCurrentEditor: () => any;
   getResolvedShortcuts: () => PowerlineShortcuts;
   getCurrentCtx: () => any;
   getFooterDataRef: () => ReadonlyFooterDataProvider | null;
   getBashModeActive: () => boolean;
   requestStatusRender: () => void;
   resetLayoutCache: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixed Editor Functions
// ═══════════════════════════════════════════════════════════════════════════

export function teardownFixedEditorCompositor(
   state: FixedEditorState,
   options?: { resetExtendedKeyboardModes?: boolean },
): void {
   const hadCompositor = state.compositor !== null;
   state.compositor?.dispose(options);
   if (!hadCompositor && options?.resetExtendedKeyboardModes) {
      try {
         process.stdout.write(emergencyTerminalModeReset());
      } catch {
         // Shutdown cleanup cannot surface useful terminal write failures.
      }
   }
   state.compositor = null;
   state.statusContainer = null;
   state.editorContainer = null;
   state.widgetContainerAbove = null;
   state.widgetContainerBelow = null;
}

function findContainerWithChild(tui: any, child: any): { container: any; index: number } | null {
   const children = Array.isArray(tui?.children) ? tui.children : [];
   const index = children.findIndex(
      (candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child),
   );
   if (index === -1) return null;
   return { container: children[index], index };
}

export function installFixedEditorCompositor(fec: FixedEditorContext, ctx: any, tui: any): void {
   teardownFixedEditorCompositor(fec.state);

   const config = fec.getConfig();
   const currentEditor = fec.getCurrentEditor();
   const resolvedShortcuts = fec.getResolvedShortcuts();
   const currentCtx = fec.getCurrentCtx();

   if (!ctx.hasUI || !config.fixedEditor) return;
   if (!tui?.terminal || typeof tui.terminal.write !== "function") {
      throw new Error("[powerline-footer] Fixed editor compositor could not find tui.terminal.write()");
   }
   if (!currentEditor) {
      throw new Error("[powerline-footer] Fixed editor compositor expected the custom editor to be installed first");
   }

   const editorContainerMatch = findContainerWithChild(tui, currentEditor);
   if (!editorContainerMatch) {
      throw new Error("[powerline-footer] Fixed editor compositor could not find the editor container in TUI children");
   }

   const tuiChildren = Array.isArray(tui.children) ? tui.children : [];
   fec.state.editorContainer = editorContainerMatch.container;
   const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2] ?? null;
   fec.state.statusContainer =
      statusContainerCandidate && typeof statusContainerCandidate.render === "function"
         ? statusContainerCandidate
         : null;
   fec.state.widgetContainerAbove = tuiChildren[editorContainerMatch.index - 1] ?? null;
   fec.state.widgetContainerBelow = tuiChildren[editorContainerMatch.index + 1] ?? null;

   let compositor: TerminalSplitCompositor;
   compositor = new TerminalSplitCompositor({
      tui,
      terminal: tui.terminal,
      mouseScroll: config.mouseScroll,
      transcriptScrollState: fec.state.transcriptScrollState,
      keyboardScrollShortcuts: {
         up: resolvedShortcuts.scrollChatUp,
         down: resolvedShortcuts.scrollChatDown,
      },
      onCopySelection: (text: string) => copyTextToClipboard(ctx, text),
      getShowHardwareCursor: () => typeof tui.getShowHardwareCursor === "function" && tui.getShowHardwareCursor(),
      renderCluster: (width: number, terminalRows: number) => {
         const theme = currentCtx?.ui?.theme ?? ctx.ui.theme;
         const statusContainerLines = fec.state.statusContainer
            ? compositor.renderHidden(fec.state.statusContainer, width).filter((line: string) => visibleWidth(line) > 0)
            : [];
         const aboveWidgetLines = fec.state.widgetContainerAbove
            ? compositor.renderHidden(fec.state.widgetContainerAbove, width)
            : [];
         const belowWidgetLines = fec.state.widgetContainerBelow
            ? compositor.renderHidden(fec.state.widgetContainerBelow, width)
            : [];
         return renderFixedEditorCluster({
            width,
            terminalRows,
            bashModeActive: fec.getBashModeActive(),
            statusLines: [
               ...aboveWidgetLines,
               ...fec.renderFns.renderPowerlineStatusLines(width),
               ...statusContainerLines,
            ],
            topLines: [],
            editorLines: fec.state.editorContainer ? compositor.renderHidden(fec.state.editorContainer, width) : [],
            secondaryLines: [
               ...fec.renderFns.renderPowerlinePathLines(width, theme),
               ...fec.renderFns.renderPowerlineTopLines(width, theme),
               ...fec.renderFns.renderPowerlineExtensionLines(width, theme),
               ...fec.renderFns.renderPowerlineSecondaryLines(width, theme),
               ...belowWidgetLines,
            ],
            transcriptLines: fec.renderFns.renderBashTranscriptLines(width, theme),
            lastPromptLines: fec.renderFns.renderLastPromptLines(width),
         });
      },
   });

   fec.state.compositor = compositor;
   if (fec.state.statusContainer?.render) compositor.hideRenderable(fec.state.statusContainer);
   if (fec.state.widgetContainerAbove?.render) compositor.hideRenderable(fec.state.widgetContainerAbove);
   compositor.hideRenderable(fec.state.editorContainer);
   if (fec.state.widgetContainerBelow?.render) compositor.hideRenderable(fec.state.widgetContainerBelow);
   compositor.install();
   tui.requestRender(true);
}

export function installPowerlineWidgets(fec: FixedEditorContext, ctx: any): void {
   ctx.ui.setWidget(
      "powerline-status",
      () => ({
         dispose() {},
         invalidate() {
            fec.requestStatusRender();
         },
         render(width: number): string[] {
            return fec.renderFns.renderPowerlineStatusLines(width);
         },
      }),
      { placement: "aboveEditor" },
   );

   ctx.ui.setWidget(
      "powerline-path",
      (_tui: any, theme: any) => ({
         dispose() {},
         invalidate() {
            fec.resetLayoutCache();
         },
         render(width: number): string[] {
            return fec.renderFns.renderPowerlinePathLines(width, theme);
         },
      }),
      { placement: "belowEditor" },
   );

   ctx.ui.setWidget(
      "powerline-top",
      (_tui: any, theme: any) => ({
         dispose() {},
         invalidate() {
            fec.resetLayoutCache();
         },
         render(width: number): string[] {
            return fec.renderFns.renderPowerlineTopLines(width, theme);
         },
      }),
      { placement: "belowEditor" },
   );

   ctx.ui.setWidget(
      "powerline-extension-statuses",
      (_tui: any, theme: any) => ({
         dispose() {},
         invalidate() {
            fec.resetLayoutCache();
         },
         render(width: number): string[] {
            return fec.renderFns.renderPowerlineExtensionLines(width, theme);
         },
      }),
      { placement: "belowEditor" },
   );

   ctx.ui.setWidget(
      "powerline-secondary",
      (_tui: any, theme: any) => ({
         dispose() {},
         invalidate() {
            fec.resetLayoutCache();
         },
         render(width: number): string[] {
            return fec.renderFns.renderPowerlineSecondaryLines(width, theme);
         },
      }),
      { placement: "belowEditor" },
   );

   ctx.ui.setWidget(
      "powerline-bash-transcript",
      (_tui: any, theme: any) => ({
         dispose() {},
         invalidate() {},
         render(width: number): string[] {
            return fec.renderFns.renderBashTranscriptLines(width, theme);
         },
      }),
      { placement: "belowEditor" },
   );

   ctx.ui.setWidget(
      "powerline-last-prompt",
      () => ({
         dispose() {},
         invalidate() {},
         render(width: number): string[] {
            return fec.renderFns.renderLastPromptLines(width);
         },
      }),
      { placement: "belowEditor" },
   );
}
