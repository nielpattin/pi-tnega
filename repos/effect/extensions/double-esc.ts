import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type EditorTheme } from "@earendil-works/pi-tui";

export interface DoubleEscState {
   hintActive: boolean;
   lastEscTime: number;
}

export function createInitialState(): DoubleEscState {
   return {
      hintActive: false,
      lastEscTime: 0
   };
}

export function getDefaultDebounceMs(): number {
   const envVal = process.env.PI_DOUBLE_ESC_MS;
   if (envVal) {
      const parsed = Number.parseInt(envVal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
         return parsed;
      }
   }
   return 1500;
}

export interface HandleEscapeResult {
   nextState: DoubleEscState;
   action: "abort" | "show_hint" | "nothing";
}

export function handleEscape(
   state: DoubleEscState,
   isIdle: boolean,
   now: number = Date.now(),
   debounceMs: number = getDefaultDebounceMs()
): HandleEscapeResult {
   if (isIdle) {
      return {
         nextState: { hintActive: false, lastEscTime: 0 },
         action: "nothing"
      };
   }

   const elapsed = now - state.lastEscTime;
   if (state.lastEscTime > 0 && elapsed <= debounceMs) {
      return {
         nextState: { hintActive: false, lastEscTime: 0 },
         action: "abort"
      };
   }

   return {
      nextState: { hintActive: true, lastEscTime: now },
      action: "show_hint"
   };
}

export function handleOtherKey(state: DoubleEscState): DoubleEscState {
   if (!state.hintActive && state.lastEscTime === 0) {
      return state;
   }
   return { hintActive: false, lastEscTime: 0 };
}

export function handleTimeout(
   state: DoubleEscState,
   now: number = Date.now(),
   debounceMs: number = getDefaultDebounceMs()
): DoubleEscState {
   if (!state.hintActive && state.lastEscTime === 0) {
      return state;
   }
   if (now - state.lastEscTime > debounceMs) {
      return { hintActive: false, lastEscTime: 0 };
   }
   return state;
}

export class DoubleEscapeEditor extends CustomEditor {
   private doubleEscState: DoubleEscState = createInitialState();
   private hintTimer: NodeJS.Timeout | null = null;
   private isIdle: () => boolean;

   constructor(tui: any, theme: EditorTheme, keybindings: any, isIdle: () => boolean) {
      super(tui, theme, keybindings);
      this.isIdle = isIdle;
   }

   private clearHintTimer(): void {
      if (this.hintTimer) {
         clearTimeout(this.hintTimer);
         this.hintTimer = null;
      }
   }

   private scheduleHintExpiry(debounceMs: number): void {
      this.clearHintTimer();
      this.hintTimer = setTimeout(() => {
         this.doubleEscState = handleTimeout(this.doubleEscState, Date.now(), debounceMs);
         this.tui.requestRender();
      }, debounceMs);
   }

   override handleInput(data: string): void {
      const debounceMs = getDefaultDebounceMs();

      if (matchesKey(data, "escape")) {
         const isIdleState = this.isIdle();
         const res = handleEscape(this.doubleEscState, isIdleState, Date.now(), debounceMs);
         this.doubleEscState = res.nextState;

         if (res.action === "abort") {
            this.clearHintTimer();
            super.handleInput(data);
         } else if (res.action === "show_hint") {
            this.scheduleHintExpiry(debounceMs);
            this.tui.requestRender();
         } else {
            this.clearHintTimer();
            super.handleInput(data);
         }
         return;
      }

      this.doubleEscState = handleOtherKey(this.doubleEscState);
      this.clearHintTimer();
      super.handleInput(data);
   }

   override render(width: number): string[] {
      const lines = super.render(width);
      if (!this.doubleEscState.hintActive || lines.length === 0) {
         return lines;
      }

      const hintText = " esc again to abort ";
      const hintLen = visibleWidth(hintText);
      const lastIdx = lines.length - 1;
      const lastLine = lines[lastIdx];
      const lastLineLen = visibleWidth(lastLine);

      if (lastLineLen >= width) {
         lines[lastIdx] = truncateToWidth(lastLine, Math.max(0, width - hintLen)) + hintText;
      } else {
         const padLen = Math.max(0, width - lastLineLen - hintLen);
         lines[lastIdx] = lastLine + " ".repeat(padLen) + hintText;
      }

      return lines;
   }
}

export default function doubleEscExtension(api: ExtensionAPI): void {
   api.on("session_start", (_session, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setEditorComponent((tui: any, theme: EditorTheme, keybindings: any) => {
         return new DoubleEscapeEditor(tui, theme, keybindings, () => ctx.isIdle());
      });
   });
}
