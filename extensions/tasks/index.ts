/**
 * Tasks — spawn background tasks on `pi` or `agy`
 * unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - task_spawn: fire-and-forget spawn (agent, prompt, name, working_dir). Max 4 running at once.
 * - task_spawn_batch: spawn multiple tasks with shared context.
 * - task_wait: block until the listed tasks settle, return results.
 * - task_cancel: stop one or more running tasks.
 * - task_check: peek at a task's status and recent activity.
 * - task_list: list all tasks.
 *
 * Unawaited tasks queue their result as a follow-up message when they
 * settle. `/tasks` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backend -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime.
 * - pi: in-process SDK sessions
 * - agy: headless Antigravity CLI print mode
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
   ExtensionAPI,
   ExtensionCommandContext,
   ExtensionContext,
   ExtensionUIContext
} from "@earendil-works/pi-coding-agent";
import {
   DEFAULT_MAX_BYTES,
   DEFAULT_MAX_LINES,
   formatSize,
   getAgentDir,
   getMarkdownTheme,
   ProjectTrustStore,
   truncateHead
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import { formatElapsed, latestText, type TaskSnapshot } from "./src/domain.ts";
import { formatActivityStatus, formatContextUtilization } from "./src/format.ts";
import { TaskManager, type TaskManagerShape } from "./src/manager.ts";
import {
   buildTaskResultMessage,
   buildTaskSpawnResult,
   TASK_CANCEL_PARAMETER_DESCRIPTIONS,
   TASK_CANCEL_TOOL_DESCRIPTION,
   TASK_CHECK_PARAMETER_DESCRIPTIONS,
   TASK_CHECK_TOOL_DESCRIPTION,
   TASK_LIST_TOOL_DESCRIPTION,
   TASK_SPAWN_BATCH_PARAMETER_DESCRIPTIONS,
   TASK_SPAWN_BATCH_PROMPT_GUIDELINES,
   TASK_SPAWN_BATCH_PROMPT_SNIPPET,
   TASK_SPAWN_BATCH_TOOL_DESCRIPTION,
   TASK_SPAWN_PARAMETER_DESCRIPTIONS,
   TASK_SPAWN_PROMPT_GUIDELINES,
   TASK_SPAWN_PROMPT_SNIPPET,
   TASK_SPAWN_TOOL_DESCRIPTION,
   TASK_WAIT_PARAMETER_DESCRIPTIONS,
   TASK_WAIT_TOOL_DESCRIPTION
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { createTaskRuntime, runTool, type TaskRuntime } from "./src/runtime.ts";
import { openTaskPicker, openTaskTakeover } from "./src/ui/takeover.ts";
import { loadAgentsConfig } from "./src/agents/store.ts";
import { resolveProfileSpawnParams } from "./src/agents/resolve.ts";
import { loadAgent, loadAllAgents, type ProfileName } from "./src/agents/types.ts";
import type { BackendName } from "./src/domain.ts";
import {
   getVibeActiveTools,
   getVibeSavedTools,
   isVibeEnabled,
   isVibeToolAllowed,
   resolveToolsAfterVibe,
   setVibeEnabled,
   snapshotToolsBeforeVibe,
   withoutVibeTools
} from "./src/vibe/state.ts";
import { VIBE_DIRECTOR_SYSTEM_PROMPT } from "./src/vibe/director.ts";
import { openAgentsConfigPanel } from "./src/ui/agents.ts";

const TASK_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface BtwResultData {
   readonly id: string;
   readonly title: string;
   readonly status: TaskSnapshot["status"];
   readonly errorText?: string;
   readonly prompt: string;
   readonly answer: string;
   readonly sessionFilePath?: string;
}

interface VibeWaitResultItem {
   readonly id: string;
   readonly title: string;
   readonly status: TaskSnapshot["status"] | "error";
   readonly errorText?: string;
   readonly output: string;
}

/** Host may be newer than workspace package types (0.80). */
type ExtensionAPIHost = ExtensionAPI & {
   // eslint-disable-next-line typescript/no-unnecessary-type-parameters
   registerEntryRenderer?: <T = unknown>(
      customType: string,
      renderer: (
         entry: { data?: T },
         options: { expanded: boolean },
         theme: Parameters<NonNullable<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>>[2]
      ) => unknown
   ) => void;
};

