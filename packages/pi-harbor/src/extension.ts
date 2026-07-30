/**
 * Harbor extension registration: real Pi ExtensionAPI wiring.
 *
 * Product gate (must be true before calling "done"):
 * - tools register with execute handlers that call HarborLive + runTool
 * - commands register real handlers (tasks/agents text, vibe toggle, btw spawn)
 * - cutover fails closed without legacy force-excludes
 * - session_start enforces parent vs worker surfaces
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Box, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCutover, type CutoverItem } from "./cutover.js";
import { makeHarborRuntime, runTool } from "./runtime.js";
import { JobRegistry } from "./services/JobRegistry.js";
import { ProcessSupervisor } from "./services/ProcessSupervisor.js";
import { TaskManager } from "./services/TaskManager.js";
import {
   activateParentSession,
   ensureParentSessionRecovery,
   flushPendingWrites
} from "./services/HarborJobRecovery.js";
import { createDeferredResultDelivery } from "./services/ResultDelivery.js";
import { VibeState, isDirectorTool } from "./services/VibeState.js";
import { AgentsStore } from "./services/AgentsStore.js";
import {
   handleTask,
   TaskToolParamsSchema,
   TASK_TOOL_BASE_DESCRIPTION,
   TASK_TOOL_BASE_PROMPT_SNIPPET,
   TASK_TOOL_BASE_PROMPT_GUIDELINES,
   augmentTaskToolMetadata
} from "./tools/task.js";
import { handleHub, ParentHubToolParamsSchema, WorkerHubToolParamsSchema } from "./tools/hub.js";
import { handleSubmit, SubmitToolParamsSchema } from "./tools/submit.js";
import { VibeToolParamsSchema, type VibeToolParams } from "./tools/vibe.js";
import { handleVibeCommand } from "./commands/vibe.js";
import { handleBtwCommand, formatBtwResultEntry } from "./commands/btw.js";
import { formatJobTable, formatProcessTable } from "./ui/formatters.js";
import { buildAgentsPanelViewModel, openAgentsPanel } from "./ui/agents-panel.js";
import { openTasksDashboard } from "./ui/tasks-dashboard.js";
import { ASYNC_TASK_WIDGET_KEY, createAsyncTaskWidget, summarizeAsyncTaskStatus } from "./ui/async-task-widget.js";
import {
   renderHubCall,
   renderHubResult,
   renderTaskCall,
   renderTaskResult,
   renderVibeCall,
   renderVibeResult
} from "./ui/tool-renderers.js";
import type { Job } from "./domain.js";

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

const MODEL_TOOL_STRING_LIMIT = 2_000;
const MODEL_TOOL_ARRAY_LIMIT = 8;
const MODEL_TOOL_CONTENT_LIMIT = 16_000;
const MODEL_TOOL_OMITTED_KEYS = new Set(["rawText", "transcript", "promptOrCommand"]);

function compactModelValue(value: unknown, depth = 0): unknown {
   if (typeof value === "string") {
      return value.length <= MODEL_TOOL_STRING_LIMIT
         ? value
         : `${value.slice(0, MODEL_TOOL_STRING_LIMIT)}\n… [truncated ${value.length - MODEL_TOOL_STRING_LIMIT} characters]`;
   }
   if (value === null || typeof value !== "object") return value;
   if (depth >= 5) return "[nested value omitted]";
   if (Array.isArray(value)) {
      const compact = value.slice(0, MODEL_TOOL_ARRAY_LIMIT).map((item) => compactModelValue(item, depth + 1));
      if (value.length > MODEL_TOOL_ARRAY_LIMIT)
         compact.push(`… [${value.length - MODEL_TOOL_ARRAY_LIMIT} more items]`);
      return compact;
   }
   const compact: Record<string, unknown> = {};
   for (const [key, item] of Object.entries(value)) {
      if (!MODEL_TOOL_OMITTED_KEYS.has(key)) compact[key] = compactModelValue(item, depth + 1);
   }
   return compact;
}

function modelFacingText(payload: unknown): string {
   const compact = compactModelValue(payload);
   const text = typeof compact === "string" ? compact : JSON.stringify(compact, null, 2);
   if (text.length <= MODEL_TOOL_CONTENT_LIMIT) return text;
   return JSON.stringify(
      {
         ok: typeof payload === "object" && payload !== null && "ok" in payload ? payload.ok : true,
         truncated: true,
         message: "Tool result exceeded the model-facing output limit. Expand the tool row for full details."
      },
      null,
      2
   );
}

function asTextResult(payload: unknown) {
   return {
      content: [{ type: "text" as const, text: modelFacingText(payload) }],
      details: payload
   };
}

function asErrorResult(message: string) {
   return {
      content: [{ type: "text" as const, text: message }],
      details: { ok: false, error: message }
   };
}

/**
 * Build the model-facing response for an explicit `hub wait` on task jobs.
 *
 * Because `modelFacingText`/`compactModelValue` depth counting starts at the
 * root of the payload, returning a full `{ ok: true, jobs: [...] }` envelope
 * pushes `resultData` several levels deep and causes ordinary nested results to
 * be replaced with `[nested value omitted]`. This helper surfaces each job's
 * bounded output directly, resetting the depth budget for the actual result
 * while keeping the full job records in `details` for UI rendering.
 */
