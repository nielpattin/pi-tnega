/**
 * Harbor extension registration: real Pi ExtensionAPI wiring.
 *
 * Product gate (must be true before calling "done"):
 * - tools register with execute handlers that call HarborLive + runTool
 * - commands register real handlers (tasks/agents text, btw spawn)
 * - cutover fails closed without legacy force-excludes
 * - session_start enforces parent vs worker surfaces
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarborRuntime, runTool } from "./runtime.js";
import { buildWorkerSystemPrompt as orderWorkerSystemPrompt } from "./backends/pi.js";
import { JobRegistry } from "./services/JobRegistry.js";
import { ProcessSupervisor } from "./services/ProcessSupervisor.js";
import { TaskManager } from "./services/TaskManager.js";
import {
   activateParentSession,
   ensureParentSessionRecovery,
   flushPendingWrites
} from "./services/HarborJobRecovery.js";
import { createDeferredResultDelivery } from "./services/ResultDelivery.js";
import { AgentsStore } from "./services/AgentsStore.js";
import {
   handleTask,
   TaskToolParamsSchema,
   TASK_TOOL_BASE_DESCRIPTION,
   TASK_TOOL_BASE_PROMPT_SNIPPET,
   TASK_TOOL_BASE_PROMPT_GUIDELINES,
   augmentTaskToolMetadata
} from "./tools/task.js";
import { handleJobCancel, handleJobList, JobCancelToolParamsSchema, JobListToolParamsSchema } from "./tools/jobs.js";
import {
   handleProcessRestart,
   handleProcessSnapshot,
   handleProcessStart,
   ProcessRestartToolParamsSchema,
   ProcessSnapshotToolParamsSchema,
   ProcessStartToolParamsSchema
} from "./tools/process.js";
import { handleSubmit, SubmitToolParamsSchema } from "./tools/submit.js";
import { handleBtwCommand, formatBtwResultEntry } from "./commands/btw.js";
import { formatJobTable, formatProcessTable } from "./ui/formatters.js";
import { buildAgentsPanelViewModel, openAgentsPanel } from "./ui/agents-panel.js";
import { openTasksDashboard } from "./ui/tasks-dashboard.js";
import { ASYNC_TASK_WIDGET_KEY, createAsyncTaskWidget, summarizeAsyncTaskStatus } from "./ui/async-task-widget.js";
import {
   renderJobCancelCall,
   renderJobCancelResult,
   renderJobListCall,
   renderJobListResult,
   renderProcessRestartCall,
   renderProcessRestartResult,
   renderProcessSnapshotCall,
   renderProcessSnapshotResult,
   renderProcessStartCall,
   renderProcessStartResult,
   renderTaskCall,
   renderTaskResult,
   taskTraceLines
} from "./ui/tool-renderers.js";
import type { Job, ProcessEntry } from "./domain.js";

export type HarborRuntime = ReturnType<typeof makeHarborRuntime>;

export interface HarborExtensionOptions {
   settingsExtensions?: string[];
   /** Injected for tests; production creates one runtime per extension load. */
   runtime?: HarborRuntime;
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

