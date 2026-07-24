import type { PermissionMode, PermissionSystemExtensionConfig } from "./extension-config";
import type { PermissionState } from "./types";

export interface AskPermissionResolutionOptions {
   config: PermissionSystemExtensionConfig;
   hasUI: boolean;
   isSubagent: boolean;
}

export function getPermissionMode(config: PermissionSystemExtensionConfig): PermissionMode {
   if (
      config.permissionMode &&
      (config.yoloMode === undefined || (config.permissionMode === "yolo") === config.yoloMode)
   ) {
      return config.permissionMode;
   }
   if (config.yoloMode === true) {
      return "yolo";
   }
   return config.permissionMode ?? "default";
}

export function isYoloModeEnabled(config: PermissionSystemExtensionConfig): boolean {
   return getPermissionMode(config) === "yolo";
}

export function isAutoModeEnabled(config: PermissionSystemExtensionConfig): boolean {
   return getPermissionMode(config) === "auto";
}

export function shouldAutoApprovePermissionState(
   state: PermissionState,
   config: PermissionSystemExtensionConfig
): boolean {
   return state === "ask" && isYoloModeEnabled(config);
}

export function canResolveAskPermissionRequest(options: AskPermissionResolutionOptions): boolean {
   return options.hasUI || options.isSubagent || getPermissionMode(options.config) !== "default";
}