function asHubWaitResult(jobs: ReadonlyArray<Job>) {
   const outputs = jobs.map((job) => {
      const output = job.errorText ?? job.resultData ?? "(no result returned)";
      return {
         id: job.id,
         name: job.name,
         status: job.status,
         output: modelFacingText(output)
      };
   });

   let text: string;
   if (outputs.length === 1) {
      text = outputs[0].output;
   } else {
      text = outputs.map((o) => `Job ${o.id} (${o.status}):\n${o.output}`).join("\n\n");
   }

   if (text.length > MODEL_TOOL_CONTENT_LIMIT) {
      text = JSON.stringify(
         {
            ok: true,
            truncated: true,
            message: "Hub wait result exceeded the model-facing output limit. Expand the tool row for full details."
         },
         null,
         2
      );
   }

   return {
      content: [{ type: "text" as const, text }],
      details: { ok: true, jobs }
   };
}

function customEntries(ctx: ExtensionContext): Array<{ customType?: string; data?: unknown }> {
   try {
      return ctx.sessionManager.getEntries().map((entry) => {
         const anyEntry = entry as { type?: string; customType?: string; data?: unknown };
         if (anyEntry.type === "custom") {
            return { customType: anyEntry.customType, data: anyEntry.data };
         }
         return { customType: anyEntry.customType, data: anyEntry.data };
      });
   } catch {
      return [];
   }
}

function cutoverItemsFromTools(pi: ExtensionAPI): CutoverItem[] {
   try {
      return pi.getAllTools().map((tool) => ({
         name: tool.name,
         sourceInfo: tool.sourceInfo ? { path: tool.sourceInfo.path } : undefined
      }));
   } catch {
      return [];
   }
}