function registerWorkerTools(pi: ExtensionAPI, runtime: HarborRuntime): void {
   pi.registerTool({
      name: "submit",
      label: "Submit",
      description: "Submit final task execution result or error (worker sessions).",
      parameters: SubmitToolParamsSchema,
      async execute(_toolCallId, params, signal) {
         try {
            const jobId = (params as { jobId?: string }).jobId;
            const result = await runTool(runtime, handleSubmit(params, { jobId }), {
               signal,
               interruptMessage: "submit aborted"
            });
            return asTextResult(result);
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   });
}

interface ParentToolDelivery {
   readonly ready: Promise<void>;
   readonly notifyAsyncWidget: (ctx: ExtensionContext) => void;
}

interface AsyncTaskWidgetState {
   readonly update: (ctx: ExtensionContext) => Promise<void>;
   readonly clear: (ctx?: ExtensionContext) => void;
}

/** Mutable state for one extension registration's above-editor async task widget. */
function makeAsyncTaskWidgetState(runtime: HarborRuntime): AsyncTaskWidgetState {
   let runningCount = 0;
   let snapshot: string | undefined;

   const clear = (ctx?: ExtensionContext) => {
      if (runningCount === 0 && snapshot === undefined) return;
      try {
         ctx?.ui.setWidget?.(ASYNC_TASK_WIDGET_KEY, undefined);
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
         const { running, completed, failed, activeNames } = summarizeAsyncTaskStatus(jobs);
         if (running === 0) {
            clear(ctx);
            return;
         }
         const nextSnapshot = `${running}:${completed}:${failed}:${activeNames.slice(0, 3).join(",")}`;
         if (nextSnapshot === snapshot && running === runningCount) return;
         runningCount = running;
         snapshot = nextSnapshot;
         ctx.ui.setWidget(ASYNC_TASK_WIDGET_KEY, createAsyncTaskWidget(jobs));
      } catch {
         // ignore widget update races
      }
   };

   return { update, clear };
}

interface TaskToolAugmentation {
   readonly descriptionAppendix: string;
   readonly additionalGuidelines: ReadonlyArray<string>;
}

const EMPTY_TASK_TOOL_AUGMENTATION: TaskToolAugmentation = {
   descriptionAppendix: "",
   additionalGuidelines: []
};

async function resolveTaskToolAugmentation(runtime: HarborRuntime, cwd?: string): Promise<TaskToolAugmentation> {
   if (!cwd) return EMPTY_TASK_TOOL_AUGMENTATION;
   try {
      const agents = await runTool(
         runtime,
         AgentsStore.use((store) => store.listAgents(cwd))
      );
      return augmentTaskToolMetadata(agents);
   } catch {
      return EMPTY_TASK_TOOL_AUGMENTATION;
   }
}

function createTaskToolDefinition(
   runtime: HarborRuntime,
   delivery: ParentToolDelivery,
   augmentation: TaskToolAugmentation
): any {
   const description = augmentation.descriptionAppendix
      ? `${TASK_TOOL_BASE_DESCRIPTION}\n\n${augmentation.descriptionAppendix}`
      : TASK_TOOL_BASE_DESCRIPTION;
   return {
      name: "task_spawn" as const,
      label: "Task",
      description,
      promptSnippet: TASK_TOOL_BASE_PROMPT_SNIPPET,
      promptGuidelines: [...TASK_TOOL_BASE_PROMPT_GUIDELINES, ...augmentation.additionalGuidelines],
      parameters: TaskToolParamsSchema,
      renderCall: renderTaskCall,
      renderResult: renderTaskResult,
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
               handleTask(params, {
                  ownerSessionId: ctx.sessionManager.getSessionId?.() ?? "parent",
                  parentSessionFile: ctx.sessionManager.getSessionFile?.(),
                  modelRegistry: ctx.modelRegistry,
                  inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                  cwd: ctx.cwd
               }),
               { signal, interruptMessage: "task aborted" }
            );
            if (ctx.hasUI) delivery.notifyAsyncWidget(ctx);
            return asTextResult(result);
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   };
}

const TASK_JOB_PROMPT_GUIDELINES = [
   "Use job_list to see task and process job status.",
   "Use job_cancel with a task job ID to cancel a delegated task."
];

const PROCESS_JOB_PROMPT_GUIDELINES = [
   'Use process_start ONLY for never-ending services that run until stopped, for example { name: "api", command: "pnpm dev" }. For one-shot checks (pnpm lint, pnpm exec tsc --noEmit, pnpm fmt, git diff --check) use bash.',
   "process_start creates a retained process-N job. It is not a one-shot shell.",
   "Use process_snapshot with a process job ID to read a retained process job.",
   "Use job_cancel with a process job ID to stop a retained process job.",
   "Use process_restart with a process job ID to restart a retained process job."
];

const JOB_CANCEL_PROMPT_GUIDELINES = [
   "Use job_cancel with a task job ID to cancel a delegated task.",
   "Use job_cancel with a process job ID to stop a long-running process."
];

interface ParentActionToolDefinition {
   readonly name: string;
   readonly label: string;
   readonly description: string;
   readonly promptSnippet: string;
   readonly promptGuidelines: ReadonlyArray<string>;
   readonly parameters: any;
   readonly renderCall: any;
   readonly renderResult: any;
   readonly handler: (params: any) => any;
   readonly interruptMessage: string;
}

function createParentActionToolDefinition(
   runtime: HarborRuntime,
   delivery: ParentToolDelivery,
   definition: ParentActionToolDefinition
) {
   return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: [...definition.promptGuidelines],
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

function registerParentTools(pi: ExtensionAPI, runtime: HarborRuntime, delivery: ParentToolDelivery): void {
   pi.registerTool(createTaskToolDefinition(runtime, delivery, EMPTY_TASK_TOOL_AUGMENTATION));
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "job_list",
         label: "Job List",
         description: "List agent task jobs and long-running process jobs.",
         promptSnippet: "List Harbor jobs.",
         promptGuidelines: TASK_JOB_PROMPT_GUIDELINES,
         parameters: JobListToolParamsSchema,
         renderCall: renderJobListCall,
         renderResult: renderJobListResult,
         handler: handleJobList,
         interruptMessage: "job_list aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "job_cancel",
         label: "Job Cancel",
         description: "Cancel an agent task or stop a long-running process by job ID.",
         promptSnippet: "Cancel or stop a Harbor job.",
         promptGuidelines: JOB_CANCEL_PROMPT_GUIDELINES,
         parameters: JobCancelToolParamsSchema,
         renderCall: renderJobCancelCall,
         renderResult: renderJobCancelResult,
         handler: handleJobCancel,
         interruptMessage: "job_cancel aborted"
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
         promptGuidelines: PROCESS_JOB_PROMPT_GUIDELINES,
         parameters: ProcessStartToolParamsSchema,
         renderCall: renderProcessStartCall,
         renderResult: renderProcessStartResult,
         handler: handleProcessStart,
         interruptMessage: "process_start aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "process_snapshot",
         label: "Process Snapshot",
         description: "Read status and recent logs for a retained process job. For one-shot bash output use bash.",
         promptSnippet: "Read a retained process snapshot. Use bash for one-shot checks.",
         promptGuidelines: PROCESS_JOB_PROMPT_GUIDELINES,
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
         description: "Restart a retained process job by Harbor job ID.",
         promptSnippet: "Restart a retained process job.",
         promptGuidelines: PROCESS_JOB_PROMPT_GUIDELINES,
         parameters: ProcessRestartToolParamsSchema,
         renderCall: renderProcessRestartCall,
         renderResult: renderProcessRestartResult,
         handler: handleProcessRestart,
         interruptMessage: "process_restart aborted"
      })
   );
}

