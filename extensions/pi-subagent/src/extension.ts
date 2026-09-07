/**
 * Standalone subagent delegation extension. It exposes
 * agent_spawn, agent_list, and agent_cancel, plus /wr.profile.
 *
 * Agents run as external child Pi sessions with profile-selected tools, model,
 * and thinking level. The parent monitors durable activity and exit sidecars.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAgentsRuntime, runTool } from "./runtime.js";
import { TaskRegistry } from "./services/task-registry.js";
import { AgentManager } from "./services/agent-manager.js";
import { activateParentSession, ensureParentSessionReady, flushPendingWrites } from "./services/task-session.js";
import { listAgentProfiles } from "./services/agent-profiles.ts";
import { openAgentsPanel } from "./ui/agent-profiles-panel.ts";
import {
   handleAgentSpawn,
   handleAgentList,
   handleAgentCancel,
   createAgentSpawnToolParamsSchema,
   AgentListToolParamsSchema,
   AgentCancelToolParamsSchema,
   AGENT_SPAWN_TOOL_BASE_DESCRIPTION,
   AGENT_SPAWN_TOOL_BASE_PROMPT_SNIPPET,
   augmentAgentToolMetadata,
   resolveAgentBackground
} from "./tools/agent.js";
import { formatDuration } from "./ui/formatters.js";
import {
   ASYNC_AGENT_WIDGET_KEY,
   buildAsyncAgentSnapshot,
   createAsyncAgentWidget,
   summarizeAsyncAgentStatus
} from "./ui/async-agent-widget.js";
import {
   renderAgentCall,
   renderAgentResult,
   renderAgentCancelCall,
   renderAgentCancelResult,
   renderAgentListCall,
   renderAgentListResult,
   extractMarkdownText
} from "./ui/tool-renderers.js";
import type { Task } from "./domain.js";

export type AgentsRuntime = ReturnType<typeof makeAgentsRuntime>;

export interface AgentsExtensionOptions {
   /** Injected for tests; production creates one runtime per extension load. */
   runtime?: AgentsRuntime;
}

export type RegistrationResult =
   | {
        ok: true;
        registered: "agent-only" | "full";
        cutoverOk: boolean;
        runtime: AgentsRuntime;
        refreshAgentSpawnTool: (cwd?: string) => Promise<void>;
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
   return extractMarkdownText(payload);
}

function collapsedResultText(payload: unknown): string {
   if (typeof payload === "string") return payload;
   if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const summary = (payload as { summary?: unknown }).summary;
      if (typeof summary === "string") return summary;
   }
   return extractMarkdownText(payload);
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

function settledIdsFromSpawnResult(result: unknown): string[] {
   const tasks = (result as { tasks?: ReadonlyArray<{ id: string; status: string }> } | undefined)?.tasks;
   if (!Array.isArray(tasks)) return [];
   return tasks.filter((task) => task.status === "completed" || task.status === "failed").map((task) => task.id);
}

interface ParentToolDelivery {
   readonly ready: Promise<void>;
   readonly notifyAsyncWidget: (ctx: ExtensionContext) => void;
}

function isBatchTask(task: Task): task is Task & { readonly batchId: string; readonly batchSize: number } {
   return (
      typeof task.batchId === "string" &&
      task.batchId.length > 0 &&
      typeof task.batchSize === "number" &&
      Number.isInteger(task.batchSize) &&
      task.batchSize > 1
   );
}

function createDeferredResultDelivery() {
   const pending = new Map<string, Task>();
   const sent = new Set<string>();

   const pendingGroups = (): Task[][] => {
      const singles: Task[][] = [];
      const batches = new Map<string, Task[]>();

      for (const task of pending.values()) {
         if (!isBatchTask(task)) {
            singles.push([task]);
            continue;
         }

         const tasks = batches.get(task.batchId);
         if (tasks) tasks.push(task);
         else batches.set(task.batchId, [task]);
      }

      const completeBatches = Array.from(batches.values()).filter((tasks) => {
         const expected = tasks[0]?.batchSize;
         return expected !== undefined && tasks.length >= expected;
      });

      return [...singles, ...completeBatches];
   };

   return {
      defer(task: Task): void {
         if (!pending.has(task.id)) sent.delete(task.id);
         pending.set(task.id, task);
      },
      isSent(id: string): boolean {
         return sent.has(id);
      },
      markSent(id: string): void {
         sent.add(id);
      },
      consume(ids: Iterable<string>): void {
         for (const id of ids) {
            pending.delete(id);
            sent.delete(id);
         }
      },
      pendingGroups,
      clear(): void {
         pending.clear();
         sent.clear();
      }
   };
}

