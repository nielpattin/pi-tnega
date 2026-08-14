import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProcessesExtension } from "./src/extension.ts";

export * from "./src/domain.ts";
export * from "./src/runtime.ts";
export * from "./src/services/ProcessSupervisor.ts";
export * from "./src/services/ShellExecutor.ts";
export * from "./src/tools/process.ts";
export * from "./src/ui/formatters.ts";
export * from "./src/ui/process-dashboard.ts";
export * from "./src/ui/process-detail.ts";
export * from "./src/ui/tool-renderers.ts";

/** Register the standalone process supervision extension. */
export default function processesExtension(pi: ExtensionAPI): void {
   registerProcessesExtension(pi);
}
