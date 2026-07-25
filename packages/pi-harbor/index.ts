/**
 * @nielpattin/pi-harbor entry point and exports
 */
import { registerHarborExtension } from "./src/extension.js";

export * from "./src/domain.js";
export * from "./src/runtime.js";
export * from "./src/services/JobRegistry.js";
export * from "./src/services/ProcessSupervisor.js";
export * from "./src/services/ShellExecutor.js";
export * from "./src/services/TaskManager.js";
export * from "./src/services/SchemaValidator.js";
export * from "./src/services/AgentsStore.js";
export * from "./src/services/MailBus.js";
export * from "./src/services/VibeState.js";
export * from "./src/backends/agy.js";
export * from "./src/backends/pi.js";
export * from "./src/backends/pi-model.js";
export * from "./src/tools/task.js";
export * from "./src/tools/submit.js";
export * from "./src/tools/hub.js";
export * from "./src/tools/vibe.js";
export * from "./src/ui/formatters.js";
export * from "./src/ui/tasks-dashboard.js";
export * from "./src/ui/agents-panel.js";
export * from "./src/commands/vibe.js";
export * from "./src/commands/btw.js";
export * from "./src/cutover.js";
export * from "./src/extension.js";
export * from "./src/utils/acp-decoder.js";

export default function harborExtension(pi: any) {
   registerHarborExtension(pi);
}
