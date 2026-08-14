/**
 * Workers extension registration: real Pi ExtensionAPI wiring.
 *
 * Product gate (must be true before calling "done"):
 * - tools register with execute handlers that call WorkersLive + runTool
 * - commands register real handlers (workers/agents plus independent BTW chat)
 * - cutover fails closed without legacy force-excludes
 * - session_start enforces parent vs worker surfaces
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorkersRuntime, runTool } from "./runtime.js";
import { buildWorkerSystemPrompt as orderWorkerSystemPrompt } from "./backends/pi.js";
import { JobRegistry } from "./services/JobRegistry.js";
import { ProcessSupervisor } from "./services/ProcessSupervisor.js";
import { WorkerManager } from "./services/WorkerManager.js";
import {
   activateParentSession,
   ensureParentSessionRecovery,
   flushPendingWrites
} from "./services/WorkersJobRecovery.js";
import { createDeferredResultDelivery } from "./services/ResultDelivery.js";
import { AgentsStore } from "./services/AgentsStore.js";
import {
   handleWorkerSpawn,
   handleWorkerList,
   handleWorkerCancel,
   createWorkerSpawnToolParamsSchema,
   WorkerListToolParamsSchema,
   WorkerCancelToolParamsSchema,
   WORKER_SPAWN_TOOL_BASE_DESCRIPTION,
   WORKER_SPAWN_TOOL_BASE_PROMPT_SNIPPET,
   augmentWorkerToolMetadata
} from "./tools/worker.js";
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
} from "./tools/process.js";
import { registerBtwCommand } from "./commands/btw.js";
import { formatDuration, formatJobTable, formatProcessTable } from "./ui/formatters.js";
import { buildAgentsPanelViewModel, openAgentsPanel } from "./ui/agents-panel.js";
import { openWorkersDashboard } from "./ui/workers-dashboard.js";
import {
   ASYNC_WORKER_WIDGET_KEY,
   createAsyncWorkerWidget,
   summarizeAsyncWorkerStatus
} from "./ui/async-worker-widget.js";
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
   renderProcessStopResult,
   renderWorkerCall,
   renderWorkerResult,
   renderWorkerCancelCall,
   renderWorkerCancelResult,
   renderWorkerListCall,
   renderWorkerListResult,
   workerTraceLines
} from "./ui/tool-renderers.js";
import type { Job, ProcessEntry } from "./domain.js";

export type WorkersRuntime = ReturnType<typeof makeWorkersRuntime>;

export interface WorkersExtensionOptions {
   settingsExtensions?: string[];
   /** Injected for tests; production creates one runtime per extension load. */
   runtime?: WorkersRuntime;
}

export type RegistrationResult =
   | { ok: true; registered: "worker-only" | "full"; cutoverOk: boolean }
   | { ok: false; error: string; cutoverOk: false };

function loadSettingsExtensionsFromDisk(): string[] {
   try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { extensions?: unknown };
      return Array.isArray(raw.extensions) ? raw.extensions.filter((v): v is string => typeof v === "string") : [];
   } catch {
      return [];
   }
}

class LimitedText implements Component {
   constructor(
      private readonly text: string,
      private readonly maxLines: number,
      private readonly overflowLines?: (hiddenLines: number) => ReadonlyArray<string>,
      private readonly showOverflowWhenVisible = false
   ) {}

   render(width: number): string[] {
      const wrapped = wrapTextWithAnsi(this.text, Math.max(1, width));
      const visible = wrapped.slice(0, this.maxLines);
      const hiddenLines = Math.max(0, wrapped.length - visible.length);
      if (this.overflowLines && (hiddenLines > 0 || this.showOverflowWhenVisible)) {
         visible.push(...this.overflowLines(hiddenLines));
      }
      return visible;
   }

   invalidate(): void {}
}

function fullResultText(payload: unknown): string {
   if (typeof payload === "string") return payload;
   return JSON.stringify(payload, null, 2) ?? String(payload);
}

function collapsedResultText(payload: unknown): string {
   if (typeof payload === "string") return payload;
   if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const summary = (payload as { summary?: unknown }).summary;
      if (typeof summary === "string") return summary;
   }
   return fullResultText(payload);
}