function registerParentCommands(pi: ExtensionAPI, runtime: HarborRuntime, delivery: ParentToolDelivery): void {
   pi.registerCommand("tasks", {
      description: "List harbor jobs and background processes",
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
            "Harbor /tasks",
            "",
            "Jobs:",
            formatJobTable(jobs),
            "",
            "Processes:",
            formatProcessTable(processes)
         ].join("\n");
         if (ctx.hasUI) {
            await openTasksDashboard(ctx as any, runtime);
         }
         pi.appendEntry("harbor-tasks-snapshot", { text, at: Date.now() });
      }
   });

   pi.registerCommand("agents", {
      description: "Show harbor agent profiles",
      handler: async (_args, ctx) => {
         const agents = await runTool(
            runtime,
            AgentsStore.use((s) => s.listAgents(ctx.cwd))
         );
         const model = buildAgentsPanelViewModel({ agents });
         const lines = [
            "Harbor /agents",
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
         pi.appendEntry("harbor-agents-snapshot", { model, at: Date.now() });
      }
   });

   pi.registerCommand("btw", {
      description: "Ask a side question without consuming a normal agent slot",
      handler: async (args, ctx) => {
         const prompt = args.trim();
         if (!prompt) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /btw <question>", "error");
            return;
         }

         try {
            const parentSessionFile = ctx.sessionManager.getSessionFile?.();
            await runTool(runtime, ensureParentSessionRecovery(parentSessionFile));

            const jobs = await runTool(
               runtime,
               JobRegistry.use((r) => r.list())
            );
            const activeBtwCount = jobs.filter(
               (j: Job) => j.origin === "btw" && (j.status === "running" || j.status === "pending")
            ).length;

            const taskManager = await runTool(runtime, TaskManager);
            const result = await handleBtwCommand({
               prompt,
               parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
               parentSessionFile,
               activeBtwCount,
               taskManager
            });

            if (!result.ok) {
               if (ctx.hasUI) ctx.ui.notify(result.message ?? "btw failed", "error");
               return;
            }

            if (result.jobId) {
               const job = await runTool(
                  runtime,
                  JobRegistry.use((r) => r.get(result.jobId!))
               );
               if (job) {
                  const entry = formatBtwResultEntry(job);
                  pi.appendEntry(entry.customType, entry.data);
               }
            }

            if (ctx.hasUI) ctx.ui.notify(`btw started: ${result.jobId}`, "info");
         } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (ctx.hasUI) ctx.ui.notify(message, "error");
         }
      }
   });
}

