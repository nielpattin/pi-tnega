/**
 * Harbor extension registration logic and session_start cutover gate.
 */

import { checkCutover } from "./cutover.js";

export interface HarborExtensionOptions {
   hasUI?: boolean;
   isPrintMode?: boolean;
   settingsExtensions?: string[];
}

export type RegistrationResult = { ok: true; registered: "worker-only" | "full" } | { ok: false; error: string };

export function registerHarborExtension(pi: any, options?: HarborExtensionOptions): RegistrationResult {
   const hasUI = options?.hasUI ?? (typeof pi.hasUI === "function" ? pi.hasUI() : true);
   const isPrintMode = options?.isPrintMode ?? (typeof pi.isPrintMode === "function" ? pi.isPrintMode() : false);

   if (!hasUI || isPrintMode) {
      if (typeof pi.registerTool === "function") {
         pi.registerTool({ name: "submit", description: "Submit worker result" });
      }
      return { ok: true, registered: "worker-only" };
   }

   const tools = typeof pi.getTools === "function" ? pi.getTools() : [];
   const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
   const settings =
      options?.settingsExtensions ?? (typeof pi.getSettings === "function" ? pi.getSettings()?.extensions : []);

   const cutoverRes = checkCutover({
      tools,
      commands,
      settingsExtensions: settings
   });

   if (!cutoverRes.ok) {
      if (typeof pi.logError === "function") {
         pi.logError(cutoverRes.error);
      } else {
         console.error(cutoverRes.error);
      }
      return { ok: false, error: cutoverRes.error };
   }

   if (typeof pi.registerTool === "function") {
      pi.registerTool({ name: "task", description: "Harbor task tool" });
      pi.registerTool({ name: "hub", description: "Harbor hub tool" });
      pi.registerTool({ name: "submit", description: "Harbor submit tool" });
   }

   if (typeof pi.registerCommand === "function") {
      pi.registerCommand("/tasks", () => {});
      pi.registerCommand("/agents", () => {});
      pi.registerCommand("/vibe", () => {});
      pi.registerCommand("/btw", () => {});
   }

   if (typeof pi.registerEntryRenderer === "function") {
      pi.registerEntryRenderer("harbor-result", () => {});
      pi.registerEntryRenderer("btw-result", () => {});
   }

   return { ok: true, registered: "full" };
}
