import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { stripJsonComments } from "./config-loader";
import type { PermissionDecisionUi, PermissionPromptDecision, RequestPermissionOptions } from "./permission-dialog";

interface RawPermissionSoundSettings {
   sound?: unknown;
   volume?: unknown;
}

export interface PermissionSoundSettings {
   sound: string;
   volume: number;
}

export type PermissionSoundExec = (command: string, args: string[]) => unknown;

export type RequestPermissionDecisionFromUi = (
   ui: PermissionDecisionUi,
   title: string,
   message: string,
   options?: RequestPermissionOptions
) => Promise<PermissionPromptDecision>;

export interface AudiblePermissionDecisionRequesterDeps {
   agentDir: string;
   exec?: PermissionSoundExec;
   requestPermissionDecisionFromUi: RequestPermissionDecisionFromUi;
   warn?: (message: string, error: unknown) => void;
}

function defaultPermissionSoundSettings(agentDir: string): PermissionSoundSettings {
   return {
      sound: join(agentDir, "assets", "permission-request.mp3"),
      volume: 100
   };
}

function normalizeVolume(value: number): number {
   return Math.max(0, Math.round(value));
}

function ffplayArgsForSound(settings: PermissionSoundSettings): string[] {
   const startupVolume = Math.min(100, settings.volume);
   const args = ["-nodisp", "-autoexit", "-loglevel", "error", "-volume", String(startupVolume)];

   if (settings.volume > 100) {
      args.push("-af", `volume=${settings.volume / 100}`);
   }

   args.push(settings.sound);
   return args;
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

export function loadPermissionSoundSettings(agentDir: string): PermissionSoundSettings {
   const settingsPath = join(agentDir, "settings.json");
   const defaults = defaultPermissionSoundSettings(agentDir);

   try {
      const parsed = JSON.parse(stripJsonComments(readFileSync(settingsPath, "utf8"))) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
      const section = (parsed as { piPermissionSystem?: unknown }).piPermissionSystem;
      if (!section || typeof section !== "object" || Array.isArray(section)) return defaults;
      const config = section as RawPermissionSoundSettings;
      return {
         sound: resolveSoundPath(config.sound, dirname(settingsPath)) ?? defaults.sound,
         volume: typeof config.volume === "number" ? normalizeVolume(config.volume) : defaults.volume
      };
   } catch {
      return defaults;
   }
}

export function playPermissionSound(
   deps: Pick<AudiblePermissionDecisionRequesterDeps, "agentDir" | "exec" | "warn">
): void {
   if (!deps.exec) return;

   const sounds = loadPermissionSoundSettings(deps.agentDir);
   try {
      const result = deps.exec("ffplay", ffplayArgsForSound(sounds));
      void Promise.resolve(result).catch((error: unknown) => {
         deps.warn?.("[pi-permission-system] failed to play permission sound", error);
      });
   } catch (error) {
      deps.warn?.("[pi-permission-system] failed to play permission sound", error);
   }
}

export function createAudiblePermissionDecisionRequester(
   deps: AudiblePermissionDecisionRequesterDeps
): RequestPermissionDecisionFromUi {
   return async (ui, title, message, options) => {
      playPermissionSound(deps);
      return deps.requestPermissionDecisionFromUi(ui, title, message, options);
   };
}
