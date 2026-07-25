/**
 * Cutover fail-closed gate for Harbor extension.
 */

export function pathFrom(item: { sourceInfo?: { path?: string } }): string {
   return item.sourceInfo?.path ?? "";
}

export const NAME_COLLISION_TOOLS = [
   "task",
   "task_spawn",
   "task_spawn_batch",
   "task_wait",
   "task_cancel",
   "task_check",
   "task_list",
   "bg_start",
   "bg_kill",
   "bg_status",
   "bg_list",
   "bg_logs"
];

export const NAME_COLLISION_COMMANDS = ["/ps", "/tasks", "/agents", "/vibe", "/btw"];

export function hasForceExclude(settingsExtensions: string[] | undefined, target: string): boolean {
   if (!settingsExtensions) return false;
   return settingsExtensions.some((ext) => ext.startsWith("-") && ext.includes(target));
}

export interface CutoverItem {
   name: string;
   sourceInfo?: { path?: string };
}

export interface CheckCutoverParams {
   tools?: CutoverItem[];
   commands?: CutoverItem[];
   settingsExtensions?: string[];
}

export type CutoverResult = { ok: true } | { ok: false; error: string };

export function checkCutover(params: CheckCutoverParams): CutoverResult {
   const settings = params.settingsExtensions ?? [];
   const tasksExcluded = hasForceExclude(settings, "extensions/tasks");
   const bgTerminalsExcluded = hasForceExclude(settings, "extensions/background-terminals");

   if (tasksExcluded && bgTerminalsExcluded) {
      return { ok: true };
   }

   const tools = params.tools ?? [];
   const commands = params.commands ?? [];

   for (const item of [...tools, ...commands]) {
      const p = pathFrom(item);
      if (p.includes("extensions/tasks") && !tasksExcluded) {
         return {
            ok: false,
            error: `Legacy tasks extension active at '${p}'. Force-exclude with '-extensions/tasks/index.ts' in settings.`
         };
      }
      if (p.includes("extensions/background-terminals") && !bgTerminalsExcluded) {
         return {
            ok: false,
            error: `Legacy background-terminals extension active at '${p}'. Force-exclude with '-extensions/background-terminals/index.ts' in settings.`
         };
      }
   }

   const tasksLegacyListed = settings.some((ext) => !ext.startsWith("-") && ext.includes("extensions/tasks"));
   const bgLegacyListed = settings.some(
      (ext) => !ext.startsWith("-") && ext.includes("extensions/background-terminals")
   );

   for (const tool of tools) {
      if (NAME_COLLISION_TOOLS.includes(tool.name)) {
         if (!tasksExcluded && (tasksLegacyListed || !pathFrom(tool))) {
            return {
               ok: false,
               error: `Tool collision on '${tool.name}' matching NAME_COLLISION_TOOLS. Exclude legacy extensions in settings.`
            };
         }
         if (!bgTerminalsExcluded && (bgLegacyListed || !pathFrom(tool))) {
            return {
               ok: false,
               error: `Tool collision on '${tool.name}' matching NAME_COLLISION_TOOLS. Exclude legacy extensions in settings.`
            };
         }
      }
   }

   for (const cmd of commands) {
      if (NAME_COLLISION_COMMANDS.includes(cmd.name)) {
         if (!tasksExcluded && (tasksLegacyListed || !pathFrom(cmd))) {
            return {
               ok: false,
               error: `Command collision on '${cmd.name}' matching NAME_COLLISION_COMMANDS. Exclude legacy extensions in settings.`
            };
         }
         if (!bgTerminalsExcluded && (bgLegacyListed || !pathFrom(cmd))) {
            return {
               ok: false,
               error: `Command collision on '${cmd.name}' matching NAME_COLLISION_COMMANDS. Exclude legacy extensions in settings.`
            };
         }
      }
   }

   return { ok: true };
}