interface AsyncAgentWidgetState {
   readonly update: (ctx: ExtensionContext) => Promise<void>;
   readonly clear: (ctx?: ExtensionContext) => void;
   readonly toggleExpanded: (ctx: ExtensionContext) => Promise<boolean>;
}

/** Mutable state for one extension registration's above-editor async agent widget. */
function makeAsyncAgentWidgetState(runtime: AgentsRuntime): AsyncAgentWidgetState {
   let shownCount = 0;
   let snapshot: string | undefined;
   let expanded = false;
   const clear = (ctx?: ExtensionContext) => {
      if (shownCount === 0 && snapshot === undefined) return;
      try {
         ctx?.ui.setWidget?.(ASYNC_AGENT_WIDGET_KEY, undefined);
      } catch {
         // UI may already be gone.
      }
      shownCount = 0;
      snapshot = undefined;
   };

   const update = async (ctx: ExtensionContext) => {
      if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") return;
      try {
         await runTool(
            runtime,
            AgentManager.use((manager) => manager.pruneClosedPanes())
         ).catch(() => {});
         const tasks = await runTool(
            runtime,
            TaskRegistry.use((registry) => registry.list())
         );
         const summary = summarizeAsyncAgentStatus(tasks);
         const shown = summary.running + summary.settled;
         if (shown === 0) {
            clear(ctx);
            return;
         }
         const nextSnapshot = buildAsyncAgentSnapshot(summary);
         if (nextSnapshot === snapshot && shown === shownCount) return;
         shownCount = shown;
         snapshot = nextSnapshot;
         ctx.ui.setWidget(ASYNC_AGENT_WIDGET_KEY, createAsyncAgentWidget(tasks, { expanded }));
      } catch {
         // ignore widget update races
      }
   };

   const toggleExpanded = async (ctx: ExtensionContext) => {
      expanded = !expanded;
      snapshot = undefined;
      await update(ctx);
      return expanded;
   };

   return { update, clear, toggleExpanded };
}

interface AgentToolAugmentation {
   readonly agentNames: ReadonlyArray<string>;
   readonly descriptionAppendix: string;
}

const EMPTY_AGENT_TOOL_AUGMENTATION: AgentToolAugmentation = {
   agentNames: [],
   descriptionAppendix: ""
};

async function resolveAgentToolAugmentation(runtime: AgentsRuntime, cwd?: string): Promise<AgentToolAugmentation> {
   if (!cwd) return EMPTY_AGENT_TOOL_AUGMENTATION;
   try {
      return augmentAgentToolMetadata(listAgentProfiles(cwd));
   } catch {
      return EMPTY_AGENT_TOOL_AUGMENTATION;
   }
}

