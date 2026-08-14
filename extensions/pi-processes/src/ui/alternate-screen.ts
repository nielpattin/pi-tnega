import type { Component, TUI } from "@earendil-works/pi-tui";

const ALTERNATE_SCREEN_ENTER = "\u001b[?1049h\u001b[2J\u001b[H";
const ALTERNATE_SCREEN_EXIT = "\u001b[?1049l";

/** Replace the parent TUI contents with a real full-screen process surface. */
export function enterAlternateScreen(tui: TUI, screen: Component): () => void {
   const previousChildren = [...tui.children];
   tui.clear();
   tui.addChild(screen);

   const useAlternateScreen = Boolean(process.stdout.isTTY);
   if (useAlternateScreen) tui.terminal.write(ALTERNATE_SCREEN_ENTER);
   tui.requestRender(true);

   let released = false;
   return () => {
      if (released) return;
      released = true;
      tui.clear();
      for (const child of previousChildren) tui.addChild(child);
      if (useAlternateScreen) tui.terminal.write(ALTERNATE_SCREEN_EXIT);
      tui.requestRender(true);
   };
}
