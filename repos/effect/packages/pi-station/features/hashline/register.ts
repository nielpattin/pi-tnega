import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompatibilityNotifications } from "./compatibility-notify.ts";
import { registerEditTool } from "./edit-tool.ts";
import { registerReadTool } from "./read-tool.ts";

export function registerHashline(pi: ExtensionAPI): void {
   registerReadTool(pi);
   registerEditTool(pi);
   registerCompatibilityNotifications(pi);
}