function cutoverItemsFromCommands(pi: ExtensionAPI): CutoverItem[] {
   try {
      return pi.getCommands().map((cmd) => ({
         name: cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`,
         sourceInfo: undefined
      }));
   } catch {
      return [];
   }
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

   pi.registerTool({
      name: "hub",
      label: "Hub",
      description:
         "Run synchronous shell commands and exchange worker mailbox messages with exec, send, inbox, list, and wait-from operations.",
      promptSnippet: "Run synchronous worker shell commands and exchange mailbox messages.",
      promptGuidelines: [
         "Use hub exec for synchronous shell commands in Pi worker sessions; hub async execution is unavailable to workers.",
         "Use hub send, inbox, list, and wait-from only for worker mailbox communication.",
         "Worker hub list returns mailbox peers. It does not return parent task jobs or OS processes."
      ],
      parameters: WorkerHubToolParamsSchema,
      renderCall: renderHubCall,
      renderResult: renderHubResult,
      async execute(_toolCallId, params, signal) {
         try {
            const result = await runTool(
               runtime,
               handleHub(params, {
                  isWorker: true
               }),
               { signal, interruptMessage: "hub aborted" }
            );
            return asTextResult(result);
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   });
}

interface ParentToolDelivery {
   readonly ready: Promise<void>;
   readonly consume: (ids: Iterable<string>) => void;
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

async function resolveTaskToolAugmentation(runtime: HarborRuntime, cwd?: string): Promise<TaskToolAugmentation> {
   if (!cwd) return { descriptionAppendix: "", additionalGuidelines: [] };
   try {
      const agents = await runTool(
         runtime,
         AgentsStore.use((store) => store.listAgents(cwd))
      );
      return augmentTaskToolMetadata(agents);
   } catch {
      return { descriptionAppendix: "", additionalGuidelines: [] };
   }
}

function createTaskToolDefinition(
   runtime: HarborRuntime,
   delivery: ParentToolDelivery,
   augmentation: TaskToolAugmentation
) {
   const description = augmentation.descriptionAppendix
      ? `${TASK_TOOL_BASE_DESCRIPTION}\n\n${augmentation.descriptionAppendix}`
      : TASK_TOOL_BASE_DESCRIPTION;
   return {
      name: "task" as const,
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
         onUpdate: any,
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
                  cwd: ctx.cwd,
                  onUpdate: (summary) => onUpdate?.(asTextResult(summary))
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

function registerParentTools(pi: ExtensionAPI, runtime: HarborRuntime, delivery: ParentToolDelivery): void {
   pi.registerTool(createTaskToolDefinition(runtime, delivery, { descriptionAppendix: "", additionalGuidelines: [] }));

   // Parent hub overrides worker hub with full ops (same name; last register wins on load order).
   // We keep a single hub tool that detects worker via options at call sites.
   pi.registerTool({
      name: "hub",
      label: "Hub",
      description:
         "Monitor agent jobs, wait for task results, supervise named OS processes, run shell commands, and exchange mailbox messages. Use jobs/describe/wait/cancel for jobs; ps/start/logs/stop/restart for processes; send/inbox/list/wait-from for messages.",
      promptSnippet: "Monitor task jobs, supervise named processes, execute shell commands, and exchange messages.",
      promptGuidelines: [
         'Use hub { op: "jobs" } to list agent jobs and hub { op: "describe", id: "task-1" } to inspect one job.',
         'Background task results arrive automatically. Use hub { op: "wait", target: "jobs", ids: ["task-1"] } only for manual recovery or explicitly requested blocking. Call hub wait alone in its tool batch.',
         "Use hub process operations with process names. hub logs, stop, restart, and process describe do not accept task job ids.",
         'Use hub { op: "ps" } to list supervised OS processes. hub { op: "list" } lists mailbox peers, not jobs or processes.',
         "Hub has no status, get-status, peek, message, or log operation. Use hub jobs, describe, wait, send, or logs as documented."
      ],
      parameters: ParentHubToolParamsSchema,
      renderCall: renderHubCall,
      renderResult: renderHubResult,
      async execute(_toolCallId, params, signal) {
         try {
            const result = await runTool(runtime, handleHub(params, { isWorker: false }), {
               signal,
               interruptMessage: "hub aborted"
            });
            if (params.op === "wait" && params.target === "jobs") {
               delivery.consume(params.ids);
               const hubResult = result as { ok?: boolean; jobs?: Job[] };
               if (hubResult.ok === true && Array.isArray(hubResult.jobs)) {
                  return asHubWaitResult(hubResult.jobs);
               }
            }
            return asTextResult(result);
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   });

   pi.registerTool({
      name: "vibe",
      label: "Vibe",
      description:
         "Control Vibe Director workers with spawn, send, wait, kill, and list operations. Use fast or good for spawn and reuse returned session handles for later operations. Available only while Vibe mode is active.",
      promptSnippet: "Control Vibe workers with spawn, send, wait, kill, and list operations.",
      promptGuidelines: [
         'Use vibe { op: "spawn", cli: "fast" | "good", prompt: "..." } to delegate work and retain the returned session handle.',
         'Use vibe { op: "wait", sessions: ["session-id"] } before depending on a worker result.',
         "Use vibe send mode steer to interrupt current work and followUp to queue instructions after the current turn.",
         "Use vibe kill only for an active returned session handle."
      ],
      parameters: VibeToolParamsSchema,
      renderCall: renderVibeCall,
      renderResult: renderVibeResult,
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
         try {
            await runTool(runtime, ensureParentSessionRecovery(ctx.sessionManager.getSessionFile?.()));
            const params = rawParams as VibeToolParams;
            if (params.op === "spawn") {
               const vibes = await runTool(
                  runtime,
                  AgentsStore.use((store) => store.getVibeProfiles())
               );
               const profile = vibes[params.cli] ?? vibes.fast;
               const harness = profile.harness ?? "pi";
               const activeProfile = harness === "pi" ? profile.pi : profile.agy;
               const blockedTools = new Set(["task", "vibe"]);
               const tools = [...(activeProfile?.tools ?? profile.tools ?? [])].filter(
                  (tool) => !blockedTools.has(tool)
               );
               for (const required of ["submit", "hub"]) {
                  if (!tools.includes(required)) tools.push(required);
               }
               const profileBody = activeProfile?.body ?? profile.body;
               const systemPrompt = profileBody?.trim() ? profileBody : ctx.getSystemPrompt();
               const job = await runTool(
                  runtime,
                  TaskManager.use((manager) =>
                     manager.spawnTask(
                        {
                           task: params.prompt,
                           name: params.name ?? `vibe-${params.cli}`,
                           model: activeProfile?.model,
                           thinking: activeProfile?.reasoning_effort,
                           tools,
                           harness,
                           systemPrompt
                        },
                        {
                           ownerSessionId: ctx.sessionManager.getSessionId?.() ?? "parent",
                           origin: "vibe",
                           parentSessionFile: ctx.sessionManager.getSessionFile?.()
                        }
                     )
                  ),
                  { signal, interruptMessage: "vibe spawn aborted" }
               );
               return asTextResult({ ok: true, id: job.id, title: job.name, harness, status: job.status });
            }

            if (params.op === "send") {
               await runTool(
                  runtime,
                  TaskManager.use((manager) =>
                     manager.controlJob(params.session, params.message, params.mode ?? "followUp")
                  ),
                  { signal, interruptMessage: "vibe send aborted" }
               );
               return asTextResult({ ok: true, session: params.session, delivered: true });
            }

            if (params.op === "wait") {
               const settled = await runTool(
                  runtime,
                  JobRegistry.use((registry) => registry.awaitSettlement(params.sessions ?? [], params.timeout)),
                  { signal, interruptMessage: "vibe wait aborted" }
               );
               return asTextResult({ ok: true, jobs: settled });
            }

            if (params.op === "kill") {
               const job = await runTool(
                  runtime,
                  TaskManager.use((manager) => manager.cancelJob(params.session)),
                  { signal, interruptMessage: "vibe kill aborted" }
               );
               return asTextResult({ ok: true, session: params.session, job });
            }

            const jobs = await runTool(
               runtime,
               JobRegistry.use((registry) => registry.list())
            );
            return asTextResult({ ok: true, jobs: jobs.filter((job) => job.origin === "vibe") });
         } catch (err) {
            return asErrorResult(err instanceof Error ? err.message : String(err));
         }
      }
   });
}

function registerParentCommands(pi: ExtensionAPI, runtime: HarborRuntime): void {
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
         const vibes = await runTool(
            runtime,
            AgentsStore.use((s) => s.getVibeProfiles(ctx.cwd))
         );
         const model = buildAgentsPanelViewModel({ agents, vibeProfiles: vibes });
         const lines = [
            "Harbor /agents",
            "",
            "Agents (including vibe profiles):",
            ...model.agents.map((a) => {
               const tag = a.kind === "vibe" ? " [vibe]" : a.source === "builtin" ? " [built-in]" : "";
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

   pi.registerCommand("vibe", {
      description: "Toggle Director / Vibe mode",
      handler: async (_args, ctx) => {
         const vibe = await runTool(runtime, VibeState);
         const message = handleVibeCommand(
            {
               getActiveTools: () => pi.getActiveTools(),
               setActiveTools: (tools) => pi.setActiveTools(tools),
               getAllTools: () => pi.getAllTools().map((t) => t.name),
               appendEntry: (type, data) => pi.appendEntry(type, data),
               getEntries: () => customEntries(ctx),
               setStatusWidget: (text) => {
                  if (!ctx.hasUI) return;
                  if (text) ctx.ui.setStatus?.("vibe", text);
                  else ctx.ui.setStatus?.("vibe", undefined);
               }
            },
            {
               isVibeActive: () => Effect.runSync(vibe.isVibeActive),
               setVibeActive: (active) => {
                  Effect.runSync(vibe.setVibeActive(active));
               },
               terminateVibeSessions: () => {
                  Effect.runSync(vibe.terminateVibeSessions);
               }
            }
         );
         if (ctx.hasUI) ctx.ui.notify(message, "info");
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

   const cutover = checkCutover({
      tools: cutoverItemsFromTools(pi),
      commands: cutoverItemsFromCommands(pi),
      settingsExtensions
   });

   // Worker tools always present (submit + restricted hub).
   registerWorkerTools(pi, runtime);

   if (!cutover.ok) {
      try {
         console.error(`[harbor] cutover failed: ${cutover.error}`);
      } catch {
         // ignore
      }
      // Still register session_start so we re-check and notify UI.
      pi.on("session_start", (_event: SessionStartEvent, ctx) => {
         if (ctx.hasUI) ctx.ui.notify(cutover.error, "error");
         // Worker-only surface for this session.
         const workerOnly = pi
            .getAllTools()
            .map((t) => t.name)
            .filter((name) => name === "submit" || name === "hub");
         try {
            pi.setActiveTools(workerOnly);
         } catch {
            // setActiveTools may be illegal during some load phases; session_start is OK.
         }
      });
      return { ok: false, error: cutover.error, cutoverOk: false };
   }

   const resultDelivery = createDeferredResultDelivery();
   const asyncWidget = makeAsyncTaskWidgetState(runtime);
   let parentContext: ExtensionContext | undefined;
   let unsubscribeSettled: (() => void) | undefined;

   const deliverResult = (job: Job) => {
      const output = job.errorText ?? job.resultData ?? "(no result returned)";
      pi.sendMessage(
         {
            customType: "harbor-result",
            content: `Task ${job.name ?? job.id} (${job.id}) ${job.status}.\n${modelFacingText(output)}`,
            display: true,
            details: { id: job.id, name: job.name, status: job.status }
         },
         { deliverAs: "steer", triggerTurn: true }
      );
   };
   const flushResults = () => {
      for (const job of resultDelivery.drain()) deliverResult(job);
   };
   const deliveryReady = runTool(
      runtime,
      JobRegistry.use((registry) =>
         registry.onSettled((job) => {
            if (job.async === true && parentContext) void asyncWidget.update(parentContext);
            if (job.async !== true || resultDelivery.shouldSuppress(job)) return;
            resultDelivery.defer({ ...job });
            if (parentContext && parentContext.isIdle()) flushResults();
         })
      )
   ).then((unsubscribe) => {
      unsubscribeSettled = unsubscribe;
   });

   // Parent tools + commands only when cutover passes.
   const delivery: ParentToolDelivery = {
      ready: deliveryReady,
      consume: (ids) => resultDelivery.consume(ids),
      notifyAsyncWidget: (ctx) => void asyncWidget.update(ctx)
   };
   registerParentTools(pi, runtime, delivery);
   registerParentCommands(pi, runtime);

   pi.registerMessageRenderer("harbor-result", (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as { id?: string; name?: string; status?: string };
      const failed = details.status === "failed" || details.status === "cancelled";
      const bgColor = failed ? "toolErrorBg" : "toolSuccessBg";
      const bgBadge = theme.fg("customMessageLabel", "[bg]");
      const title = theme.fg("toolTitle", theme.bold("task"));
      const name = theme.fg("accent", details.name ?? details.id ?? "task");
      const meta = theme.fg("muted", ` · ${details.id ?? "?"} · ${details.status ?? "completed"}`);
      const indicator = theme.fg(failed ? "error" : "success", failed ? "✗" : "✓");
      const header = `${bgBadge} ${title} ${name}${meta} ${indicator}`;

      const content = typeof message.content === "string" ? message.content : "";
      const body = content.split("\n").slice(1).join("\n").trim();
      const bodyLines = body.length > 0 ? body.split("\n") : [];
      const preview = expanded ? bodyLines : bodyLines.slice(0, 8);
      const hiddenCount = !expanded ? bodyLines.length - preview.length : 0;

      const lines = [header];
      if (bodyLines.length > 0) {
         lines.push(theme.fg("dim", "---"));
         for (const line of preview) lines.push(theme.fg("toolOutput", line));
      }
      if (hiddenCount > 0) {
         const lineWord = hiddenCount === 1 ? "line" : "lines";
         lines.push(
            theme.fg("muted", `... (${hiddenCount} more ${lineWord},`) +
               ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
         );
      }

      const box = new Box(1, 1, (text) => theme.bg(bgColor, text));
      box.addChild(new Text(lines.join("\n"), 0, 0));
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
         const workerOnly = pi
            .getAllTools()
            .map((t) => t.name)
            .filter((name) => name === "submit" || name === "hub");
         try {
            pi.setActiveTools(workerOnly);
         } catch {
            // ignore
         }
         return;
      }

      parentContext = ctx;

      // Reset per-parent result delivery and async widget state.
      resultDelivery.clear();
      asyncWidget.clear(parentContext);

      const parentSessionFile = ctx.sessionManager.getSessionFile?.();
      await runTool(runtime, activateParentSession(parentSessionFile)).catch((error: unknown) => {
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
      });

      void asyncWidget.update(ctx);
      void deliveryReady.then(() => {
         if (typeof ctx.isIdle === "function" && ctx.isIdle()) flushResults();
      });

      // Parent TUI/RPC: re-validate cutover at session start (re-read disk for live settings edits).
      const again = checkCutover({
         tools: cutoverItemsFromTools(pi),
         commands: cutoverItemsFromCommands(pi),
         settingsExtensions: options?.settingsExtensions ?? loadSettingsExtensionsFromDisk()
      });
      if (!again.ok) {
         if (ctx.hasUI) ctx.ui.notify(again.error, "error");
         const workerOnly = pi
            .getAllTools()
            .map((t) => t.name)
            .filter((name) => name === "submit" || name === "hub");
         try {
            pi.setActiveTools(workerOnly);
         } catch {
            // ignore
         }
         return;
      }

      // Refresh task tool metadata with the enabled agents for this cwd before the system prompt is built.
      const taskAugmentation = await resolveTaskToolAugmentation(runtime, ctx.cwd);
      pi.registerTool(createTaskToolDefinition(runtime, delivery, taskAugmentation));

      try {
         const normalTools = pi.getActiveTools().filter((name) => name !== "vibe" && !name.startsWith("vibe_"));
         pi.setActiveTools(normalTools);
      } catch {
         // session_start may run before active-tool mutation is available in some hosts.
      }
   });

   pi.on("agent_end", flushResults);
   pi.on("agent_settled", flushResults);

   pi.on("tool_call", async (event) => {
      try {
         const active = await runTool(
            runtime,
            VibeState.use((v) => v.isVibeActive)
         );
         if (active && !isDirectorTool(event.toolName)) {
            return {
               block: true,
               reason: `Tool '${event.toolName}' is disabled in Vibe Director mode.`
            };
         }
      } catch {
         // ignore
      }
      return undefined;
   });

   pi.on("session_shutdown", async () => {
      const shutdownContext = parentContext;
      asyncWidget.clear(parentContext);
      parentContext = undefined;
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
            TaskManager.use((s) => s.disposeAll)
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
