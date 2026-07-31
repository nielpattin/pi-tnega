import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeybindingsManager = any;
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { getOneOffBashCommandContext } from "./completion.ts";
import type { GhostSuggestion } from "./types.ts";

interface BashModeEditorOptions {
   keybindings: KeybindingsManager;
   isBashModeActive: () => boolean;
   isShellRunning: () => boolean;
   onExitBashMode: () => void;
   onSubmitCommand: (command: string) => void;
   onEditorSubmit?: () => void;
   onInterrupt: () => void;
   onNotify: (message: string, level?: "info" | "warning" | "error") => void;
   getHistoryEntries: (prefix: string) => string[];
   resolveGhostSuggestion: (text: string, signal: AbortSignal) => Promise<GhostSuggestion | null>;
   undoKey?: string;
   redoKey?: string;
}

function isPrintableInput(data: string): boolean {
   return data.length === 1 && data.charCodeAt(0) >= 32;
}

function bracketedPasteContent(data: string): string | null {
   const startMarker = "\x1b[200~";
   const endMarker = "\x1b[201~";
   const start = data.indexOf(startMarker);
   if (start !== 0) {
      return null;
   }

   const end = data.indexOf(endMarker, startMarker.length);
   if (end === -1 || end + endMarker.length !== data.length) {
      return null;
   }

   return data.slice(startMarker.length, end);
}