/**
 * Register harbor against a Pi ExtensionAPI.
 * Always registers tools with real execute handlers.
 * Parent commands/tools activate only when cutover passes (checked at load + session_start).
 */
export function registerHarborExtension(pi: ExtensionAPI, options?: HarborExtensionOptions): RegistrationResult {
   const runtime = options?.runtime ?? makeHarborRuntime();

   // Prefer explicit test injection; otherwise read real agent settings.json from disk.
   // ExtensionAPI has no getSettings(); previous code always saw [] and false-blocked cutover.
   const settingsExtensions = options?.settingsExtensions ?? loadSettingsExtensionsFromDisk();

   // Worker tools always present (submit only).
   registerWorkerTools(pi, runtime);

   const resultDelivery = createDeferredResultDelivery();
   const asyncWidget = makeAsyncTaskWidgetState(runtime);
   let parentContext: ExtensionContext | undefined;
   let activeOwnerSessionId: string | undefined;
   let activeParentSessionFile: string | undefined;
   let switchingParent = false;
   let unsubscribeSettled: (() => void) | undefined;
   let unsubscribeProcessSettled: (() => void) | undefined;
   const pendingProcessResults = new Map<string, ProcessEntry>();

   const deliverResult = (job: Job) => {
      const output = job.errorText ?? job.resultData ?? "(no result returned)";
      pi.sendMessage(
         {
            customType: "harbor-result",
            content: `Task ${job.name ?? job.id} (${job.id}) ${job.status}.\n${fullResultText(output)}`,
            display: true,
            details: {
               id: job.id,
               name: job.name,
               status: job.status,
               result: output,
               transcript: job.transcript
            }
         },
         { deliverAs: "steer", triggerTurn: true }
      );
   };
   const flushResults = () => {
      for (const job of resultDelivery.pending()) {
         try {
            deliverResult(job);
            resultDelivery.consume([job.id]);
         } catch {
            // Keep failed deliveries queued for the next idle lifecycle event.
         }
      }
   };
   const deliverProcessResult = (process: ProcessEntry) => {
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
            customType: "harbor-result",
            content: `Process ${process.name ?? process.id} (${process.id}) ${outcome}${termination}.\n${fullResultText(output)}`,
            display: true,
            details: { kind: "process", id: process.id, name: process.name, status: process.status }
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
               if (resultDelivery.shouldSuppress(job)) return;
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

   pi.registerMessageRenderer("harbor-result", (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
         kind?: "process" | "task";
         id?: string;
         name?: string;
         status?: string;
         transcript?: unknown;
         result?: unknown;
      };
      const failed = details.status === "failed" || details.status === "cancelled";
      const bgColor = failed ? "toolErrorBg" : "toolSuccessBg";
      const content = typeof message.content === "string" ? message.content : "";
      const body = content.split("\n").slice(1).join("\n").trim();
      const bodyLines = body.length > 0 ? body.split("\n") : [];
      const bgBadge = theme.fg("customMessageLabel", "[bg]");
      const title = theme.fg("toolTitle", theme.bold(details.kind === "process" ? "process" : "task"));
      const name = theme.fg("accent", details.name ?? details.id ?? (details.kind === "process" ? "process" : "task"));
      const meta = theme.fg("muted", ` · ${details.id ?? "?"} · ${details.status ?? "completed"}`);
      const indicator = theme.fg(failed ? "error" : "success", failed ? "✗" : "✓");
      const header = `${bgBadge} ${title} ${name}${meta} ${indicator}`;

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

      const traceLines = taskTraceLines(details.transcript, theme, expanded);
      const taskBody =
         details.result === undefined
            ? body
            : expanded
              ? fullResultText(details.result)
              : collapsedResultText(details.result);
      const taskBodyLines = taskBody.length > 0 ? taskBody.split("\n") : [];
      const detailLines = [...traceLines, ...taskBodyLines];
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
         const schemaOverflowLines = (_hiddenLines: number) => [
            theme.fg("dim", "---"),
            theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`
         ];
         const hasFullResult = details.result !== undefined;
         box.addChild(
            new LimitedText(
               styledDetail,
               expanded ? Number.POSITIVE_INFINITY : 6,
               hasFullResult ? schemaOverflowLines : (hiddenLines) => [overflowLine(hiddenLines)],
               hasFullResult && !expanded
            )
         );
      }
      return box;
   });
   pi.registerEntryRenderer("harbor-result", (entry) => {
      const data = (entry as { data?: { text?: string } }).data;
      const text = data?.text ?? JSON.stringify(data ?? {});
      return { render: () => [text] } as any;
   });
   pi.registerEntryRenderer("btw-result", (entry) => {
      const data = (entry as { data?: { text?: string; jobId?: string; status?: string } }).data;
      const text = data?.text ?? JSON.stringify(data ?? {});
      return { render: () => [`btw ${data?.jobId ?? ""} (${data?.status ?? "?"}): ${text}`] } as any;
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
            .filter((name) => name === "submit" || name === "bash");
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
            console.error(`[harbor] session activation failed: ${message}`);
         } catch {
            // ignore logging failure
         }
         if (ctx.hasUI) {
            try {
               ctx.ui.notify("Failed to load or persist Harbor job history.", "error");
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

      // Refresh task tool metadata with the enabled agents for this cwd before the system prompt is built.
      const taskAugmentation = await resolveTaskToolAugmentation(runtime, ctx.cwd);
      pi.registerTool(createTaskToolDefinition(runtime, delivery, taskAugmentation));

      try {
         const normalTools = pi.getActiveTools().filter((name) => name !== "submit");
         pi.setActiveTools(normalTools);
      } catch {
         // session_start may run before active-tool mutation is available in some hosts.
      }
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
            TaskManager.use((s) => s.disposeAllSessions)
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
            console.error(`[harbor] session shutdown flush failed: ${message}`);
            if (shutdownContext?.hasUI) {
               shutdownContext.ui.notify("Failed to save Harbor job history on shutdown.", "error");
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

export default function harborExtension(pi: ExtensionAPI): void {
   registerHarborExtension(pi);
}
