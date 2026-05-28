import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";

interface NotificationConfig {
   sound?: unknown;
   volume?: unknown;
}

interface NotificationSettings {
   sound: string;
   volume: number;
}

function agentDir(override?: string): string {
   return override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function settingsPath(agentDirOverride?: string): string {
   return join(agentDir(agentDirOverride), "settings.json");
}

function clampVolume(value: number): number {
   return Math.min(100, Math.max(0, Math.round(value)));
}

function expandHome(path: string): string {
   if (path === "~") return homedir();
   if (path.startsWith("~/")) return join(homedir(), path.slice(2));
   if (path === "$HOME") return homedir();
   if (path.startsWith("$HOME/")) return join(homedir(), path.slice(6));
   return path;
}

function resolveSoundPath(value: unknown, configDir: string): string | undefined {
   if (typeof value !== "string") return undefined;
   const trimmed = value.trim();
   if (!trimmed) return undefined;
   const expanded = expandHome(trimmed);
   if (isAbsolute(expanded)) return expanded;
   return join(configDir, expanded);
}

export function loadNotificationSettings(agentDirOverride?: string): NotificationSettings {
   const path = settingsPath(agentDirOverride);
   const defaults: NotificationSettings = {
      sound: join(agentDir(agentDirOverride), "assets", "done.mp3"),
      volume: 100
   };

   if (!existsSync(path)) return defaults;

   try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
      const notification = (parsed as { notification?: unknown }).notification;
      if (!notification || typeof notification !== "object" || Array.isArray(notification)) return defaults;
      const config = notification as NotificationConfig;

      return {
         sound: resolveSoundPath(config.sound, dirname(path)) ?? defaults.sound,
         volume: typeof config.volume === "number" ? clampVolume(config.volume) : defaults.volume
      };
   } catch {
      return defaults;
   }
}

export default function notificationExtension(pi: ExtensionAPI) {
   pi.on("agent_end", async (_event, ctx) => {
      if (!ctx.hasUI) return;

      const settings = loadNotificationSettings();

      try {
         await pi.exec("ffplay", [
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "error",
            "-volume",
            String(settings.volume),
            settings.sound
         ]);
      } catch (error) {
         console.warn("[notification] failed to play completion sound:", error);
      }
   });
}
