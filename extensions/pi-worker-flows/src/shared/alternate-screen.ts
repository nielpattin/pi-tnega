import type { Component, TUI } from "@earendil-works/pi-tui";

const ALTERNATE_SCREEN_ENTER = "\u001b[?1049h\u001b[2J\u001b[H";
const ALTERNATE_SCREEN_EXIT = "\u001b[?1049l";

export interface AlternateScreenOptions {
   readonly useAlternateScreen?: boolean;
   readonly attachScreen?: boolean;
   readonly enterSequence?: string;
   readonly exitSequence?: string;
}

export function enterAlternateScreen(tui: TUI, screen?: Component, options: AlternateScreenOptions = {}): () => void {
   const attachScreen = options.attachScreen ?? screen !== undefined;
   const useAlternateScreen = options.useAlternateScreen ?? Boolean(process.stdout.isTTY);
   const previousChildren = attachScreen ? [...tui.children] : undefined;
   const enterSequence = options.enterSequence ?? ALTERNATE_SCREEN_ENTER;
   const exitSequence = options.exitSequence ?? ALTERNATE_SCREEN_EXIT;

   if (attachScreen && screen) {
      tui.clear();
      tui.addChild(screen);
   }
   if (useAlternateScreen) tui.terminal.write(enterSequence);
   tui.requestRender(true);

   let released = false;
   return () => {
      if (released) return;
      released = true;
      if (previousChildren) {
         tui.clear();
         for (const child of previousChildren) tui.addChild(child);
      }
      if (useAlternateScreen) tui.terminal.write(exitSequence);
      tui.requestRender(true);
   };
}