function asTextResult(payload: unknown) {
   return {
      content: [{ type: "text" as const, text: fullResultText(payload) }],
      details: payload
   };
}

function asErrorResult(message: string) {
   return {
      content: [{ type: "text" as const, text: message }],
      details: { ok: false, error: message }
   };
}

interface ParentToolDelivery {
   readonly ready: Promise<void>;
   readonly notifyAsyncWidget: (ctx: ExtensionContext) => void;
}

interface AsyncWorkerWidgetState {
   readonly update: (ctx: ExtensionContext) => Promise<void>;
   readonly clear: (ctx?: ExtensionContext) => void;
}

/** Mutable state for one extension registration's above-editor async worker widget. */
function makeAsyncWorkerWidgetState(runtime: WorkersRuntime): AsyncWorkerWidgetState {
   let runningCount = 0;
   let snapshot: string | undefined;

   const clear = (ctx?: ExtensionContext) => {
      if (runningCount === 0 && snapshot === undefined) return;
      try {
         ctx?.ui.setWidget?.(ASYNC_WORKER_WIDGET_KEY, undefined);
      } catch {
         // UI may already be gone.
      }
      runningCount = 0;
      snapshot = undefined;
   };

   const update = async (ctx: ExtensionContext) => {
      if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") return;
      try {
         const jobs = await runTool(
            runtime,
            JobRegistry.use((registry) => registry.list())
         );
         const { running, completed, failed, activeNames } = summarizeAsyncWorkerStatus(jobs);
         if (running === 0) {
            clear(ctx);
            return;
         }
         const nextSnapshot = `${running}:${completed}:${failed}:${activeNames.slice(0, 3).join(",")}`;
         if (nextSnapshot === snapshot && running === runningCount) return;
         runningCount = running;
         snapshot = nextSnapshot;
         ctx.ui.setWidget(ASYNC_WORKER_WIDGET_KEY, createAsyncWorkerWidget(jobs));
      } catch {
         // ignore widget update races
      }
   };

   return { update, clear };
}

interface WorkerToolAugmentation {
   readonly agentNames: ReadonlyArray<string>;
   readonly descriptionAppendix: string;
}

const EMPTY_WORKER_TOOL_AUGMENTATION: WorkerToolAugmentation = {
   agentNames: [],
   descriptionAppendix: ""
};

async function resolveWorkerToolAugmentation(runtime: WorkersRuntime, cwd?: string): Promise<WorkerToolAugmentation> {
   if (!cwd) return EMPTY_WORKER_TOOL_AUGMENTATION;
   try {
      const agents = await runTool(
         runtime,
         AgentsStore.use((store) => store.listAgents(cwd))
      );
      return augmentWorkerToolMetadata(agents);
   } catch {
      return EMPTY_WORKER_TOOL_AUGMENTATION;
   }
}

