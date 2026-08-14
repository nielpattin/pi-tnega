/**
 * @nielpattin/pi-workers entry point and exports
 */
import { registerWorkersExtension } from "./src/extension.js";

export * from "./src/domain.js";
export * from "./src/runtime.js";
export * from "./src/services/JobRegistry.js";
export * from "./src/services/ProcessSupervisor.js";
export * from "./src/services/ShellExecutor.js";
export * from "./src/services/WorkerManager.js";
export * from "./src/services/SchemaValidator.js";
export * from "./src/services/AgentsStore.js";
export * from "./src/backends/agy.js";
export * from "./src/backends/pi.js";
export * from "./src/backends/pi-model.js";
export * from "./src/tools/worker.js";
export * from "./src/tools/structured-output.js";
export * from "./src/tools/jobs.js";
export * from "./src/tools/process.js";
export * from "./src/ui/formatters.js";
export * from "./src/ui/workers-dashboard.js";
export * from "./src/ui/agents-panel.js";
export * from "./src/commands/btw.js";
export * from "./src/ui/log-viewer.js";
export * from "./src/ui/telemetry.js";
export * from "./src/extension.js";
export * from "./src/utils/process-telemetry.js";
export * from "./src/utils/acp-decoder.js";

export default function workersExtension(pi: any) {
   registerWorkersExtension(pi);
}
