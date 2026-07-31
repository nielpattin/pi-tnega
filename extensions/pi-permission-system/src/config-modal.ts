import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";

import { DEFAULT_EXTENSION_CONFIG, type PermissionSystemExtensionConfig } from "./extension-config";
import type { Ruleset } from "./rule";

interface PermissionSystemConfigController {
   getConfig(): PermissionSystemExtensionConfig;
   setConfig(next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void;
   getConfigPath(): string;
   /** Optional: returns the composed config-layer ruleset for origin display. */
   getComposedRules?(): Ruleset;
}

const ON_OFF = ["on", "off"];
const COMMAND_ARGUMENTS = [
   {
      value: "show",
      label: "Show active settings",
      description: "Display the current permission-system config summary"
   },
   {
      value: "path",
      label: "Show config path",
      description: "Display the permission.jsonc path used by pi-permission-system"
   },
   {
      value: "reset",
      label: "Reset defaults",
      description: "Restore default yolo/logging settings and persist them"
   },
   {
      value: "help",
      label: "Show help",
      description: "Display command usage"
   }
] as const;
const USAGE_TEXT =
   "Usage: /permission-system [show|path|reset|help] (or run /permission-system with no args to open settings modal)";

function cloneDefaultConfig(): PermissionSystemExtensionConfig {
   return {
      debugLog: DEFAULT_EXTENSION_CONFIG.debugLog,
      permissionReviewLog: DEFAULT_EXTENSION_CONFIG.permissionReviewLog,
      permissionMode: DEFAULT_EXTENSION_CONFIG.permissionMode,
      yoloMode: DEFAULT_EXTENSION_CONFIG.yoloMode
   };
}

function toOnOff(value: boolean): string {
   return value ? "on" : "off";
}

function formatRulesSummary(rules: Ruleset): string {
   // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- origin may be absent despite its type
   const configRules = rules.filter((r) => r.layer === "config" && r.origin);
   if (configRules.length === 0) return "";
   const formatted = configRules
      .map((r) => {
         const key = r.pattern === "*" ? r.surface : `${r.surface}["${r.pattern}"]`;
         return `${key}=${r.action} (${r.origin})`;
      })
      .join(", ");
   return `\n  rules: ${formatted}`;
}

function summarizeConfig(config: PermissionSystemExtensionConfig, rules?: Ruleset): string {
   const mode = config.permissionMode ?? (config.yoloMode ? "yolo" : "default");
   const knobs = [
      `permissionMode=${mode}`,
      `permissionReviewLog=${toOnOff(config.permissionReviewLog)}`,
      `debugLog=${toOnOff(config.debugLog)}`
   ].join(", ");
   const rulesSuffix = rules ? formatRulesSummary(rules) : "";
   return `${knobs}${rulesSuffix}`;
}

const PERMISSION_MODES = ["default", "auto", "yolo"] as const;

function buildSettingItems(config: PermissionSystemExtensionConfig): SettingItem[] {
   const currentMode = config.permissionMode ?? (config.yoloMode ? "yolo" : "default");
   return [
      {
         id: "permissionMode",
         label: "Permission mode",
         description: "default: Standard checks | auto: LLM reviews context | yolo: Auto-approve all",
         currentValue: currentMode,
         values: [...PERMISSION_MODES]
      },
      {
         id: "permissionReviewLog",
         label: "Permission review log",
         description: "Write permission request and decision audit events to the extension logs directory",
         currentValue: toOnOff(config.permissionReviewLog),
         values: ON_OFF
      },
      {
         id: "debugLog",
         label: "Debug logging",
         description: "Write verbose permission-system diagnostics to the extension logs directory",
         currentValue: toOnOff(config.debugLog),
         values: ON_OFF
      }
   ];
}

function applySetting(
   config: PermissionSystemExtensionConfig,
   id: string,
   value: string
): PermissionSystemExtensionConfig {
   switch (id) {
      case "permissionMode":
         if (value === "default" || value === "auto" || value === "yolo") {
            return { ...config, permissionMode: value, yoloMode: value === "yolo" };
         }
         return config;
      case "yoloMode": {
         const mode = value === "on" ? "yolo" : "default";
         return { ...config, permissionMode: mode, yoloMode: mode === "yolo" };
      }
      case "permissionReviewLog":
         return { ...config, permissionReviewLog: value === "on" };
      case "debugLog":
         return { ...config, debugLog: value === "on" };
      default:
         return config;
   }
}

function syncSettingValues(settingsList: SettingsList, config: PermissionSystemExtensionConfig): void {
   const currentMode = config.permissionMode ?? (config.yoloMode ? "yolo" : "default");
   settingsList.updateValue("permissionMode", currentMode);
   settingsList.updateValue("permissionReviewLog", toOnOff(config.permissionReviewLog));
   settingsList.updateValue("debugLog", toOnOff(config.debugLog));
}

function getArgumentCompletions(
   argumentPrefix: string
): Array<{ value: string; label: string; description: string }> | null {
   const normalized = argumentPrefix.trim().toLowerCase();
   if (normalized.includes(" ")) {
      return null;
   }

   const filtered = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(normalized));
   return filtered.length > 0 ? [...filtered] : null;
}

async function openSettingsModal(
   ctx: ExtensionCommandContext,
   controller: PermissionSystemConfigController
): Promise<void> {
   const overlayOptions = {
      anchor: "center" as const,
      width: 82,
      maxHeight: "85%" as const,
      margin: 1
   };

   // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- ctx.ui.custom<void> is valid; rule does not allow void in generic fn call type args
   await ctx.ui.custom<void>(
      (_tui, _theme, _keybindings, done) => {
         let current = controller.getConfig();
         const settingsList = new SettingsList(
            buildSettingItems(current),
            10,
            getSettingsListTheme(),
            (id, newValue) => {
               current = applySetting(current, id, newValue);
               controller.setConfig(current, ctx);
               current = controller.getConfig();
               syncSettingValues(settingsList, current);
            },
            () => done()
         );

         return settingsList;
      },
      { overlay: true, overlayOptions }
   );
}

function handleArgs(args: string, ctx: ExtensionCommandContext, controller: PermissionSystemConfigController): boolean {
   const normalized = args.trim().toLowerCase();
   if (!normalized) {
      return false;
   }

   if (normalized === "show") {
      const rules = controller.getComposedRules?.();
      ctx.ui.notify(`permission-system: ${summarizeConfig(controller.getConfig(), rules)}`, "info");
      return true;
   }

   if (normalized === "path") {
      ctx.ui.notify(`permission-system config: ${controller.getConfigPath()}`, "info");
      return true;
   }

   if (normalized === "reset") {
      controller.setConfig(cloneDefaultConfig(), ctx);
      ctx.ui.notify("Permission system settings reset to defaults.", "info");
      return true;
   }

   if (normalized === "help") {
      ctx.ui.notify(USAGE_TEXT, "info");
      return true;
   }

   ctx.ui.notify(USAGE_TEXT, "warning");
   return true;
}

export function registerPermissionSystemCommand(pi: ExtensionAPI, controller: PermissionSystemConfigController): void {
   pi.registerCommand("permission-system", {
      description: "Configure pi-permission-system logging and yolo-mode behavior",
      getArgumentCompletions,
      handler: async (args, ctx) => {
         if (handleArgs(args, ctx, controller)) {
            return;
         }

         if (!ctx.hasUI) {
            ctx.ui.notify("/permission-system requires interactive TUI mode.", "warning");
            return;
         }

         await openSettingsModal(ctx, controller);
      }
   });
}
