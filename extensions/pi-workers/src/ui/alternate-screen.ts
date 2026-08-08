import type { Component, TUI } from "@earendil-works/pi-tui";

const ALTERNATE_SCREEN_ENTER = "\u001b[?1049h\u001b[2J\u001b[H";
const ALTERNATE_SCREEN_EXIT = "\u001b[?1049l";

export function enterAlternateScreen(tui: TUI, screen?: Component): () => void {
   const previousChildren = screen ? [...tui.children] : undefined;
   if (screen) {
      tui.clear();
      tui.addChild(screen);
   }

   const useAlternateScreen = Boolean(process.stdout.isTTY);
   if (useAlternateScreen) tui.terminal.write(ALTERNATE_SCREEN_ENTER);
   tui.requestRender(true);

   let released = false;
   return () => {
      if (released) return;
      released = true;
      if (previousChildren) {
         tui.clear();
         for (const child of previousChildren) tui.addChild(child);
      }
      if (useAlternateScreen) tui.terminal.write(ALTERNATE_SCREEN_EXIT);
      tui.requestRender(true);
   };
}
