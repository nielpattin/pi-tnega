import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
   handleProcessList,
   handleProcessRestart,
   handleProcessSnapshot,
   handleProcessStart,
   handleProcessStop,
   ProcessListToolParamsSchema,
   ProcessRestartToolParamsSchema,
   ProcessSnapshotToolParamsSchema,
   ProcessStartToolParamsSchema,
   ProcessStopToolParamsSchema
} from "./tools/process.ts";
import { makeProcessesRuntime, runProcessTool } from "./runtime.ts";
import { showProcessDashboard } from "./ui/process-dashboard.ts";
import {
   renderProcessListCall,
   renderProcessListResult,
   renderProcessRestartCall,
   renderProcessRestartResult,
   renderProcessSnapshotCall,
   renderProcessSnapshotResult,
   renderProcessStartCall,
   renderProcessStartResult,
   renderProcessStopCall,
   renderProcessStopResult
} from "./ui/tool-renderers.ts";

export type ProcessesRuntime = ReturnType<typeof makeProcessesRuntime>;

type ProcessEffect = Parameters<typeof runProcessTool>[1];

function stringify(value: unknown): string {
   return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

function createProcessToolResult(value: unknown) {
   return {
      content: [{ type: "text" as const, text: stringify(value) }],
      details: value
   };
}

function errorResult(error: unknown) {
   const message = error instanceof Error ? error.message : String(error);
   return {
      content: [{ type: "text" as const, text: message }],
      details: { ok: false, error: message }
   };
}

async function executeProcessEffect(
   runtime: ProcessesRuntime,
   effect: ProcessEffect,
   signal: AbortSignal | undefined,
   interruptMessage: string
) {
   try {
      return createProcessToolResult(await runProcessTool(runtime, effect, { signal, interruptMessage }));
   } catch (error) {
      return errorResult(error);
   }
}

/** Register process tools and the independent process UI. */
export function registerProcessesExtension(pi: ExtensionAPI): ProcessesRuntime {
   const runtime = makeProcessesRuntime();

   const registerAction = <TParams extends TSchema>(definition: {
      name: string;
      label: string;
      description: string;
      promptSnippet: string;
      promptGuidelines?: ToolDefinition<TParams>["promptGuidelines"];
      parameters: TParams;
      renderCall?: ToolDefinition<TParams>["renderCall"];
      renderResult?: ToolDefinition<TParams>["renderResult"];
      handler: (params: unknown) => ProcessEffect;
      interruptMessage: string;
   }) => {
      pi.registerTool({
         name: definition.name,
         label: definition.label,
         description: definition.description,
         promptSnippet: definition.promptSnippet,
         ...(definition.promptGuidelines ? { promptGuidelines: definition.promptGuidelines } : {}),
         parameters: definition.parameters,
         ...(definition.renderCall ? { renderCall: definition.renderCall } : {}),
         ...(definition.renderResult ? { renderResult: definition.renderResult } : {}),
         async execute(_toolCallId, params, signal) {
            return executeProcessEffect(runtime, definition.handler(params), signal, definition.interruptMessage);
         }
      });
   };

   registerAction({
      name: "process_start",
      label: "Process Start",
      description:
         "Start a background process, including finite commands explicitly requested in background. Use bash for foreground one-shot commands.",
      promptSnippet:
         "Start a background process, including finite commands explicitly requested in background. Use bash for foreground one-shot commands.",
      promptGuidelines: [
         "Use process_start for any command the user explicitly asks to run in the background, including finite commands.",
         "Treat bash in the user's command as the shell language; an explicit background request takes precedence over the bash tool."
      ],
      parameters: ProcessStartToolParamsSchema,
      renderCall: renderProcessStartCall,
      renderResult: renderProcessStartResult,
      handler: (params) => handleProcessStart(params as never),
      interruptMessage: "process_start aborted"
   });
   registerAction({
      name: "process_list",
      label: "Process List",
      description: "List all long-running process jobs.",
      promptSnippet: "List long-running processes.",
      parameters: ProcessListToolParamsSchema,
      renderCall: renderProcessListCall,
      renderResult: renderProcessListResult,
      handler: (params) => handleProcessList(params as never),
      interruptMessage: "process_list aborted"
   });
   registerAction({
      name: "process_snapshot",
      label: "Process Snapshot",
      description:
         "Read a bounded window of combined stdout and stderr for a retained process job, only when requested.",
      promptSnippet:
         "Read a retained process snapshot only on explicit request for status or logs. Use before to page to older retained lines.",
      promptGuidelines: [
         "Do not call process_snapshot automatically after process_start, including for finite background commands.",
         "Call process_snapshot only when the user explicitly asks for process status or logs.",
         "The default result contains the newest 100 lines. Increase lines for a larger window or pass before from the result to read older retained lines."
      ],
      parameters: ProcessSnapshotToolParamsSchema,
      renderCall: renderProcessSnapshotCall,
      renderResult: renderProcessSnapshotResult,
      handler: (params) => handleProcessSnapshot(params as never),
      interruptMessage: "process_snapshot aborted"
   });
   registerAction({
      name: "process_restart",
      label: "Process Restart",
      description: "Restart a retained process job by job ID.",
      promptSnippet: "Restart a retained process job.",
      parameters: ProcessRestartToolParamsSchema,
      renderCall: renderProcessRestartCall,
      renderResult: renderProcessRestartResult,
      handler: (params) => handleProcessRestart(params as never),
      interruptMessage: "process_restart aborted"
   });
   registerAction({
      name: "process_stop",
      label: "Process Stop",
      description: "Stop a long-running process job by job ID or name.",
      promptSnippet: "Stop a long-running process.",
      parameters: ProcessStopToolParamsSchema,
      renderCall: renderProcessStopCall,
      renderResult: renderProcessStopResult,
      handler: (params) => handleProcessStop(params as never),
      interruptMessage: "process_stop aborted"
   });

   pi.registerCommand("processes", {
      description: "Open the supervised process dashboard",
      handler: async (_args, ctx) => {
         if (ctx.hasUI) await showProcessDashboard(ctx, runtime);
      }
   });

   pi.on("session_shutdown", async () => {
      await runtime.dispose();
   });

   return runtime;
}