function decodeFileUriList(text: string): string | null {
   const entries = text
      .split(/\r?\n|\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

   if (entries.length === 0 || entries.some((entry) => !entry.startsWith("file://"))) {
      return null;
   }

   try {
      return entries.map((entry) => fileURLToPath(entry)).join(" ");
   } catch {
      return null;
   }
}

function droppedPathTextFromInput(data: string): string | null {
   const pasteContent = bracketedPasteContent(data);
   const text = pasteContent ?? data;
   const uriList = decodeFileUriList(text);
   if (uriList) {
      return uriList;
   }

   const trimmed = text.replace(/^[\r\n]+|[\r\n]+$/g, "");
   if (trimmed.length <= 1 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
      return null;
   }

   if (/^(?:\/|~\/|\.\.?\/)/.test(trimmed) && !/[\r\n]/.test(trimmed)) {
      return trimmed;
   }

   return null;
}

export class BashModeEditor extends CustomEditor {
   private readonly keybindingsRef: KeybindingsManager;
   private readonly optionsRef: BashModeEditorOptions;
   private wrappedProviderInstalled = false;
   private shellHistoryIndex = -1;
   private shellHistoryItems: string[] = [];
   private shellHistoryDraft = "";
   private ghost: GhostSuggestion | null = null;
   private ghostAbort: AbortController | null = null;
   private ghostToken = 0;
   // Redo support: mirrors states popped from the parent undo stack.
   private redoStack: unknown[] = [];
   private suppressRedoClear = false;

   constructor(tui: any, theme: any, keybindings: KeybindingsManager, options: BashModeEditorOptions) {
      super(tui, theme, keybindings);
      this.keybindingsRef = keybindings;
      this.optionsRef = options;

      // Monkey-patch the parent UndoStack.push so any new edit clears the redo stack.
      // Standard undo/redo semantics: once you make a new edit after undoing, redo is gone.
      const undoStack = Reflect.get(this, "undoStack");
      if (undoStack && typeof undoStack.push === "function") {
         const originalPush = undoStack.push.bind(undoStack);
         undoStack.push = (state: unknown) => {
            if (!this.suppressRedoClear) {
               this.redoStack.length = 0;
            }
            return originalPush(state);
         };
      }
   }

   installAutocompleteProvider(provider: AutocompleteProvider): void {
      this.setAutocompleteProvider(provider);
      this.wrappedProviderInstalled = true;
   }

   hasWrappedProvider(): boolean {
      return this.wrappedProviderInstalled;
   }

   getGhostSuggestion(): GhostSuggestion | null {
      return this.isShellCompletionContext() ? this.ghost : null;
   }

   refreshGhostSuggestion(): void {
      this.scheduleGhostUpdate();
   }

   clearGhostSuggestion(): void {
      this.ghostAbort?.abort();
      this.ghostAbort = null;
      this.ghost = null;
   }

   dismissBashModeUi(): void {
      this.shellHistoryIndex = -1;
      this.shellHistoryItems = [];
      this.shellHistoryDraft = "";
      this.clearGhostSuggestion();

      this.tryCancelAutocomplete();
      this.tui.requestRender();
   }

   private tryCancelAutocomplete(): void {
      if (typeof (this as unknown as { cancelAutocomplete?: unknown }).cancelAutocomplete === "function") {
         (this as unknown as { cancelAutocomplete: () => void }).cancelAutocomplete();
      }
   }

   override handleInput(data: string): void {
      // Redo key — restore a previously undone state.
      if (this.optionsRef.redoKey && matchesKey(data, this.optionsRef.redoKey as KeyId)) {
         this.performRedo();
         return;
      }

      // Undo key — either the custom ctrl+z or the built-in tui.editor.undo (ctrl+-).
      // We intercept both so we can capture the pre-undo state for redo.
      const isCustomUndo = this.optionsRef.undoKey && matchesKey(data, this.optionsRef.undoKey as KeyId);
      const isBuiltinUndo = this.keybindingsRef?.matches(data, "tui.editor.undo");
      if (isCustomUndo || isBuiltinUndo) {
         this.performUndo();
         return;
      }

      const droppedPathText = droppedPathTextFromInput(data);
      if (droppedPathText !== null) {
         this.insertTextAtCursor(droppedPathText);
         this.shellHistoryIndex = -1;
         this.shellHistoryItems = [];
         this.shellHistoryDraft = "";
         if (this.isShellCompletionContext()) {
            this.scheduleGhostUpdate();
         } else {
            this.clearGhostSuggestion();
         }
         return;
      }

      const pasteInProgress = data.includes("\x1b[200~") || Reflect.get(this, "isInPaste") === true;
      if (pasteInProgress) {
         super.handleInput(data);
         if (Reflect.get(this, "isInPaste") === true) {
            return;
         }
      } else {
         const bashMode = this.optionsRef.isBashModeActive();
         const oneOffBashCommand = !bashMode && this.isOneOffBashCommandContext();

         if (bashMode && this.keybindingsRef.matches(data, "app.interrupt")) {
            this.optionsRef.onExitBashMode();
            return;
         }

         if (bashMode && this.keybindingsRef.matches(data, "app.clear") && this.optionsRef.isShellRunning()) {
            this.optionsRef.onInterrupt();
            return;
         }

         if (bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorUp")) {
            this.navigateShellHistory(-1);
            return;
         }

         if (bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorDown")) {
            this.navigateShellHistory(1);
            return;
         }

         if ((bashMode || oneOffBashCommand) && this.keybindingsRef.matches(data, "tui.input.tab")) {
            this.acceptGhostSuggestion();
            return;
         }

         if (
            (bashMode || oneOffBashCommand) &&
            this.keybindingsRef.matches(data, "tui.editor.cursorRight") &&
            this.acceptGhostSuggestion()
         ) {
            return;
         }

         if (
            bashMode &&
            this.keybindingsRef.matches(data, "tui.input.submit") &&
            !this.keybindingsRef.matches(data, "tui.input.newLine")
         ) {
            if (this.optionsRef.isShellRunning()) {
               this.optionsRef.onNotify("Shell command already running", "warning");
               return;
            }

            const command = this.getExpandedText().trim();
            if (!command) {
               return;
            }
            this.clearGhostSuggestion();
            this.shellHistoryIndex = -1;
            this.shellHistoryItems = [];
            this.shellHistoryDraft = "";
            this.optionsRef.onEditorSubmit?.();
            this.optionsRef.onSubmitCommand(command);
            this.setText("");
            this.refreshGhostSuggestion();
            return;
         }

         super.handleInput(data);
      }

      if (!this.isShellCompletionContext()) {
         this.shellHistoryIndex = -1;
         this.shellHistoryItems = [];
         this.shellHistoryDraft = "";
         this.clearGhostSuggestion();
         return;
      }

      if (
         pasteInProgress ||
         isPrintableInput(data) ||
         this.keybindingsRef.matches(data, "tui.editor.deleteCharBackward") ||
         this.keybindingsRef.matches(data, "tui.editor.deleteCharForward") ||
         this.keybindingsRef.matches(data, "tui.editor.deleteWordBackward") ||
         this.keybindingsRef.matches(data, "tui.editor.deleteWordForward") ||
         this.keybindingsRef.matches(data, "tui.editor.deleteToLineStart") ||
         this.keybindingsRef.matches(data, "tui.editor.deleteToLineEnd") ||
         this.keybindingsRef.matches(data, "tui.input.newLine") ||
         this.keybindingsRef.matches(data, "tui.editor.cursorLeft") ||
         this.keybindingsRef.matches(data, "tui.editor.cursorRight")
      ) {
         this.shellHistoryIndex = -1;
         this.shellHistoryItems = [];
         this.shellHistoryDraft = "";
         this.scheduleGhostUpdate();
      }
   }

   override render(width: number): string[] {
      const lines = super.render(width);
      if (!this.isShellCompletionContext()) {
         return lines;
      }
      if (!this.ghost) {
         return lines;
      }

      const text = this.getText();
      if (text.includes("\n")) {
         return lines;
      }
      const cursor = this.getCursor();
      if (cursor.line !== 0 || cursor.col !== text.length) {
         return lines;
      }
      if (!this.ghost.value.startsWith(text) || this.ghost.value === text) {
         return lines;
      }
      if (lines.length < 3) {
         return lines;
      }

      const suffix = this.ghost.value.slice(text.length);
      const contentLine = 1;
      const cursorBlock = "\x1b[7m \x1b[0m";
      const availableWidth = Math.max(0, width - visibleWidth(text) - 1);
      if (availableWidth === 0) {
         return lines;
      }

      const shownSuffix = truncateToWidth(suffix, availableWidth, "", true);
      if (!shownSuffix) {
         return lines;
      }

      const padding = " ".repeat(Math.max(0, width - visibleWidth(text) - 1 - visibleWidth(shownSuffix)));
      const ghost = `\x1b[38;5;244m${shownSuffix}\x1b[0m`;
      lines[contentLine] = `${text}${cursorBlock}${ghost}${padding}`;
      return lines;
   }

   private isShellCompletionContext(): boolean {
      return this.optionsRef.isBashModeActive() || this.isOneOffBashCommandContext();
   }

   private isOneOffBashCommandContext(): boolean {
      return getOneOffBashCommandContext(this.getExpandedText()) !== null;
   }

   private moveCursorToEditorBoundary(position: "start" | "end"): void {
      const state = Reflect.get(this, "state");
      const lines = state && typeof state === "object" ? Reflect.get(state, "lines") : null;
      if (!Array.isArray(lines)) {
         throw new Error("Editor cursor state is unavailable");
      }

      if (position === "start") {
         Reflect.set(state, "cursorLine", 0);
         Reflect.set(state, "cursorCol", 0);
      } else {
         const lastLine = Math.max(0, lines.length - 1);
         Reflect.set(state, "cursorLine", lastLine);
         Reflect.set(state, "cursorCol", typeof lines[lastLine] === "string" ? lines[lastLine].length : 0);
      }

      Reflect.set(this, "lastAction", null);
      Reflect.set(this, "preferredVisualCol", null);
      Reflect.set(this, "snappedFromCursorCol", null);
      this.tui.requestRender();
   }

   private acceptGhostSuggestion(): boolean {
      if (!this.ghost) {
         return false;
      }
      const text = this.getExpandedText();
      if (text.includes("\n")) {
         return false;
      }

      const cursor = this.getCursor();
      if (cursor.line !== 0 || cursor.col !== text.length) {
         return false;
      }

      if (!this.ghost.value.startsWith(text) || this.ghost.value === text) {
         return false;
      }
      this.setText(this.ghost.value);
      this.clearGhostSuggestion();
      return true;
   }

   private navigateShellHistory(direction: -1 | 1): void {
      const prefix = this.shellHistoryDraft || this.getExpandedText();
      if (this.shellHistoryIndex === -1) {
         this.shellHistoryDraft = prefix;
         this.shellHistoryItems = this.optionsRef.getHistoryEntries(prefix);
      }

      if (this.shellHistoryItems.length === 0) {
         this.optionsRef.onNotify("No shell history matches", "info");
         return;
      }

      if (direction < 0) {
         this.shellHistoryIndex = Math.min(this.shellHistoryItems.length - 1, this.shellHistoryIndex + 1);
         this.setText(this.shellHistoryItems[this.shellHistoryIndex] ?? this.shellHistoryDraft);
         this.clearGhostSuggestion();
         return;
      }

      this.shellHistoryIndex -= 1;
      if (this.shellHistoryIndex < 0) {
         this.shellHistoryIndex = -1;
         this.setText(this.shellHistoryDraft);
         this.scheduleGhostUpdate();
         return;
      }

      this.setText(this.shellHistoryItems[this.shellHistoryIndex] ?? this.shellHistoryDraft);
      this.clearGhostSuggestion();
   }

   private scheduleGhostUpdate(): void {
      const text = this.getExpandedText();
      const currentToken = ++this.ghostToken;
      this.ghostAbort?.abort();

      const controller = new AbortController();
      this.ghostAbort = controller;
      this.optionsRef
         .resolveGhostSuggestion(text, controller.signal)
         .then((ghost) => {
            if (controller.signal.aborted || currentToken !== this.ghostToken) {
               return;
            }
            this.ghost = ghost;
            this.tui.requestRender();
         })
         .catch((error) => {
            if (error instanceof Error && error.message === "aborted") {
               return;
            }
            console.debug("[station-bar] Failed to resolve bash ghost suggestion:", error);
         });
   }

   /**
    * Undo: pop the latest snapshot from the parent undo stack and restore it.
    * Mirrors the parent Editor.undo() logic but adds redo capture.
    */
   private performUndo(): void {
      // Exit prompt-history browsing (up/down navigation) — mirrors parent exitHistoryBrowsing().
      Reflect.set(this, "historyIndex", -1);
      Reflect.set(this, "historyDraft", null);

      const undoStack = Reflect.get(this, "undoStack");
      const snapshot = undoStack?.pop?.();
      if (!snapshot) return;

      const state = Reflect.get(this, "state");
      if (state) {
         this.redoStack.push(structuredClone(state));
      }

      Object.assign(state, snapshot);
      Reflect.set(this, "lastAction", null);
      Reflect.set(this, "preferredVisualCol", null);

      const onChange = Reflect.get(this, "onChange");
      if (typeof onChange === "function") {
         onChange(this.getText());
      }
      this.tui.requestRender();
   }

   /**
    * Redo: pop a state from the redo stack and restore it.
    * The current state is pushed back onto the undo stack (without clearing redo)
    * so the user can undo again.
    */
   private performRedo(): void {
      const snapshot = this.redoStack.pop();
      if (!snapshot) return;

      const state = Reflect.get(this, "state");
      const undoStack = Reflect.get(this, "undoStack");

      // Push current state back to undo stack. Suppress the redo-clear so the
      // monkey-patched push doesn't wipe the redo stack we're iterating.
      this.suppressRedoClear = true;
      try {
         undoStack?.push?.(state);
      } finally {
         this.suppressRedoClear = false;
      }

      Object.assign(state, snapshot);
      Reflect.set(this, "lastAction", null);
      Reflect.set(this, "preferredVisualCol", null);

      const onChange = Reflect.get(this, "onChange");
      if (typeof onChange === "function") {
         onChange(this.getText());
      }
      this.tui.requestRender();
   }
}
