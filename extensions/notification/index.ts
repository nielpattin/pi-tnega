import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const SOUND_PATH = join(homedir(), ".pi", "agent", "assets", "sounds_gow_active_reload.mp3");
const VOLUME = 20; // ffplay volume range: 0-100

function getVolume(): string {
   return String(Math.max(0, Math.min(100, VOLUME)));
}

export default function notificationExtension(pi: ExtensionAPI) {
   pi.on("agent_end", async (_event, ctx) => {
      if (!ctx.hasUI) return;

      try {
         await pi.exec("ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", "-volume", getVolume(), SOUND_PATH]);
      } catch (error) {
         console.warn("[notification] failed to play completion sound:", error);
      }
   });
}