function createWorkerToolDefinition(
   runtime: WorkersRuntime,
   delivery: ParentToolDelivery,
   augmentation: WorkerToolAugmentation
): any {
   const description = augmentation.descriptionAppendix
      ? `${WORKER_SPAWN_TOOL_BASE_DESCRIPTION}\n\n${augmentation.descriptionAppendix}`
      : WORKER_SPAWN_TOOL_BASE_DESCRIPTION;
   return {
      name: "worker_spawn" as const,
      label: "worker_spawn",
      description,
      promptSnippet: WORKER_SPAWN_TOOL_BASE_PROMPT_SNIPPET,
      parameters: createWorkerSpawnToolParamsSchema(augmentation.agentNames),
      renderCall: renderWorkerCall,
      renderResult: renderWorkerResult,
      async execute(
         _toolCallId: string,
         params: any,
         signal: AbortSignal | undefined,
         _onUpdate: any,
         ctx: ExtensionContext
      ) {
         try {
            await runTool(runtime, ensureParentSessionRecovery(ctx.sessionManager.getSessionFile?.()));
            await delivery.ready;
            const result = await runTool(
               runtime,
               handleWorkerSpawn(params, {
                  ownerSessionId: ctx.sessionManager.getSessionId?.() ?? "parent",
                  parentSessionFile: ctx.sessionManager.getSessionFile?.(),
                  modelRegistry: ctx.modelRegistry,
                  inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                  cwd: ctx.cwd
               }),
               { signal, interruptMessage: "worker spawn aborted" }
            );
            if (ctx.hasUI) delivery.notifyAsyncWidget(ctx);
            const toolResult = asTextResult(result);
            return result.ok === true ? { ...toolResult, terminate: true as const } : toolResult;
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   };
}

/**
 * Rebuild the worker_spawn tool metadata for the current cwd and re-register it,
 * so agent enable/disable/create changes apply to the live session immediately.
 */
export async function refreshWorkerSpawnTool(
   pi: ExtensionAPI,
   runtime: WorkersRuntime,
   delivery: ParentToolDelivery,
   cwd?: string
): Promise<void> {
   const augmentation = await resolveWorkerToolAugmentation(runtime, cwd);
   pi.registerTool(createWorkerToolDefinition(runtime, delivery, augmentation));
}

interface ParentActionToolDefinition {
   readonly name: string;
   readonly label: string;
   readonly description: string;
   readonly promptSnippet: string;
   readonly promptGuidelines?: ReadonlyArray<string>;
   readonly parameters: any;
   readonly renderCall: any;
   readonly renderResult: any;
   readonly handler: (params: any) => any;
   readonly interruptMessage: string;
}

function createParentActionToolDefinition(
   runtime: WorkersRuntime,
   delivery: ParentToolDelivery,
   definition: ParentActionToolDefinition
) {
   return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      ...(definition.promptGuidelines ? { promptGuidelines: [...definition.promptGuidelines] } : {}),
      parameters: definition.parameters,
      renderCall: definition.renderCall,
      renderResult: definition.renderResult,
      async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
         try {
            await delivery.ready;
            const result = await runTool(runtime, definition.handler(params), {
               signal,
               interruptMessage: definition.interruptMessage
            });
            return asTextResult(result);
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   };
}

function buildWorkerPromptForTurn(systemPrompt: string): string {
   return orderWorkerSystemPrompt(systemPrompt).trim();
}

function registerParentTools(pi: ExtensionAPI, runtime: WorkersRuntime, delivery: ParentToolDelivery): void {
   pi.registerTool(createWorkerToolDefinition(runtime, delivery, EMPTY_WORKER_TOOL_AUGMENTATION));
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "worker_list",
         label: "Worker List",
         description: "List worker jobs.",
         promptSnippet: "List workers.",
         parameters: WorkerListToolParamsSchema,
         renderCall: renderWorkerListCall,
         renderResult: renderWorkerListResult,
         handler: handleWorkerList,
         interruptMessage: "worker_list aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "worker_cancel",
         label: "Worker Cancel",
         description: "Cancel a worker by job ID.",
         promptSnippet: "Cancel a worker.",
         parameters: WorkerCancelToolParamsSchema,
         renderCall: renderWorkerCancelCall,
         renderResult: renderWorkerCancelResult,
         handler: handleWorkerCancel,
         interruptMessage: "worker_cancel aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "process_start",
         label: "Process Start",
         description:
            "Start a retained long-running process job that runs until stopped (for example pnpm dev). For one-shot shell checks like lint, typecheck, fmt, or git diff, use bash instead.",
         promptSnippet:
            "Start a retained process only for never-ending services (pnpm dev). Use bash for one-shot checks.",
         parameters: ProcessStartToolParamsSchema,
         renderCall: renderProcessStartCall,
         renderResult: renderProcessStartResult,
         handler: handleProcessStart,
         interruptMessage: "process_start aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "process_list",
         label: "Process List",
         description: "List all long-running process jobs.",
         promptSnippet: "List long-running processes.",
         parameters: ProcessListToolParamsSchema,
         renderCall: renderProcessListCall,
         renderResult: renderProcessListResult,
         handler: handleProcessList,
         interruptMessage: "process_list aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "process_snapshot",
         label: "Process Snapshot",
         description: "Read status and recent logs for a retained process job. For one-shot bash output use bash.",
         promptSnippet: "Read a retained process snapshot. Use bash for one-shot checks.",
         parameters: ProcessSnapshotToolParamsSchema,
         renderCall: renderProcessSnapshotCall,
         renderResult: renderProcessSnapshotResult,
         handler: handleProcessSnapshot,
         interruptMessage: "process_snapshot aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "process_restart",
         label: "Process Restart",
         description: "Restart a retained process job by job ID.",
         promptSnippet: "Restart a retained process job.",
         parameters: ProcessRestartToolParamsSchema,
         renderCall: renderProcessRestartCall,
         renderResult: renderProcessRestartResult,
         handler: handleProcessRestart,
         interruptMessage: "process_restart aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "process_stop",
         label: "Process Stop",
         description: "Stop a long-running process job by job ID or name.",
         promptSnippet: "Stop a long-running process.",
         parameters: ProcessStopToolParamsSchema,
         renderCall: renderProcessStopCall,
         renderResult: renderProcessStopResult,
         handler: handleProcessStop,
         interruptMessage: "process_stop aborted"
      })
   );
}

