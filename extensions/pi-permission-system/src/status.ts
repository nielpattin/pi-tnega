import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { EXTENSION_ID, type PermissionSystemExtensionConfig } from "./extension-config";
import { getPermissionMode } from "./yolo-mode";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;
export const PERMISSION_SYSTEM_YOLO_STATUS_VALUE = "yolo";

type PermissionStatusContext = Pick<ExtensionContext, "hasUI" | "ui"> | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(config: PermissionSystemExtensionConfig): string | undefined {
   return getPermissionMode(config);
}

export function syncPermissionSystemStatus(
   ctx: PermissionStatusContext,
   config: PermissionSystemExtensionConfig
): void {
   ctx.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, getPermissionSystemStatus(config));
}