function describeTask(snap: TaskSnapshot) {
   const details = [
      `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
      formatContextUtilization(snap.usage),
      formatElapsed(snap),
      snap.cwd
   ].filter(Boolean);
   return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(snap: TaskSnapshot, maxBytes = TASK_OUTPUT_MAX_BYTES): string {
   const output = snap.finalText || "(no output)";
   const truncation = truncateHead(output, {
      maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
      maxLines: Math.min(600, DEFAULT_MAX_LINES)
   });
   let text = truncation.content;
   if (truncation.truncated) {
      text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
   }
   return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: { parentCwd: string; childCwd: string; parentTrusted: boolean }) {
   if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
      return options.parentTrusted;
   }
   try {
      const trustStore = new ProjectTrustStore(getAgentDir());
      return trustStore.get(options.childCwd) === true;
   } catch {
      return false;
   }
}

export default function (pi: ExtensionAPIHost) {
   let runtime: TaskRuntime | undefined;
   let managerPromise: Promise<TaskManagerShape> | undefined;
   let sessionContext: ExtensionContext | undefined;
   let ui: ExtensionUIContext | undefined;
   let unsubStatus: (() => void) | undefined;
   const resultDelivery = createDeferredResultDelivery<TaskSnapshot>();

   const getRuntime = () => (runtime ??= createTaskRuntime());

   /** Resolve the manager service once per runtime and wire the extension hooks. */
   const getManager = () => {
      managerPromise ??= getRuntime()
         .runPromise(TaskManager)
         .then((manager) => {
            manager.view.setOnSettled(onSettled);
            unsubStatus?.();
            unsubStatus = manager.view.subscribe(() => updateStatus(manager));
            updateStatus(manager);
            return manager;
         });
      return managerPromise;
   };

   const updateStatus = (manager: TaskManagerShape) => {
      if (!ui) return;
      const subs = manager.view.list();
      if (subs.length === 0) {
         ui.setStatus("tasks", undefined);
         return;
      }
      const running = subs.filter((snap) => snap.status === "running").length;
      const failed = subs.filter((snap) => snap.status === "error").length;
      const done = subs.length - running - failed;
      ui.setStatus("tasks", formatActivityStatus(ui.theme, { running, done, failed }));
   };

   const deliverResult = (snap: TaskSnapshot) => {
      pi.sendMessage(
         {
            customType: "task-result",
            content: buildTaskResultMessage({
               id: snap.id,
               title: snap.title,
               status: snap.status,
               errorText: snap.errorText,
               output: truncatedOutput(snap)
            }),
            display: true,
            details: { id: snap.id, title: snap.title, status: snap.status }
         },
         { deliverAs: "followUp", triggerTurn: true }
      );
   };

   const flushResults = () => {
      for (const snap of resultDelivery.drain()) deliverResult(snap);
   };

   const deliverBtwResult = (snap: TaskSnapshot) => {
      // appendEntry is a synchronous SessionManager operation and emits an
      // entry_appended event, so it is safe while the parent is streaming and
      // never enters the model's context or follow-up queue.
      pi.appendEntry<BtwResultData>("btw-result", {
         id: snap.id,
         title: snap.title,
         status: snap.status,
         errorText: snap.errorText,
         prompt: snap.prompt,
         answer: truncatedOutput(snap),
         sessionFilePath: snap.meta.sessionFilePath
      });
      ui?.notify(
         snap.status === "error"
            ? `by the way “${snap.title}” failed — reopen it with /tasks`
            : `by the way “${snap.title}” answered — reopen it with /tasks`,
         snap.status === "error" ? "error" : "info"
      );
   };

   const onSettled = (snap: TaskSnapshot, consumed: boolean) => {
      // A shutdown can settle children while disposing their scopes. Never
      // append into a session whose extension runtime is already closing.
      if (!sessionContext) return;
      if (snap.origin === "btw") {
         deliverBtwResult({ ...snap, meta: { ...snap.meta } });
         return;
      }
      if (consumed) {
         resultDelivery.consume([snap.id]);
         return;
      }
      // Keep the result retractable while the parent is working. A later
      // task_wait can consume it before agent_settled flushes follow-ups.
      // Defer a copy: the live snapshot keeps mutating if the task is
      // restarted before the deferred result flushes.
      resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
      if (sessionContext?.isIdle()) flushResults();
   };

   pi.on("session_start", (_event, ctx) => {
      sessionContext = ctx;
      if (ctx.hasUI) ui = ctx.ui;

      // registerTool auto-activates tools, but setActiveTools is illegal during
      // extension load. Apply vibe tool policy once the runtime is bound.
      if (isVibeEnabled()) {
         pi.setActiveTools(getVibeActiveTools(pi.getAllTools().map((t) => t.name)));
         if (ctx.hasUI) {
            ctx.ui.setStatus?.("vibe", ctx.ui.theme.fg("warning", "🎬 vibe"));
         }
      } else {
         pi.setActiveTools(withoutVibeTools(pi.getActiveTools()));
      }
   });

   // Prefer agent_settled when the host supports it (pi >= 0.81).
   // Workspace package types are 0.80 and only declare agent_end.
   if (typeof (pi as { on: (event: string, handler: () => void) => void }).on === "function") {
      try {
         (pi as { on: (event: string, handler: () => void) => void }).on("agent_settled", flushResults);
      } catch {
         // ignore
      }
   }
   pi.on("agent_end", flushResults);

   pi.on("session_shutdown", async () => {
      sessionContext = undefined;
      resultDelivery.clear();
      unsubStatus?.();
      unsubStatus = undefined;
      ui?.setStatus("tasks", undefined);
      ui = undefined;
      const closing = runtime;
      runtime = undefined;
      managerPromise = undefined;
      // Disposing the runtime runs the manager finalizer, which tears down all
      // task scopes (and, later, their real child processes).
      await closing?.dispose();
   });

   // --- Tools -------------------------------------------------------------

   async function spawnSingleTask(
      manager: TaskManagerShape,
      ctx: ExtensionContext,
      item: {
         agent: string;
         name: string;
         prompt: string;
         working_dir?: string;
      },
      contextPrefix?: string
   ) {
      const agentName = item.agent?.trim();
      if (!agentName) {
         const all = loadAllAgents(ctx.cwd);
         const enabled = Array.from(all.values()).filter((a) => Boolean(a.enabled));
         const availableList = enabled.length > 0 ? enabled.map((a) => a.name).join(", ") : "none";
         throw new Error(`Param 'agent' is required. Available enabled agents: ${availableList}`);
      }

      const titleStr = item.name?.trim();
      if (!titleStr) {
         throw new Error("Param 'name' is required and must be non-empty.");
      }

      const res = loadAgent(agentName, ctx.cwd);
      if (res.error || !res.definition) {
         throw new Error(res.error || `Agent "${agentName}" not found.`);
      }
      const def = res.definition;
      if (!def.enabled) {
         throw new Error(`Agent "${agentName}" is disabled.`);
      }
      if (!def.body || !def.body.trim()) {
         throw new Error(
            `Agent "${agentName}" has no system prompt body. Edit it in /agents and add instructions under the frontmatter.`
         );
      }

      const cwd = path.resolve(ctx.cwd, item.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
         throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const customPrompt = def.body;
      const tools = def.tools;
      const harness: BackendName = def.harness;
      const model = def.model;
      const reasoningEffort = def.thinking;

      const title = titleStr.slice(0, 160) || "task";
      const finalPrompt = contextPrefix?.trim() ? `${contextPrefix.trim()}\n\n${item.prompt}` : item.prompt;

      const snap = await runTool(
         getRuntime(),
         manager.spawn(harness, {
            agent: def.name,
            prompt: finalPrompt,
            title,
            cwd,
            model,
            reasoningEffort,
            customPrompt,
            tools,
            parent: {
               parentCwd: ctx.cwd,
               projectTrusted: resolveChildProjectTrust({
                  parentCwd: ctx.cwd,
                  childCwd: cwd,
                  parentTrusted: ctx.isProjectTrusted()
               }),
               inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
               inheritedThinkingLevel: pi.getThinkingLevel(),
               modelRegistry: ctx.modelRegistry
            }
         })
      );

      return { snap, harness, def, cwd };
   }

   pi.registerTool({
      name: "task_spawn",
      label: "Spawn Task",
      description: TASK_SPAWN_TOOL_DESCRIPTION,
      promptSnippet: TASK_SPAWN_PROMPT_SNIPPET,
      promptGuidelines: TASK_SPAWN_PROMPT_GUIDELINES,
      parameters: Type.Object({
         agent: Type.String({
            description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.agent
         }),
         prompt: Type.String({
            description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.prompt
         }),
         name: Type.String({
            description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.name
         }),
         working_dir: Type.Optional(
            Type.String({
               description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.workingDir
            })
         )
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
         const manager = await getManager();
         const { snap, harness, def, cwd } = await spawnSingleTask(manager, ctx, params);

         return {
            content: [
               {
                  type: "text",
                  text: buildTaskSpawnResult({
                     id: snap.id,
                     title: snap.title,
                     harness,
                     modelLabel: snap.meta.modelLabel ?? "?",
                     cwd
                  })
               }
            ],
            details: {
               id: snap.id,
               title: snap.title,
               agent: def.name,
               cwd,
               harness,
               model: snap.meta.modelLabel
            }
         };
      }
   });

   pi.registerTool({
      name: "task_spawn_batch",
      label: "Batch Spawn Tasks",
      description: TASK_SPAWN_BATCH_TOOL_DESCRIPTION,
      promptSnippet: TASK_SPAWN_BATCH_PROMPT_SNIPPET,
      promptGuidelines: TASK_SPAWN_BATCH_PROMPT_GUIDELINES,
      parameters: Type.Object({
         context: Type.Optional(
            Type.String({
               description: TASK_SPAWN_BATCH_PARAMETER_DESCRIPTIONS.context
            })
         ),
         tasks: Type.Array(
            Type.Object({
               agent: Type.String({ description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.agent }),
               name: Type.String({ description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.name }),
               prompt: Type.String({ description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.prompt }),
               working_dir: Type.Optional(Type.String({ description: TASK_SPAWN_PARAMETER_DESCRIPTIONS.workingDir }))
            }),
            { description: TASK_SPAWN_BATCH_PARAMETER_DESCRIPTIONS.tasks }
         )
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
         const manager = await getManager();
         const running = manager.view.list().filter((s) => s.status === "running").length;
         if (running + params.tasks.length > 4) {
            throw new Error(
               `Max 4 tasks can run concurrently. Cannot spawn batch of ${params.tasks.length} tasks (${running} currently running).`
            );
         }

         const spawned: Array<{ id: string; title: string; agent: string }> = [];
         const lines: string[] = [];

         for (const item of params.tasks) {
            // eslint-disable-next-line no-await-in-loop
            const { snap, def } = await spawnSingleTask(manager, ctx, item, params.context);
            spawned.push({ id: snap.id, title: snap.title, agent: def.name });
            lines.push(`Spawned ${snap.id} "${snap.title}" (${def.name})`);
         }

         return {
            content: [{ type: "text", text: `Batch spawned ${spawned.length} task(s):\n` + lines.join("\n") }],
            details: { spawned }
         };
      }
   });

   pi.registerTool({
      name: "task_wait",
      label: "Wait for Tasks",
      description: TASK_WAIT_TOOL_DESCRIPTION,
      parameters: Type.Object({
         ids: Type.Array(Type.String(), {
            maxItems: 64,
            description: TASK_WAIT_PARAMETER_DESCRIPTIONS.ids
         })
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
         const manager = await getManager();
         const ids = [...new Set(params.ids)];
         if (ids.length === 0) throw new Error("Provide at least one task id.");
         const known = manager.view
            .list()
            .filter(isModelVisible)
            .map((snap) => snap.id);
         const unknown = ids.filter((id) => {
            const snap = manager.view.get(id);
            return !snap || !isModelVisible(snap);
         });
         if (unknown.length > 0) {
            throw new Error(`Unknown task id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`);
         }

         await runTool(
            getRuntime(),
            manager.waitFor(ids, (pending) => {
               onUpdate?.({
                  content: [{ type: "text", text: `Waiting for ${pending.join(", ")}...` }],
                  details: { pending }
               });
            }),
            { signal, interruptMessage: "Wait aborted. Tasks keep running." }
         );

         // Settlement may have happened before this wait began. Remove any
         // deferred automatic delivery now that the tool is returning the result.
         resultDelivery.consume(ids);

         const sections: string[] = [];
         let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
         for (const id of ids) {
            const snap = manager.view.get(id);
            if (!snap) {
               sections.push(`## ${id}\n\n(no longer tracked)`);
               continue;
            }
            const verb = snap.status === "error" ? "failed" : "finished";
            let section = `## ${snap.id} "${snap.title}" ${verb}`;
            if (snap.errorText) section += `\nError: ${snap.errorText}`;
            const headerBytes = Buffer.byteLength(section, "utf8") + 2;
            const outputBudget = Math.max(512, Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes));
            section += `\n\n${truncatedOutput(snap, outputBudget)}`;
            const sectionBytes = Buffer.byteLength(section, "utf8");
            if (sectionBytes > remainingBytes) {
               sections.push(`## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`);
               break;
            }
            sections.push(section);
            remainingBytes -= sectionBytes;
         }

         const combined = sections.join("\n\n---\n\n");
         const bounded = truncateHead(combined, {
            maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
            maxLines: DEFAULT_MAX_LINES
         });
         const text = bounded.truncated
            ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
            : bounded.content;
         return {
            content: [{ type: "text", text }],
            details: {
               results: ids.map((id) => {
                  const snap = manager.view.get(id);
                  return { id, title: snap?.title, status: snap?.status };
               })
            }
         };
      }
   });

   pi.registerTool({
      name: "task_cancel",
      label: "Cancel Tasks",
      description: TASK_CANCEL_TOOL_DESCRIPTION,
      parameters: Type.Object({
         ids: Type.Array(Type.String(), {
            description: TASK_CANCEL_PARAMETER_DESCRIPTIONS.ids
         })
      }),
      async execute(_toolCallId, params) {
         const manager = await getManager();
         const ids = [...new Set(params.ids)];
         if (ids.length === 0) throw new Error("Provide at least one task id.");

         const known = manager.view
            .list()
            .filter(isModelVisible)
            .map((snap) => snap.id);
         const unknown = ids.filter((id) => {
            const snap = manager.view.get(id);
            return !snap || !isModelVisible(snap);
         });
         if (unknown.length > 0) {
            throw new Error(`Unknown task id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`);
         }

         const report = await runTool(getRuntime(), manager.cancel(ids));

         const lines = report.map((entry) =>
            entry.cancelled
               ? `Cancelled ${entry.id} "${entry.title}".`
               : `${entry.id} "${entry.title}" was already ${entry.status}.`
         );

         return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
               results: report.map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  status: entry.status
               }))
            }
         };
      }
   });

   pi.registerTool({
      name: "task_check",
      label: "Check Task",
      description: TASK_CHECK_TOOL_DESCRIPTION,
      parameters: Type.Object({
         id: Type.String({
            description: TASK_CHECK_PARAMETER_DESCRIPTIONS.id
         })
      }),
      async execute(_toolCallId, params) {
         const manager = await getManager();
         const snap = manager.view.get(params.id);
         if (!snap || !isModelVisible(snap)) {
            const known = manager.view
               .list()
               .filter(isModelVisible)
               .map((s) => s.id);
            throw new Error(`Unknown task id "${params.id}". Known: ${known.join(", ") || "none"}.`);
         }

         let text = `${describeTask(snap)}\nTurns: ${snap.turns}`;
         if (snap.errorText) text += `\nError: ${snap.errorText}`;

         const output = latestText(snap);
         if (output) {
            const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
            text += `\n\nLatest output:\n${preview.content}`;
            if (preview.truncated) text += "\n[...]";
         } else if (snap.status === "running") {
            text += "\n\n(no text output yet)";
         }

         return {
            content: [{ type: "text", text }],
            details: { id: snap.id, status: snap.status, turns: snap.turns }
         };
      }
   });

   pi.registerTool({
      name: "task_list",
      label: "List Tasks",
      description: TASK_LIST_TOOL_DESCRIPTION,
      parameters: Type.Object({}),
      async execute() {
         const manager = await getManager();
         const subs = manager.view.list().filter(isModelVisible);
         const text = subs.length === 0 ? "No tasks." : subs.map((snap) => describeTask(snap)).join("\n");
         return {
            content: [{ type: "text", text }],
            details: {
               tasks: subs.map((snap) => ({
                  id: snap.id,
                  title: snap.title,
                  harness: snap.backend,
                  status: snap.status
               }))
            }
         };
      }
   });

   // --- Result message rendering ------------------------------------------

   pi.registerMessageRenderer("task-result", (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
         id?: string;
         title?: string;
         status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
         `${icon} ` +
         theme.fg("accent", theme.bold(`task ${details.id ?? "?"}`)) +
         theme.fg("muted", ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`);

      const content = typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
         const md = new Markdown(body, 0, 0, getMarkdownTheme());
         const container = new Text(header, 0, 0);
         return {
            render: (width: number) => [...container.render(width), ...md.render(width)],
            invalidate: () => {
               container.invalidate();
               md.invalidate();
            }
         };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines) text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8) text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
   });

   pi.registerEntryRenderer?.<BtwResultData>("btw-result", (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
         `${icon} ` +
         theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
         theme.fg("muted", ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`);
      const body = [data?.errorText ? `Error: ${data.errorText}` : "", data?.answer ?? "(no answer)"]
         .filter(Boolean)
         .join("\n\n");

      if (expanded) {
         const md = new Markdown(body, 0, 0, getMarkdownTheme());
         const container = new Text(header, 0, 0);
         return {
            render: (width: number) => [...container.render(width), ...md.render(width)],
            invalidate: () => {
               container.invalidate();
               md.invalidate();
            }
         };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8)) text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8) text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
   });

   // --- Commands -----------------------------------------------------------

   const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
         if (ctx.hasUI) ctx.ui.notify("by the way is only available in the TUI", "error");
         return;
      }

      let prompt = rawArgs.trim();
      if (!prompt) {
         const input = await ctx.ui.input("by the way", "Ask a one-off question…");
         prompt = input?.trim() ?? "";
         if (!prompt) return;
      }

      const manager = await getManager();
      let snap: TaskSnapshot;
      try {
         snap = await runTool(
            getRuntime(),
            manager.spawn("pi", {
               origin: "btw",
               prompt,
               title: deriveBtwTitle(prompt),
               cwd: ctx.cwd,
               parent: {
                  parentCwd: ctx.cwd,
                  projectTrusted: ctx.isProjectTrusted(),
                  inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                  inheritedThinkingLevel: pi.getThinkingLevel(),
                  modelRegistry: ctx.modelRegistry
               }
            })
         );
      } catch (error) {
         ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
         return;
      }

      await openTaskTakeover(ctx, manager.view, snap.id, {
         badge: "by the way"
      });
   };

   pi.registerCommand("btw", {
      description: "Ask a one-off side question while the main agent keeps working",
      handler: runByTheWay
   });

   pi.registerCommand("tasks", {
      description: "List, inspect, and take over tasks",
      handler: async (_args, ctx) => {
         if (ctx.mode !== "tui") {
            if (ctx.hasUI) ctx.ui.notify("Task takeover is only available in the TUI", "error");
            return;
         }
         const manager = await getManager();
         if (manager.view.size() === 0) {
            ctx.ui.notify("No tasks yet. The agent spawns them with task_spawn.", "info");
            return;
         }
         await openTaskPicker(ctx, manager.view);
      }
   });

   // --- /agents command ----------------------------------------------------

   pi.registerCommand("agents", {
      description: "Configure agent profiles (fast/good)",
      handler: async (_args, ctx) => {
         if (ctx.mode !== "tui") {
            if (ctx.hasUI) ctx.ui.notify("/agents panel is only available in TUI mode", "error");
            return;
         }
         await openAgentsConfigPanel(ctx, {
            getAllTools: () =>
               pi.getAllTools().map((t) => ({
                  name: t.name,
                  description: t.description,
                  source: t.sourceInfo?.source
               }))
         });
      }
   });

   // --- /vibe command -----------------------------------------------------
   // Real director mode: lock active tools + inject director system prompt.
   // Prompt-only was broken; model still saw full tool surface.

   function enableVibeMode(ctx: ExtensionCommandContext | ExtensionContext) {
      // Snapshot once. If the active set is already director-only (e.g. re-enter
      // after a bad restore, or another extension already locked tools), save the
      // full registered set instead so /vibe off can never restore a locked surface.
      if (getVibeSavedTools() === undefined) {
         const registered = pi.getAllTools().map((t) => t.name);
         setVibeEnabled(true, snapshotToolsBeforeVibe(pi.getActiveTools(), registered));
      } else {
         setVibeEnabled(true);
      }
      const activeDirectorTools = getVibeActiveTools(pi.getAllTools().map((t) => t.name));
      pi.setActiveTools(activeDirectorTools);
      if ("ui" in ctx && ctx.hasUI) {
         ctx.ui.setStatus?.("vibe", ctx.ui.theme.fg("warning", "🎬 vibe"));
         ctx.ui.notify(`Vibe mode ON. Director tools only: ${activeDirectorTools.join(", ")}.`, "info");
      }
   }

   async function disableVibeMode(ctx: ExtensionCommandContext | ExtensionContext) {
      const saved = getVibeSavedTools();
      const registered = pi.getAllTools().map((t) => t.name);
      const restored = resolveToolsAfterVibe(saved, registered);
      setVibeEnabled(false);
      pi.setActiveTools(restored);

      // Best effort: kill vibe/task workers when leaving director mode.
      try {
         const manager = await getManager();
         const ids = manager.view.list().map((s) => s.id);
         if (ids.length > 0) {
            await runTool(getRuntime(), manager.cancel(ids));
         }
      } catch {
         // ignore teardown races
      }

      if ("ui" in ctx && ctx.hasUI) {
         ctx.ui.setStatus?.("vibe", undefined);
         ctx.ui.notify(`Vibe mode OFF. Restored ${restored.length} tools.`, "warning");
      }
   }

   pi.registerCommand("vibe", {
      description: "Toggle Director / Vibe mode (locks tools to director toolset)",
      handler: async (_args, ctx) => {
         if (isVibeEnabled()) {
            await disableVibeMode(ctx);
         } else {
            enableVibeMode(ctx);
         }
      }
   });

   // Enforce director tool allowlist even if something re-enables tools.
   pi.on("tool_call", async (event) => {
      if (!isVibeEnabled() || isVibeToolAllowed(event.toolName)) return undefined;
      const allowedList = getVibeActiveTools(pi.getAllTools().map((t) => t.name)).join(", ");
      return {
         block: true,
         reason: `Vibe/director mode: tool "${event.toolName}" is blocked. Allowed: ${allowedList}. Use /vibe to exit.`
      };
   });

   // Inject director system prompt every turn while vibe is on.
   pi.on("before_agent_start", async (event) => {
      if (!isVibeEnabled()) return undefined;
      // Keep tool lock applied in case another extension changed active tools.
      pi.setActiveTools(getVibeActiveTools(pi.getAllTools().map((t) => t.name)));
      return {
         systemPrompt: `${event.systemPrompt}\n\n${VIBE_DIRECTOR_SYSTEM_PROMPT}`
      };
   });

   // --- Vibe Tools --------------------------------------------------------

   pi.registerTool({
      name: "vibe_spawn",
      label: "Vibe Spawn",
      description: "Spawn a task using a named profile (fast or good) for vibe/director mode.",
      parameters: Type.Object({
         cli: StringEnum(["fast", "good"] as const, {
            description: 'Profile name: "fast" or "good"'
         }),
         prompt: Type.String({ description: "Self-contained task prompt" }),
         name: Type.Optional(Type.String({ description: "Short descriptive title" }))
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
         const config = loadAgentsConfig();
         const profile = config.profiles[params.cli as ProfileName] ?? config.profiles.fast;
         const resolved = resolveProfileSpawnParams(profile);

         const manager = await getManager();
         const cwd = ctx.cwd;
         const title = (params.name?.trim() || `vibe-${params.cli}`).slice(0, 160);

         const snap = await runTool(
            getRuntime(),
            manager.spawn(resolved.harness, {
               prompt: params.prompt,
               title,
               cwd,
               model: resolved.model,
               reasoningEffort: resolved.reasoningEffort,
               tools: resolved.tools,
               customPrompt: resolved.body,
               parent: {
                  parentCwd: ctx.cwd,
                  projectTrusted: ctx.isProjectTrusted(),
                  inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
                  inheritedThinkingLevel: pi.getThinkingLevel(),
                  modelRegistry: ctx.modelRegistry
               }
            })
         );

         return {
            content: [
               {
                  type: "text",
                  text:
                     `Vibe spawned task ${snap.id} "${snap.title}" (${resolved.harness}).\n` +
                     `Wait for the completion message. Reply to the user with a short status and STOP`
               }
            ],
            details: { id: snap.id, title: snap.title, harness: resolved.harness }
         };
      }
   });

   pi.registerTool({
      name: "vibe_send",
      label: "Vibe Send",
      description:
         "Send a follow-up message to a running or finished tracked task session (restarts a new turn when settled).",
      parameters: Type.Object({
         session: Type.String({ description: "Task session ID (e.g. task-1)" }),
         message: Type.String({ description: "Message text to send" })
      }),
      async execute(_toolCallId, params) {
         const manager = await getManager();
         await runTool(getRuntime(), manager.send(params.session, params.message));
         return {
            content: [
               {
                  type: "text",
                  text:
                     `Sent message to task ${params.session}.\n` +
                     `Wait for the completion message. Reply to the user with a short status and STOP`
               }
            ],
            details: { id: params.session }
         };
      }
   });

   pi.registerTool({
      name: "vibe_wait",
      label: "Vibe Wait",
      description:
         "Wait for specified tasks or all active tasks to settle. UI collapses like task results (ctrl+o to expand).",
      parameters: Type.Object({
         sessions: Type.Optional(
            Type.Array(Type.String(), {
               description: "Task session IDs to wait for"
            })
         ),
         timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" }))
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
         const manager = await getManager();
         let ids = params.sessions && params.sessions.length > 0 ? params.sessions : [];
         if (ids.length === 0) {
            ids = manager.view
               .list()
               .filter((s) => s.status === "running")
               .map((s) => s.id);
         }
         if (ids.length === 0) {
            return {
               content: [{ type: "text", text: "No active tasks to wait for." }],
               details: { results: [] as VibeWaitResultItem[] }
            };
         }

         await runTool(
            getRuntime(),
            manager.waitFor(ids, (pending) => {
               onUpdate?.({
                  content: [
                     {
                        type: "text",
                        text: `Vibe waiting for ${pending.join(", ")}...`
                     }
                  ],
                  details: { pending, results: [] as VibeWaitResultItem[] }
               });
            }),
            { signal, interruptMessage: "Vibe wait aborted." }
         );

         // Same shape as task_wait / task-result: model gets full text,
         // UI renders a collapsible summary from details.results.
         const results: VibeWaitResultItem[] = ids.map((id) => {
            const snap = manager.view.get(id);
            if (!snap) {
               return {
                  id,
                  title: "",
                  status: "error",
                  errorText: "no longer tracked",
                  output: ""
               };
            }
            return {
               id: snap.id,
               title: snap.title,
               status: snap.status,
               errorText: snap.errorText,
               output: truncatedOutput(snap)
            };
         });

         const modelText = results
            .map((r) => {
               const verb = r.status === "error" ? "failed" : "finished";
               let section = `## ${r.id} "${r.title}" ${verb}`;
               if (r.errorText) section += `\nError: ${r.errorText}`;
               if (r.output) section += `\n\n${r.output}`;
               return section;
            })
            .join("\n\n---\n\n");

         return {
            content: [{ type: "text", text: modelText }],
            details: { results }
         };
      },
      renderCall(args, theme) {
         const sessions = Array.isArray(args.sessions) ? (args.sessions as string[]) : [];
         const target = sessions.length > 0 ? sessions.join(", ") : "all running workers";
         return new Text(theme.fg("toolTitle", theme.bold("vibe_wait")) + theme.fg("muted", ` ${target}`), 0, 0);
      },
      renderResult(result, { expanded, isPartial }, theme) {
         const details = (result.details ?? {}) as {
            pending?: string[];
            results?: VibeWaitResultItem[];
         };

         if (isPartial && details.pending && details.pending.length > 0) {
            return new Text(
               theme.fg("warning", "…") + theme.fg("muted", ` waiting ${details.pending.join(", ")}`),
               0,
               0
            );
         }

         const results = details.results ?? [];
         if (results.length === 0) {
            const text =
               typeof result.content === "string"
                  ? result.content
                  : Array.isArray(result.content)
                    ? result.content
                         .map((c) =>
                            c && typeof c === "object" && "text" in c ? String((c as { text?: string }).text ?? "") : ""
                         )
                         .join("\n")
                    : "No results.";
            return new Text(theme.fg("muted", text.trim() || "No results."), 0, 0);
         }

         const failed = results.filter((r) => r.status === "error").length;
         const done = results.length - failed;
         const header = theme.fg(
            "muted",
            `${results.length} worker${results.length === 1 ? "" : "s"}` +
               (done > 0 ? ` · ${done} done` : "") +
               (failed > 0 ? ` · ${failed} failed` : "")
         );

         if (expanded) {
            const body = results
               .map((r) => {
                  const icon = r.status === "error" ? theme.fg("error", "x") : theme.fg("success", "■");
                  const title =
                     `${icon} ` +
                     theme.fg("accent", theme.bold(r.id)) +
                     theme.fg("muted", ` · ${r.title || "?"} · ${r.status === "error" ? "failed" : "finished"}`);
                  const chunks = [title];
                  if (r.errorText) chunks.push(`Error: ${r.errorText}`);
                  if (r.output) chunks.push(r.output);
                  return chunks.join("\n");
               })
               .join("\n\n---\n\n");
            const md = new Markdown(body, 0, 0, getMarkdownTheme());
            const container = new Text(header, 0, 0);
            return {
               render: (width: number) => [...container.render(width), ...md.render(width)],
               invalidate: () => {
                  container.invalidate();
                  md.invalidate();
               }
            };
         }

         // Collapsed: one summary line per worker + short preview (like task-result).
         let text = header;
         for (const r of results) {
            const icon = r.status === "error" ? theme.fg("error", "x") : theme.fg("success", "■");
            text +=
               `\n${icon} ` +
               theme.fg("accent", r.id) +
               theme.fg("muted", ` · ${r.title || "?"} · ${r.status === "error" ? "failed" : "finished"}`);

            const previewSource = r.errorText ? `Error: ${r.errorText}` : (r.output ?? "");
            const previewLines = previewSource
               .split("\n")
               .filter((line) => line.trim())
               .slice(0, 3);
            for (const line of previewLines) {
               text += `\n${theme.fg("toolOutput", line)}`;
            }
            if (previewSource.split("\n").filter((l) => l.trim()).length > 3) {
               text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
            }
         }
         if (results.some((r) => (r.output ?? "").split("\n").length > 3)) {
            // ensure at least one expand hint if any body is long
         } else if (results.length > 0) {
            const anyBody = results.some((r) => (r.output ?? r.errorText ?? "").trim().length > 0);
            if (anyBody) {
               text += `\n${theme.fg("dim", "ctrl+o to expand")}`;
            }
         }
         return new Text(text, 0, 0);
      }
   });

   pi.registerTool({
      name: "vibe_kill",
      label: "Vibe Kill",
      description: "Cancel/kill a specific task session.",
      parameters: Type.Object({
         session: Type.String({ description: "Task session ID to kill" })
      }),
      async execute(_toolCallId, params) {
         const manager = await getManager();
         const report = await runTool(getRuntime(), manager.cancel([params.session]));
         return {
            content: [{ type: "text", text: `Killed task ${params.session}` }],
            details: { report }
         };
      }
   });

   pi.registerTool({
      name: "vibe_list",
      label: "Vibe List",
      description: "List all tracked tasks and their current status.",
      parameters: Type.Object({}),
      async execute() {
         const manager = await getManager();
         const subs = manager.view.list();
         const text = subs.length === 0 ? "No active or tracked tasks." : subs.map((s) => describeTask(s)).join("\n");
         return {
            content: [{ type: "text", text }],
            details: {
               tasks: subs.map((s) => ({
                  id: s.id,
                  title: s.title,
                  status: s.status,
                  backend: s.backend
               }))
            }
         };
      }
   });
}