function registerParentCommands(pi: ExtensionAPI, runtime: WorkersRuntime, delivery: ParentToolDelivery): void {
   pi.registerCommand("workers", {
      description: "List worker jobs and background processes",
      handler: async (_args, ctx) => {
         const jobs = await runTool(
            runtime,
            JobRegistry.use((r) => r.list())
         );
         const processes = await runTool(
            runtime,
            ProcessSupervisor.use((s) => s.ps)
         );
         const text = [
            "Workers /workers",
            "",
            "Jobs:",
            formatJobTable(jobs),
            "",
            "Processes:",
            formatProcessTable(processes)
         ].join("\n");
         if (ctx.hasUI) {
            await openWorkersDashboard(ctx as any, runtime);
         }
         pi.appendEntry("workers-snapshot", { text, at: Date.now() });
      }
   });

   pi.registerCommand("agents", {
      description: "Show agent profiles",
      handler: async (_args, ctx) => {
         const agents = await runTool(
            runtime,
            AgentsStore.use((s) => s.listAgents(ctx.cwd))
         );
         const model = buildAgentsPanelViewModel({ agents });
         const lines = [
            "Workers /agents",
            "",
            "Agents:",
            ...model.agents.map((a) => {
               const tag = a.source === "builtin" ? " [built-in]" : "";
               return `  - ${a.name}${tag} (${a.harness}) ${a.enabled ? "on" : "off"}`;
            })
         ];
         if (ctx.hasUI) {
            await openAgentsPanel(ctx as any, runtime, {
               initialViewModel: model,
               onAgentsChanged: () => void refreshWorkerSpawnTool(pi, runtime, delivery, ctx.cwd),
               getAllTools: () =>
                  pi.getAllTools().map((t) => ({
                     name: t.name,
                     description: t.description,
                     promptSnippet: (t as any).promptSnippet,
                     promptGuidelines: t.promptGuidelines,
                     source: t.sourceInfo?.path ?? t.sourceInfo?.source
                  }))
            });
         }
         pi.appendEntry("workers-agents-snapshot", { model, at: Date.now() });
      }
   });

   registerBtwCommand(pi);
}

/**
 * Register workers against a Pi ExtensionAPI.
 * Always registers tools with real execute handlers.
 * Parent commands/tools activate only when cutover passes (checked at load + session_start).
 */
