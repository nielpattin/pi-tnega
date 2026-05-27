import { expect, test } from "vitest";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { SessionListOverlay } from "../../extensions/pi-intercom/ui/session-list.ts";
import type { SessionInfo } from "../../extensions/pi-intercom/types.ts";

function createSession(id: string, name: string): SessionInfo {
   return {
      id,
      name,
      cwd: "C:/repo/project",
      model: "gpt-test",
      status: "idle",
      updatedAt: 1,
      startedAt: 1,
   };
}

const theme = {
   fg: (_color: string, text: string) => text,
   bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
   matches: (data: string, action: string) => {
      if (action === "tui.select.up") return data === "up";
      if (action === "tui.select.down") return data === "down";
      if (action === "tui.select.confirm") return data === "enter";
      if (action === "tui.select.cancel") return data === "escape";
      return false;
   },
   getKeys: () => [],
} as unknown as KeybindingsManager;

test("pressing C copies only the selected other session name", () => {
   const current = createSession("current-session", "current");
   const target = createSession("target-session", "planner");
   let copiedText: string | undefined;

   const overlay = new SessionListOverlay(theme, keybindings, current, [target], () => undefined, (text) => {
      copiedText = text;
   });

   overlay.handleInput("C");

   expect(copiedText).toBe("planner");
});

test("pressing up from the first other session selects current session for copy", () => {
   const current = createSession("current-session", "current");
   const target = createSession("target-session", "planner");
   let copiedText: string | undefined;

   const overlay = new SessionListOverlay(theme, keybindings, current, [target], () => undefined, (text) => {
      copiedText = text;
   });

   overlay.handleInput("up");
   overlay.handleInput("C");

   expect(copiedText).toBe("current");
});

test("pressing C copies current session name when there are no other sessions", () => {
   const current = createSession("current-session", "current");
   let copiedText: string | undefined;

   const overlay = new SessionListOverlay(theme, keybindings, current, [], () => undefined, (text) => {
      copiedText = text;
   });

   overlay.handleInput("C");

   expect(copiedText).toBe("current");
});
