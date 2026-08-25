/**
 * Workers extension registration: real Pi ExtensionAPI wiring.
 *
 * Product gate (must be true before calling "done"):
 * - tools register with execute handlers that call WorkersLive + runTool
 * - commands register real worker handlers
 * - cutover fails closed without legacy force-excludes
 * - session_start enforces parent vs worker surfaces
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorkersRuntime, runTool } from "./runtime.js";
import { JobRegistry } from "./services/job-registry.js";
import { WorkerManager } from "./services/worker-manager.js";
import {
   activateParentSession,
   ensureParentSessionRecovery,
   flushPendingWrites
} from "./services/workers-job-recovery.js";
import { listAgentProfiles } from "../services/agent-profiles.ts";
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
import { formatDuration, formatRunTable } from "./ui/formatters.js";
import {
   ASYNC_WORKER_WIDGET_KEY,
   createAsyncWorkerWidget,
   summarizeAsyncWorkerStatus
} from "./ui/async-worker-widget.js";
import {
   renderWorkerCall,
   renderWorkerResult,
   renderWorkerCancelCall,
   renderWorkerCancelResult,
   renderWorkerListCall,
   renderWorkerListResult,
   workerTraceLines
} from "./ui/tool-renderers.js";
import type { Job } from "./domain.js";

export type WorkersRuntime = ReturnType<typeof makeWorkersRuntime>;

export interface WorkersExtensionOptions {
   /** Injected for tests; production creates one runtime per extension load. */
   runtime?: WorkersRuntime;
   /** Open the shared runs dashboard when the parent command is used. */
   openDashboard?: (ctx: ExtensionContext, runtime: WorkersRuntime, initialTab: "worker") => Promise<void>;
}

export type RegistrationResult =
   | {
        ok: true;
        registered: "worker-only" | "full";
        cutoverOk: boolean;
        runtime: WorkersRuntime;
        refreshWorkerSpawnTool: (cwd?: string) => Promise<void>;
     }
   | { ok: false; error: string; cutoverOk: false };

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

function isBatchJob(job: Job): job is Job & { readonly batchId: string; readonly batchSize: number } {
   return (
      typeof job.batchId === "string" &&
      job.batchId.length > 0 &&
      typeof job.batchSize === "number" &&
      Number.isInteger(job.batchSize) &&
      job.batchSize > 1
   );
}

function createDeferredResultDelivery() {
   const pending = new Map<string, Job>();

   const pendingGroups = (): Job[][] => {
      const singles: Job[][] = [];
      const batches = new Map<string, Job[]>();

      for (const job of pending.values()) {
         if (!isBatchJob(job)) {
            singles.push([job]);
            continue;
         }

         const jobs = batches.get(job.batchId);
         if (jobs) jobs.push(job);
         else batches.set(job.batchId, [job]);
      }

      const completeBatches = Array.from(batches.values()).filter((jobs) => {
         const expected = jobs[0]?.batchSize;
         return expected !== undefined && jobs.length >= expected;
      });

      return [...singles, ...completeBatches];
   };

   return {
      defer(job: Job): void {
         pending.set(job.id, job);
      },
      consume(ids: Iterable<string>): void {
         for (const id of ids) pending.delete(id);
      },
      pendingGroups,
      clear(): void {
         pending.clear();
      }
   };
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
      return augmentWorkerToolMetadata(listAgentProfiles(cwd));
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

function registerParentTools(pi: ExtensionAPI, runtime: WorkersRuntime, delivery: ParentToolDelivery): void {
   pi.registerTool(createWorkerToolDefinition(runtime, delivery, EMPTY_WORKER_TOOL_AUGMENTATION));
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "worker_list",
         label: "Worker List",
         description: "List worker runs.",
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
         description: "Cancel a worker by run ID.",
         promptSnippet: "Cancel a worker.",
         parameters: WorkerCancelToolParamsSchema,
         renderCall: renderWorkerCancelCall,
         renderResult: renderWorkerCancelResult,
         handler: handleWorkerCancel,
         interruptMessage: "worker_cancel aborted"
      })
   );
}

function registerParentCommands(
   pi: ExtensionAPI,
   runtime: WorkersRuntime,
   delivery: ParentToolDelivery,
   openDashboard?: WorkersExtensionOptions["openDashboard"]
): void {
   const openRuns = async (ctx: ExtensionContext) => {
      if (ctx.hasUI && openDashboard) await openDashboard(ctx, runtime, "worker");
      const jobs = await runTool(
         runtime,
         JobRegistry.use((r) => r.list())
      );
      pi.appendEntry("workers-snapshot", {
         text: ["Worker Runs", "", formatRunTable(jobs)].join("\n"),
         at: Date.now()
      });
   };
   pi.registerCommand("wr", {
      description: "Open worker runs",
      handler: async (_args, ctx) => openRuns(ctx)
   });
}

/**
 * Register workers against a Pi ExtensionAPI.
 * Always registers tools with real execute handlers.
 * Parent commands/tools activate only when cutover passes (checked at load + session_start).
 */
export function registerWorkersExtension(pi: ExtensionAPI, options?: WorkersExtensionOptions): RegistrationResult {
   const runtime = options?.runtime ?? makeWorkersRuntime();

   pi.on("resources_discover", async (_event, _ctx) => {
      const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../../prompts");
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
   const flushDeferredResults = () => {
      flushResults();
   };
   const deliveryReady = runTool(
      runtime,
      JobRegistry.use((registry) =>
         registry.onSettled((job) => {
            if (switchingParent || !parentContext || job.ownerSessionId !== activeOwnerSessionId) return;
            void asyncWidget.update(parentContext);
            if (job.status === "cancelled") return;
            resultDelivery.defer({ ...job });
            if (parentContext.isIdle()) flushDeferredResults();
         })
      )
   ).then((unsubscribe) => {
      unsubscribeSettled = unsubscribe;
   });

   // Parent tools + commands only when cutover passes.
   const delivery: ParentToolDelivery = {
      ready: deliveryReady,
      notifyAsyncWidget: (ctx) => void asyncWidget.update(ctx)
   };
   registerParentTools(pi, runtime, delivery);
   registerParentCommands(pi, runtime, delivery, options?.openDashboard);

   pi.registerMessageRenderer("workers-result", (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
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
      const name = theme.fg("accent", details.name ?? details.id ?? "worker_spawn");
      const header = `${bgBadge} ${name}${theme.fg("muted", ` · ${status}${durationStr}`)}`;

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
            .filter((name) => name === "structured_output" || name === "bash");
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
               ctx.ui.notify("Failed to load or persist worker run history.", "error");
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
      try {
         await runTool(
            runtime,
            WorkerManager.use((s) => s.cancelActiveSessions)
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
               shutdownContext.ui.notify("Failed to save worker run history on shutdown.", "error");
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

   return {
      ok: true,
      registered: "full",
      cutoverOk: true,
      runtime,
      refreshWorkerSpawnTool: (cwd) => refreshWorkerSpawnTool(pi, runtime, delivery, cwd)
   };
}

export default function workersExtension(pi: ExtensionAPI): void {
   registerWorkersExtension(pi);
}