function createAgentToolDefinition(
   runtime: AgentsRuntime,
   delivery: ParentToolDelivery,
   augmentation: AgentToolAugmentation
): any {
   const description = augmentation.descriptionAppendix
      ? `${AGENT_SPAWN_TOOL_BASE_DESCRIPTION}\n\n${augmentation.descriptionAppendix}`
      : AGENT_SPAWN_TOOL_BASE_DESCRIPTION;
   return {
      name: "agent_spawn" as const,
      label: "agent_spawn",
      description,
      promptSnippet: AGENT_SPAWN_TOOL_BASE_PROMPT_SNIPPET,
      parameters: createAgentSpawnToolParamsSchema(augmentation.agentNames),
      renderCall: renderAgentCall,
      renderResult: renderAgentResult,
      async execute(
         _toolCallId: string,
         params: any,
         signal: AbortSignal | undefined,
         _onUpdate: any,
         ctx: ExtensionContext
      ) {
         try {
            await runTool(runtime, ensureParentSessionReady(ctx.sessionManager.getSessionFile?.()));
            await delivery.ready;
            const result = await runTool(
               runtime,
               handleAgentSpawn(params, {
                  ownerSessionId: ctx.sessionManager.getSessionId?.() ?? "parent",
                  parentSessionFile: ctx.sessionManager.getSessionFile?.(),
                  modelRegistry: ctx.modelRegistry,
                  inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                  cwd: ctx.cwd
               }),
               { signal, interruptMessage: "agent spawn aborted" }
            );
            if (!resolveAgentBackground(params.background)) {
               const settledIds = settledIdsFromSpawnResult(result);
               if (settledIds.length > 0) {
                  try {
                     await runTool(
                        runtime,
                        AgentManager.use((manager) => manager.markResultsDelivered(settledIds))
                     );
                  } catch {
                     // A delivery acknowledgement must not fail a successful spawn result.
                  }
               }
            }
            if (ctx.hasUI) delivery.notifyAsyncWidget(ctx);
            return asTextResult(result);
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   };
}

/**
 * Rebuild the agent_spawn tool metadata for the current cwd and re-register it,
 * so agent enable/disable/create changes apply to the live session immediately.
 */
export async function refreshAgentSpawnTool(
   pi: ExtensionAPI,
   runtime: AgentsRuntime,
   delivery: ParentToolDelivery,
   cwd?: string
): Promise<void> {
   const augmentation = await resolveAgentToolAugmentation(runtime, cwd);
   pi.registerTool(createAgentToolDefinition(runtime, delivery, augmentation));
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
   readonly handler: (params: any, ctx: ExtensionContext) => any;
   readonly interruptMessage: string;
}

function createParentActionToolDefinition(
   runtime: AgentsRuntime,
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
      async execute(
         _toolCallId: string,
         params: any,
         signal: AbortSignal | undefined,
         _onUpdate: any,
         ctx: ExtensionContext
      ) {
         try {
            await delivery.ready;
            const result = await runTool(runtime, definition.handler(params, ctx), {
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

function registerParentTools(pi: ExtensionAPI, runtime: AgentsRuntime, delivery: ParentToolDelivery): void {
   pi.registerTool(createAgentToolDefinition(runtime, delivery, EMPTY_AGENT_TOOL_AUGMENTATION));
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "agent_list",
         label: "Agent List",
         description:
            "List agent tasks with status (pending, running, completed, failed, cancelled), error text, and session file.",
         promptSnippet: "List agent tasks.",
         parameters: AgentListToolParamsSchema,
         renderCall: renderAgentListCall,
         renderResult: renderAgentListResult,
         handler: handleAgentList,
         interruptMessage: "agent_list aborted"
      })
   );
   pi.registerTool(
      createParentActionToolDefinition(runtime, delivery, {
         name: "agent_cancel",
         label: "Agent Cancel",
         description: "Cancel an agent task by its task id.",
         promptSnippet: "Cancel an agent task.",
         parameters: AgentCancelToolParamsSchema,
         renderCall: renderAgentCancelCall,
         renderResult: renderAgentCancelResult,
         handler: handleAgentCancel,
         interruptMessage: "agent_cancel aborted"
      })
   );
}

function registerParentCommands(
   pi: ExtensionAPI,
   runtime: AgentsRuntime,
   delivery: ParentToolDelivery,
   widget: AsyncAgentWidgetState
): void {
   pi.registerCommand("wr.profile", {
      description: "Open the agent profile editor",
      handler: async (_rawArgs, ctx) => {
         if (ctx.hasUI) {
            await openAgentsPanel(ctx, undefined, {
               getAllTools: () =>
                  pi.getAllTools().map((tool) => ({
                     name: tool.name,
                     description: tool.description,
                     promptSnippet: (tool as { promptSnippet?: string }).promptSnippet,
                     promptGuidelines: tool.promptGuidelines,
                     source: tool.sourceInfo?.path ?? tool.sourceInfo?.source
                  })),
               onAgentsChanged: () => refreshAgentSpawnTool(pi, runtime, delivery, ctx.cwd)
            });
            return;
         }
         const profiles = listAgentProfiles(ctx.cwd);
         const lines = profiles.map(
            (profile) => `  ${profile.name}  ${profile.enabled ? "on" : "off"}  ${profile.description}`
         );
         ctx.ui.notify(["Agent profiles", "", ...lines].join("\n"), "info");
      }
   });
   pi.registerCommand("wr.close", {
      description: "Close panes for finished agents",
      handler: async (_rawArgs, ctx) => {
         const ownerSessionId = ctx.sessionManager.getSessionId?.() ?? "parent";
         const closed = await runTool(
            runtime,
            AgentManager.use((manager) => manager.closeSettledPanes(ownerSessionId))
         );
         try {
            await widget.update(ctx);
         } catch {
            // Widget refresh races must not change the close result.
         }
         try {
            if (typeof ctx.ui?.notify === "function") {
               ctx.ui.notify(`Closed ${closed} finished agent pane${closed === 1 ? "" : "s"}.`, "info");
            }
         } catch {
            // UI notification failures must not change the close result.
         }
      }
   });
   pi.registerCommand("wr", {
      description: "Expand or collapse the agents widget",
      handler: async (_rawArgs, ctx) => {
         const nowExpanded = await widget.toggleExpanded(ctx);
         if (!ctx.hasUI) {
            ctx.ui.notify(`Agents widget ${nowExpanded ? "expanded" : "collapsed"}.`, "info");
         }
      }
   });
}

/**
 * Register agents against a Pi ExtensionAPI.
 * Always registers tools with real execute handlers.
 * Parent commands/tools activate only when cutover passes (checked at load + session_start).
 */
export function registerAgentsExtension(pi: ExtensionAPI, options?: AgentsExtensionOptions): RegistrationResult {
   const runtime = options?.runtime ?? makeAgentsRuntime();

   pi.on("resources_discover", async (_event, _ctx) => {
      const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");
      return {
         promptPaths: [promptsDir]
      };
   });

   const resultDelivery = createDeferredResultDelivery();
   const asyncWidget = makeAsyncAgentWidgetState(runtime);
   let parentContext: ExtensionContext | undefined;
   let activeOwnerSessionId: string | undefined;
   let activeParentSessionFile: string | undefined;
   let switchingParent = false;
   let unsubscribeSettled: (() => void) | undefined;
   let unsubscribeChanged: (() => void) | undefined;
   let widgetRefreshTimer: ReturnType<typeof setInterval> | undefined;

   // Manual pane closes fire no registry change, so reconcile the widget on a
   // timer: prune drops entries whose Herdr pane is gone, update clears or
   // re-renders. The tick no-ops while no parent context is active.
   const startWidgetRefresh = () => {
      if (widgetRefreshTimer) return;
      widgetRefreshTimer = setInterval(() => {
         const ctx = parentContext;
         if (!ctx || switchingParent) return;
         void asyncWidget.update(ctx);
         if (ctx.isIdle()) flushDeferredResults();
      }, 5_000);
      (widgetRefreshTimer as unknown as { unref?: () => void }).unref?.();
   };
   const stopWidgetRefresh = () => {
      if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
      widgetRefreshTimer = undefined;
   };
   const deliverResult = (task: Task, triggerTurn = true) => {
      const output = task.errorText ?? task.resultData ?? "(no result returned)";
      const duration =
         task.settledAt === undefined ? undefined : formatDuration(task.settledAt - (task.startedAt ?? task.createdAt));
      const summary = `agent ${task.name ?? task.id} (${task.id}) ${task.status}${
         duration === undefined ? "" : ` in ${duration}`
      }.`;
      pi.sendMessage(
         {
            customType: "agents-result",
            content: `${summary}\n${fullResultText(output)}`,
            display: true,
            details: {
               id: task.id,
               name: task.name,
               profile: task.profile,
               status: task.status,
               duration,
               result: output
            }
         },
         { deliverAs: "followUp", triggerTurn }
      );
   };
   const flushResults = () => {
      for (const group of resultDelivery.pendingGroups()) {
         const lastDeliverableIndex = group.findLastIndex((task) => task.status !== "cancelled");
         let failed = false;
         for (let index = 0; index < group.length; index++) {
            const task = group[index];
            if (task.status === "cancelled" || resultDelivery.isSent(task.id)) continue;
            try {
               deliverResult(task, index === lastDeliverableIndex);
               resultDelivery.markSent(task.id);
               void runTool(
                  runtime,
                  AgentManager.use((manager) => manager.markResultsDelivered([task.id]))
               ).catch(() => {});
            } catch {
               failed = true;
               break;
            }
         }
         if (failed) continue;
         if (group.every((task) => task.status === "cancelled" || resultDelivery.isSent(task.id))) {
            resultDelivery.consume(group.map((task) => task.id));
         }
      }
   };
   const flushDeferredResults = () => {
      flushResults();
   };
   const deliveryReady = runTool(
      runtime,
      TaskRegistry.use((registry) =>
         Effect.gen(function* () {
            const unsubscribeSettledListener = yield* registry.onSettled((task) => {
               if (switchingParent || !parentContext || task.ownerSessionId !== activeOwnerSessionId) return;
               void asyncWidget.update(parentContext);
               if (task.background !== true) return;
               if (task.status === "cancelled" && !isBatchTask(task)) return;
               resultDelivery.defer({ ...task });
               if (parentContext.isIdle()) flushDeferredResults();
            });
            const unsubscribeChangeListener = yield* registry.onChange((tasks) => {
               if (switchingParent || !parentContext) return;
               if (!tasks.some((task) => task.ownerSessionId === activeOwnerSessionId)) return;
               void asyncWidget.update(parentContext);
            });
            return { unsubscribeSettledListener, unsubscribeChangeListener };
         })
      )
   ).then(({ unsubscribeSettledListener, unsubscribeChangeListener }) => {
      unsubscribeSettled = unsubscribeSettledListener;
      unsubscribeChanged = unsubscribeChangeListener;
   });
   // Parent tools + commands only when cutover passes.
   const delivery: ParentToolDelivery = {
      ready: deliveryReady,
      notifyAsyncWidget: (ctx) => void asyncWidget.update(ctx)
   };
   registerParentTools(pi, runtime, delivery);
   registerParentCommands(pi, runtime, delivery, asyncWidget);

   pi.registerMessageRenderer("agents-result", (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
         id?: string;
         name?: string;
         status?: string;
         duration?: string;
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
      const name = theme.fg("accent", details.name ?? details.id ?? "agent_spawn");
      const header = `${bgBadge} ${name}${theme.fg("muted", ` · ${status}${durationStr}`)}`;

      const agentBody =
         details.result === undefined
            ? body
            : expanded
              ? fullResultText(details.result)
              : collapsedResultText(details.result);
      const agentBodyLines = agentBody.length > 0 ? agentBody.split("\n") : [];
      const detailLines = agentBodyLines;
      const box = new Box(1, 1, (text) => theme.bg(bgColor, text));
      const headerLines = [header];
      if (detailLines.length > 0) headerLines.push(theme.fg("dim", "---"));
      box.addChild(new Text(headerLines.join("\n"), 0, 0));
      if (detailLines.length > 0) {
         const styledDetail = detailLines.map((line) => theme.fg("toolOutput", line)).join("\n");
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
   pi.registerEntryRenderer("agents-result", (entry) => {
      const data = (entry as { data?: { text?: string } }).data;
      const text = data?.text ?? JSON.stringify(data ?? {});
      return { render: () => [text] } as any;
   });
   startWidgetRefresh();
   pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
      // Print/agent child sessions: only agent tools.
      if (ctx.mode === "print" || !ctx.hasUI) {
         parentContext = undefined;
         activeOwnerSessionId = undefined;
         activeParentSessionFile = undefined;
         switchingParent = false;
         const agentOnly = pi
            .getAllTools()
            .map((t) => t.name)
            .filter((name) => name === "bash");
         try {
            pi.setActiveTools(agentOnly);
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
            console.error(`[agents] session activation failed: ${message}`);
         } catch {
            // ignore logging failure
         }
         if (ctx.hasUI) {
            try {
               ctx.ui.notify("Failed to load or persist agent run history.", "error");
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

      // Refresh agent tool metadata with the enabled agents for this cwd before the system prompt is built.
      const agentAugmentation = await resolveAgentToolAugmentation(runtime, ctx.cwd);
      pi.registerTool(createAgentToolDefinition(runtime, delivery, agentAugmentation));
   });

   pi.on("agent_end", flushDeferredResults);
   pi.on("agent_settled", flushDeferredResults);

   pi.on("session_shutdown", async () => {
      const shutdownContext = parentContext;
      switchingParent = true;
      stopWidgetRefresh();
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
      unsubscribeChanged?.();
      unsubscribeChanged = undefined;
      unsubscribeSettled = undefined;
      try {
         await runTool(
            runtime,
            AgentManager.use((s) => s.cancelActiveSessions)
         );
      } catch {
         // ignore
      }
      try {
         await runTool(runtime, flushPendingWrites());
      } catch (error: unknown) {
         try {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[agents] session shutdown flush failed: ${message}`);
            if (shutdownContext?.hasUI) {
               shutdownContext.ui.notify("Failed to save agent run history on shutdown.", "error");
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
      refreshAgentSpawnTool: (cwd) => refreshAgentSpawnTool(pi, runtime, delivery, cwd)
   };
}

export default function agentsExtension(pi: ExtensionAPI): void {
   if (process.env.PI_AGENT_ID) return;
   registerAgentsExtension(pi);
}