export function registerWorkersExtension(pi: ExtensionAPI, options?: WorkersExtensionOptions): RegistrationResult {
   const runtime = options?.runtime ?? makeWorkersRuntime();

   // Prefer explicit test injection; otherwise read real agent settings.json from disk.
   // ExtensionAPI has no getSettings(); previous code always saw [] and false-blocked cutover.
   const settingsExtensions = options?.settingsExtensions ?? loadSettingsExtensionsFromDisk();

   pi.on("resources_discover", async (_event, _ctx) => {
      const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");
      return {
         promptPaths: [promptsDir]
      };
   });

   const resultDelivery = createDeferredResultDelivery();
   const asyncWidget = makeAsyncWorkerWidgetState(runtime);
   let parentContext: ExtensionContext | undefined;
   let activeOwnerSessionId: string | undefined;
   let activeParentSessionFile: string | undefined;
   let switchingParent = false;
   let unsubscribeSettled: (() => void) | undefined;
   let unsubscribeProcessSettled: (() => void) | undefined;
   const pendingProcessResults = new Map<string, ProcessEntry>();

   const deliverResult = (job: Job, triggerTurn = true) => {
      const output = job.errorText ?? job.resultData ?? "(no result returned)";
      const duration =
         job.settledAt === undefined ? undefined : formatDuration(job.settledAt - (job.startedAt ?? job.createdAt));
      const summary = `worker_spawn ${job.name ?? job.id} (${job.id}) ${job.status}${
         duration === undefined ? "" : ` in ${duration}`
      }.`;
      pi.sendMessage(
         {
            customType: "workers-result",
            content: `${summary}\n${fullResultText(output)}`,
            display: true,
            details: {
               id: job.id,
               name: job.name,
               status: job.status,
               duration,
               transcript: job.transcript,
               result: output
            }
         },
         { deliverAs: "steer", triggerTurn }
      );
   };
   const flushResults = () => {
      for (const group of resultDelivery.pendingGroups()) {
         try {
            for (let index = 0; index < group.length; index++) {
               deliverResult(group[index], index === group.length - 1);
            }
            resultDelivery.consume(group.map((job) => job.id));
         } catch {
            // Keep failed deliveries queued for the next idle lifecycle event.
         }
      }
   };
   const deliverProcessResult = (process: ProcessEntry) => {
      const duration =
         process.settledAt === undefined ? undefined : formatDuration(process.settledAt - process.spawnTime);
      const failed = process.status === "failed";
      const output = failed
         ? (process.errorText ??
           `Process exited with ${process.exitCode !== undefined ? `code ${process.exitCode}` : `signal ${process.signal ?? "unknown"}`}`)
         : (process.resultText ?? "(no output)");
      const outcome = failed ? "failed" : "exited";
      const termination =
         process.exitCode !== undefined
            ? ` (${process.exitCode})`
            : process.signal !== undefined
              ? ` (${process.signal})`
              : "";
      pi.sendMessage(
         {
            customType: "workers-result",
            content: `Process ${process.name ?? process.id} (${process.id}) ${outcome}${termination}.\n${fullResultText(output)}`,
            display: true,
            details: {
               kind: "process",
               id: process.id,
               name: process.name,
               status: process.status,
               duration
            }
         },
         { deliverAs: "steer", triggerTurn: true }
      );
   };
   const flushProcessResults = () => {
      for (const [id, process] of pendingProcessResults) {
         try {
            deliverProcessResult(process);
            pendingProcessResults.delete(id);
         } catch {
            // Keep failed deliveries queued for the next idle lifecycle event.
         }
      }
   };
   const flushDeferredResults = () => {
      flushResults();
      flushProcessResults();
   };
   const deliveryReady = Promise.all([
      runTool(
         runtime,
         JobRegistry.use((registry) =>
            registry.onSettled((job) => {
               if (switchingParent || !parentContext || job.ownerSessionId !== activeOwnerSessionId) return;
               void asyncWidget.update(parentContext);
               if (job.status === "cancelled" || resultDelivery.shouldSuppress(job)) return;
               resultDelivery.defer({ ...job });
               if (parentContext.isIdle()) flushDeferredResults();
            })
         )
      ).then((unsubscribe) => {
         unsubscribeSettled = unsubscribe;
      }),
      runTool(
         runtime,
         ProcessSupervisor.use((supervisor) =>
            supervisor.onSettled((process) => {
               if (switchingParent || !parentContext) return;
               if (
                  (process.status !== "failed" && process.status !== "exited") ||
                  process.processWaitInterest > 0 ||
                  process.processKillInterest > 0
               )
                  return;
               pendingProcessResults.set(process.id, { ...process });
               if (parentContext && parentContext.isIdle()) flushDeferredResults();
            })
         )
      ).then((unsubscribe) => {
         unsubscribeProcessSettled = unsubscribe;
      })
   ]).then(() => undefined);

   // Parent tools + commands only when cutover passes.
   const delivery: ParentToolDelivery = {
      ready: deliveryReady,
      notifyAsyncWidget: (ctx) => void asyncWidget.update(ctx)
   };
   registerParentTools(pi, runtime, delivery);
   registerParentCommands(pi, runtime, delivery);

   pi.registerMessageRenderer("workers-result", (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
         kind?: "process" | "worker";
         id?: string;
         name?: string;
         status?: string;
         duration?: string;
         transcript?: unknown;
         result?: unknown;
      };
      const status = details.status ?? "completed";
      const content = typeof message.content === "string" ? message.content : "";
      const summaryLine = content.split("\n", 1)[0] ?? "";
      const duration = details.duration ?? summaryLine.match(/\bin (.+)\.$/)?.[1];
      const durationStr = duration ? ` · ${duration}` : "";
      const failed = status === "failed" || status === "cancelled";
      const bgColor = failed ? "toolErrorBg" : "toolSuccessBg";
      const body = content.split("\n").slice(1).join("\n").trim();
      const bodyLines = body.length > 0 ? body.split("\n") : [];
      const bgBadge = theme.fg("customMessageLabel", "[bg]");
      const name = theme.fg(
         "accent",
         details.name ?? details.id ?? (details.kind === "process" ? "process" : "worker_spawn")
      );
      const header =
         details.kind === "process"
            ? `${bgBadge} ${theme.fg("toolTitle", theme.bold("process"))} ${name}${theme.fg("muted", ` · ${details.id ?? "?"} · ${status}${durationStr}`)} ${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")}`
            : `${bgBadge} ${name}${theme.fg("muted", ` · ${status}${durationStr}`)}`;

      if (details.kind === "process") {
         const preview = expanded ? bodyLines : bodyLines.slice(-5);
         const hiddenCount = expanded ? 0 : bodyLines.length - preview.length;
         const lines = [header, theme.fg("dim", "---")];
         if (hiddenCount > 0) {
            lines.push(
               theme.fg("muted", `... (${hiddenCount} earlier lines,`) +
                  ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
            );
         }
         for (const line of preview) lines.push(theme.fg("toolOutput", line));

         const box = new Box(1, 1, (text) => theme.bg(bgColor, text));
         box.addChild(new Text(lines.join("\n"), 0, 0));
         return box;
      }

      const traceLines = workerTraceLines(details.transcript, theme, expanded);
      const workerBody =
         details.result === undefined
            ? body
            : expanded
              ? fullResultText(details.result)
              : collapsedResultText(details.result);
      const workerBodyLines = workerBody.length > 0 ? workerBody.split("\n") : [];
      const detailLines = [...traceLines, ...workerBodyLines];
      const box = new Box(1, 1, (text) => theme.bg(bgColor, text));
      const headerLines = [header];
      if (detailLines.length > 0) headerLines.push(theme.fg("dim", "---"));
      box.addChild(new Text(headerLines.join("\n"), 0, 0));
      if (detailLines.length > 0) {
         const styledDetail = detailLines
            .map((line, index) => (index < traceLines.length ? line : theme.fg("toolOutput", line)))
            .join("\n");
         const overflowLine = (hiddenLines: number) => {
            const lineWord = hiddenLines === 1 ? "line" : "lines";
            return (
               theme.fg("muted", `... (${hiddenLines} more ${lineWord},`) +
               ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
            );
         };
         box.addChild(
            new LimitedText(styledDetail, expanded ? Number.POSITIVE_INFINITY : 6, (hiddenLines) => [
               overflowLine(hiddenLines)
            ])
         );
      }
      return box;
   });
   pi.registerEntryRenderer("workers-result", (entry) => {
      const data = (entry as { data?: { text?: string } }).data;
      const text = data?.text ?? JSON.stringify(data ?? {});
      return { render: () => [text] } as any;
   });
   pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
      // Print/worker child sessions: only worker tools.
      if (ctx.mode === "print" || !ctx.hasUI) {
         parentContext = undefined;
         activeOwnerSessionId = undefined;
         activeParentSessionFile = undefined;
         switchingParent = false;
         const workerOnly = pi
            .getAllTools()
            .map((t) => t.name)
            .filter((name) => name === "structured_output" || name === "worker_error" || name === "bash");
         try {
            pi.setActiveTools(workerOnly);
         } catch {
            // ignore
         }
         return;
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile?.();
      const requestedOwnerSessionId = ctx.sessionManager.getSessionId?.() ?? "parent";
      if (
         parentContext &&
         !switchingParent &&
         activeOwnerSessionId === requestedOwnerSessionId &&
         activeParentSessionFile === parentSessionFile
      ) {
         return;
      }

      const previousContext = parentContext;
      switchingParent = true;
      parentContext = undefined;
      activeOwnerSessionId = undefined;

      // Reset per-parent result delivery and async widget state.
      resultDelivery.clear();
      pendingProcessResults.clear();
      asyncWidget.clear(previousContext);

      let activationSucceeded = true;
      try {
         await runTool(runtime, activateParentSession(parentSessionFile));
      } catch (error: unknown) {
         activationSucceeded = false;
         try {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[workers] session activation failed: ${message}`);
         } catch {
            // ignore logging failure
         }
         if (ctx.hasUI) {
            try {
               ctx.ui.notify("Failed to load or persist Workers job history.", "error");
            } catch {
               // ignore notify failure
            }
         }
      }

      if (!activationSucceeded) {
         switchingParent = false;
         return;
      }

      parentContext = ctx;
      activeOwnerSessionId = requestedOwnerSessionId;
      activeParentSessionFile = parentSessionFile;
      switchingParent = false;

      void asyncWidget.update(ctx);
      void deliveryReady.then(() => {
         if (typeof ctx.isIdle === "function" && ctx.isIdle()) flushDeferredResults();
      });

      // Refresh worker tool metadata with the enabled agents for this cwd before the system prompt is built.
      const workerAugmentation = await resolveWorkerToolAugmentation(runtime, ctx.cwd);
      pi.registerTool(createWorkerToolDefinition(runtime, delivery, workerAugmentation));
   });

   pi.on("before_agent_start", (event) => {
      // Worker prompts move the selected body and contract before Pi's native prompt sections.
      const finalPrompt = parentContext ? event.systemPrompt : buildWorkerPromptForTurn(event.systemPrompt);
      return finalPrompt === event.systemPrompt ? undefined : { systemPrompt: finalPrompt };
   });

   pi.on("agent_end", flushDeferredResults);
   pi.on("agent_settled", flushDeferredResults);

   pi.on("session_shutdown", async () => {
      const shutdownContext = parentContext;
      switchingParent = true;
      asyncWidget.clear(parentContext);
      parentContext = undefined;
      activeOwnerSessionId = undefined;
      activeParentSessionFile = undefined;
      resultDelivery.clear();
      try {
         await deliveryReady;
      } catch {
         // Runtime disposal below handles failed subscription setup.
      }
      unsubscribeSettled?.();
      unsubscribeSettled = undefined;
      unsubscribeProcessSettled?.();
      unsubscribeProcessSettled = undefined;
      pendingProcessResults.clear();
      try {
         await runTool(
            runtime,
            WorkerManager.use((s) => s.disposeAllSessions)
         );
      } catch {
         // ignore
      }
      try {
         await runTool(
            runtime,
            ProcessSupervisor.use((s) => s.disposeAll)
         );
      } catch {
         // ignore
      }
      try {
         await runTool(runtime, flushPendingWrites());
      } catch (error: unknown) {
         try {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[workers] session shutdown flush failed: ${message}`);
            if (shutdownContext?.hasUI) {
               shutdownContext.ui.notify("Failed to save Workers job history on shutdown.", "error");
            }
         } catch {
            // ignore logging failure
         }
      }
      try {
         await runtime.dispose();
      } catch {
         // ignore dispose races
      }
   });

   return { ok: true, registered: "full", cutoverOk: true };
}

export default function workersExtension(pi: ExtensionAPI): void {
   registerWorkersExtension(pi);
}
