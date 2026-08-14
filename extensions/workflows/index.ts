/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { agent?, label?, phase?, schema? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
   getAgentDir,
   getMarkdownTheme,
   keyHint,
   type AgentSession,
   type ExtensionAPI,
   type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { listAgentProfiles, resolveAgentProfile } from "../shared/agent-profiles.ts";
import { formatActivityStatus } from "./activity-status.ts";
import { createWorkflowPersistence, persistWorkflowJson, recoverWorkflowDetails } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import { extractMeta, prepareWorkflowScript, type WorkflowMeta } from "./meta.ts";
import { openAgentsPanel } from "./agents-panel.ts";
import {
   agentContext,
   aggregateUsage,
   countStates,
   emptyUsage,
   formatAgentModel,
   formatElapsed,
   formatUsage,
   phaseGroups,
   resultJson,
   stateSquare,
   statusColor,
   statusWord,
   SQUARE,
   type AgentRecord,
   type WorkflowDetails
} from "./model.ts";
import {
   buildBackgroundWorkflowFollowUp,
   buildBackgroundWorkflowLaunchResult,
   buildWorkflowResultMessage,
   WORKFLOW_PARAMETER_DESCRIPTIONS,
   WORKFLOW_PROMPT_GUIDELINES,
   WORKFLOW_PROMPT_SNIPPET,
   WORKFLOW_TOOL_DESCRIPTION
} from "./prompt.ts";
import { createWorkflowResources, runAgent } from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "../shared/serialization.ts";

export const WORKFLOW_TOOL_EMIT_INTERVAL_MS = 500;
const PREVIEW_LENGTH = 200;

function formatCleanSections(sections: string[][], theme: ExtensionContext["ui"]["theme"], width = 60): string {
   const divider = theme.fg("muted", "─".repeat(width));
   const lines: string[] = [];
   const validSections = sections.filter((s) => s.length > 0);
   for (let i = 0; i < validSections.length; i++) {
      if (i > 0) lines.push(divider);
      for (const line of validSections[i]) {
         lines.push(line);
      }
   }
   return lines.join("\n");
}

function statusBadge(status: WorkflowDetails["status"], theme: ExtensionContext["ui"]["theme"]): string {
   if (status === "completed") return theme.fg("success", "✓ DONE");
   if (status === "running") return theme.fg("warning", "● RUNNING");
   if (status === "aborted") return theme.fg("error", "✗ ABORTED");
   return theme.fg("error", "✗ FAILED");
}

function agentBadge(state: AgentRecord["state"], theme: ExtensionContext["ui"]["theme"]): string {
   if (state === "done") return theme.fg("success", "✓");
   if (state === "error") return theme.fg("error", "✗");
   return theme.fg("warning", "●");
}

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
   ok: boolean;
   output: string;
   structured?: unknown;
   error?: string;
}

interface AgentCallOptions {
   agent?: unknown;
   label?: unknown;
   phase?: unknown;
   schema?: unknown;
}

const WorkflowParams = Type.Object({
   script: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.script
   }),
   args: Type.Optional(
      Type.String({
         description: WORKFLOW_PARAMETER_DESCRIPTIONS.args
      })
   ),
   background: Type.Optional(
      Type.Boolean({
         description: WORKFLOW_PARAMETER_DESCRIPTIONS.background
      })
   )
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
   return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

function summaryLine(details: WorkflowDetails): string {
   const { done, failed } = countStates(details);
   const settled = done + failed;
   return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
      details.currentPhase ? ` · ${details.currentPhase}` : ""
   }`;
}

export function workflowProgressUpdate(details: WorkflowDetails) {
   return {
      content: [{ type: "text" as const, text: summaryLine(details) }],
      details: compactToolDetails(details)
   };
}

function writeRunFile(runDir: string, name: string, content: string) {
   writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
   return {
      ...details,
      ...(details.result !== undefined
         ? {
              result: JSON.parse(safeStringify(details.result, { maxBytes: 64 * 1024 }))
           }
         : {}),
      agents: details.agents.map((agent) => ({ ...agent, transcript: [] }))
   };
}

interface RunSummary {
   runId: string;
   name?: string;
   status: string;
   done: number;
   total: number;
   startedAt: number;
   active: boolean;
}

function loadPersistedWorkflowDetails(runId: string): WorkflowDetails | undefined {
   const runDir = path.join(getAgentDir(), "workflows", runId);
   try {
      const details = JSON.parse(fs.readFileSync(path.join(runDir, "workflow.json"), "utf8")) as WorkflowDetails;
      if (typeof details.resultArtifact === "string") {
         try {
            details.result = JSON.parse(
               fs.readFileSync(path.join(runDir, path.basename(details.resultArtifact)), "utf8")
            );
         } catch {
            // Keep the compact compatibility marker when the result artifact is unavailable.
         }
      }
      const recovered = recoverWorkflowDetails(details);
      if (recovered !== details) {
         try {
            persistWorkflowJson(runDir, recovered);
         } catch {
            // The fallback view can still display the recovered in-memory details.
         }
      }
      return recovered;
   } catch {
      return undefined;
   }
}

function listRuns(
   activeRuns: Map<string, WorkflowDetails>,
   sessionId: string,
   referencedRunIds: ReadonlySet<string>
): RunSummary[] {
   const base = path.join(getAgentDir(), "workflows");
   let names: string[] = [];
   try {
      names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
   } catch {
      // No runs yet.
   }
   const summaries: RunSummary[] = [];
   for (const runId of names) {
      const live = activeRuns.get(runId);
      if (live) {
         const { done, failed } = countStates(live);
         summaries.push({
            runId,
            name: live.name,
            status: live.status,
            done: done + failed,
            total: live.agents.length,
            startedAt: live.startedAt,
            active: true
         });
         continue;
      }
      const parsed = loadPersistedWorkflowDetails(runId);
      if (!parsed || (parsed.sessionId !== sessionId && !referencedRunIds.has(runId))) continue;
      const { done, failed } = countStates(parsed);
      summaries.push({
         runId,
         name: parsed.name,
         status: parsed.status,
         done: done + failed,
         total: parsed.agents.length,
         startedAt: parsed.startedAt,
         active: false
      });
   }
   // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target does not provide Array.prototype.toSorted.
   return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(run: RunSummary, activeRuns: Map<string, WorkflowDetails>): string {
   const runDir = path.join(getAgentDir(), "workflows", run.runId);
   const live = activeRuns.get(run.runId);
   if (live) return buildWorkflowResultMessage(live, runDir);
   const parsed = loadPersistedWorkflowDetails(run.runId);
   return parsed ? buildWorkflowResultMessage(parsed, runDir) : `Run ${run.runId} — ${run.status}`;
}

export default function workflows(pi: ExtensionAPI) {
   /** Live background runs, for /workflows and shutdown cleanup. */
   const activeRuns = new Map<
      string,
      {
         details: WorkflowDetails;
         controller: RunController;
         completion?: Promise<void>;
         childSessions?: Map<number, AgentSession>;
         abortControllers?: Map<number, AbortController>;
      }
   >();
   const activeDetails = () => new Map([...activeRuns].map(([runId, run]) => [runId, run.details] as const));

   /** Finished counts remain visible until the dashboard acknowledges them. */
   let lastUi: ExtensionContext["ui"] | undefined;
   let completedRuns = 0;
   let failedRuns = 0;
   const updateIndicator = () => {
      const ui = lastUi;
      if (!ui) return;
      try {
         const running = activeRuns.size;
         if (running === 0 && completedRuns === 0 && failedRuns === 0) {
            ui.setStatus("workflows", undefined);
            return;
         }
         ui.setStatus(
            "workflows",
            formatActivityStatus(ui.theme, "workflows", {
               running,
               done: completedRuns,
               failed: failedRuns
            })
         );
      } catch {
         // UI may be unavailable.
      }
   };

   const recordSettledRun = (status: WorkflowDetails["status"]) => {
      if (status === "completed") completedRuns += 1;
      else failedRuns += 1;
   };

   pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();
   });

   pi.on("session_shutdown", async () => {
      const runs = [...activeRuns.values()];
      for (const run of runs) run.controller.abort("Session is shutting down");
      await Promise.all(runs.map((run) => run.controller.settle({ abort: true })));
      const completions = runs
         .map((run) => run.completion)
         .filter((completion): completion is Promise<void> => completion !== undefined);
      if (completions.length > 0) {
         let timer: ReturnType<typeof setTimeout> | undefined;
         const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 8_000);
            timer.unref?.();
         });
         await Promise.race([Promise.allSettled(completions), timeout]);
         if (timer) clearTimeout(timer);
      }
      lastUi?.setStatus("workflows", undefined);
      lastUi = undefined;
   });

   pi.registerCommand("agents", {
      description: "Open the workflow agent profile editor",
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
                  }))
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

   pi.registerCommand("workflows", {
      description: "List workflow runs (`/workflows <runId>` for one run's detail)",
      handler: async (rawArgs, ctx) => {
         const arg = rawArgs.trim();
         const getActiveAgentSession = (runId: string, agentIndex: number): AgentSession | undefined => {
            return activeRuns.get(runId)?.childSessions?.get(agentIndex);
         };
         const abortActiveAgent = (runId: string, agentIndex: number): boolean => {
            const controller = activeRuns.get(runId)?.abortControllers?.get(agentIndex);
            if (controller) {
               controller.abort(new Error("aborted by user (ignore this subagent output; do not re-run workflow)"));
               return true;
            }
            return false;
         };

         const getAvailableModels = (): string[] => {
            const models: string[] = [];
            if (ctx.modelRegistry) {
               try {
                  const registered = (ctx.modelRegistry.getAvailable?.() ?? []) as any[];
                  for (const m of registered) {
                     if (typeof m === "string") {
                        if (!models.includes(m)) models.push(m);
                     } else if (m && typeof m === "object") {
                        const provider = m.provider ?? m.providerId;
                        const id = m.id ?? m.name;
                        if (provider && id) {
                           const fullId = String(id).startsWith(`${provider}/`) ? String(id) : `${provider}/${id}`;
                           if (!models.includes(fullId)) models.push(fullId);
                        } else if (id) {
                           const strId = String(id);
                           if (!models.includes(strId)) models.push(strId);
                        }
                     }
                  }
               } catch {}
            }
            return models;
         };

         if (ctx.mode === "tui") {
            lastUi = ctx.ui;
            await showWorkflowDashboard(
               ctx,
               activeDetails,
               arg || undefined,
               getActiveAgentSession,
               abortActiveAgent,
               getAvailableModels
            );
            // Opening the dashboard acknowledges finished runs.
            completedRuns = 0;
            failedRuns = 0;
            updateIndicator();
            return;
         }
         // Non-TUI fallback: plain text listing.
         const runs = listRuns(activeDetails(), ctx.sessionManager.getSessionId(), sessionWorkflowRunIds(ctx));
         if (runs.length === 0) {
            ctx.ui.notify("No workflow runs yet.", "info");
            return;
         }
         if (arg) {
            const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
            ctx.ui.notify(
               run ? runDetailText(run, activeDetails()) : `No workflow run matching "${arg}".`,
               run ? "info" : "warning"
            );
            return;
         }
         const labels = runs.map(
            (r) => `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`
         );
         if (!ctx.hasUI) {
            ctx.ui.notify(labels.join("\n"), "info");
            return;
         }
         const choice = await ctx.ui.select("Workflow runs", labels);
         if (!choice) return;
         const run = runs[labels.indexOf(choice)];
         if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
      }
   });

   pi.registerTool({
      name: "workflow",
      label: "Workflow",
      description: WORKFLOW_TOOL_DESCRIPTION,
      promptSnippet: WORKFLOW_PROMPT_SNIPPET,
      promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
      parameters: WorkflowParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         let prepared: ReturnType<typeof prepareWorkflowScript>;
         try {
            prepared = prepareWorkflowScript(params.script);
         } catch (error) {
            throw new Error(`Workflow script failed to parse: ${errorText(error)}`, { cause: error });
         }

         let args: unknown;
         if (params.args !== undefined) {
            try {
               args = JSON.parse(params.args);
            } catch {
               args = params.args;
            }
         }

         const meta = prepared.meta;
         const runId = `wf_${randomBytes(6).toString("hex")}`;
         const runDir = path.join(getAgentDir(), "workflows", runId);
         const background = (params.background ?? false) && ctx.hasUI;

         const details: WorkflowDetails = {
            runId,
            sessionId: ctx.sessionManager.getSessionId(),
            ...(ctx.sessionManager.getSessionFile?.()
               ? { parentSessionFile: ctx.sessionManager.getSessionFile?.() }
               : {}),
            name: meta.name,
            description: meta.description,
            background,
            status: "running",
            startedAt: Date.now(),
            phases: [...meta.phases],
            agents: []
         };

         writeRunFile(runDir, "script.js", params.script);
         if (params.args !== undefined) writeRunFile(runDir, "args.json", params.args);
         persistWorkflowJson(runDir, details);
         const persistence = createWorkflowPersistence(runDir, details);

         // Background runs survive Esc on the parent turn, but all runs are
         // aborted and settled during session shutdown.
         const controller = new RunController(background ? undefined : signal);

         // Each concurrent child gets its own extension runtime. All children use
         // the parent cwd and live trust decision.
         const projectTrusted = ctx.isProjectTrusted();
         const getResources = (profile: ReturnType<typeof resolveAgentProfile>) =>
            createWorkflowResources(ctx.cwd, "structured", projectTrusted, profile);

         // Throttled progress: tool-block updates when blocking. Background
         // runs are covered by the below-editor indicator and /workflows.
         let emitTimer: ReturnType<typeof setTimeout> | undefined;
         let lastEmit = 0;
         const flush = () => {
            emitTimer = undefined;
            lastEmit = Date.now();
            if (!background) onUpdate?.(workflowProgressUpdate(details));
         };
         const emit = (checkpoint = true) => {
            if (checkpoint) persistence.checkpoint();
            if (emitTimer) return;
            emitTimer = setTimeout(flush, Math.max(0, WORKFLOW_TOOL_EMIT_INTERVAL_MS - (Date.now() - lastEmit)));
         };
         const flushNow = () => {
            if (emitTimer) clearTimeout(emitTimer);
            flush();
         };

         const phaseFn = (title: unknown) => {
            const text = String(title);
            details.currentPhase = text;
            if (!details.phases.some((p) => p.title === text)) details.phases.push({ title: text });
            emit();
         };

         let agentCounter = 0;
         const agentFn = async (
            promptValue: unknown,
            optsValue: unknown = {},
            parentInvocationSignal?: AbortSignal
         ): Promise<ScriptAgentResult> => {
            const index = ++agentCounter;
            const opts: AgentCallOptions =
               optsValue && typeof optsValue === "object" ? (optsValue as AgentCallOptions) : {};
            const label =
               typeof opts.label === "string" && opts.label.trim() ? opts.label.trim().slice(0, 160) : `agent-${index}`;
            const profile = resolveAgentProfile(opts.agent, ctx.cwd);

            const record: AgentRecord = {
               index,
               label,
               phase: typeof opts.phase === "string" ? opts.phase.slice(0, 160) : details.currentPhase,
               state: "running",
               profile: profile?.name,
               provider: ctx.model?.provider,
               model: ctx.model?.id,
               cwd: ctx.cwd,
               contextWindow: ctx.model?.contextWindow,
               startedAt: Date.now(),
               preview: "",
               usage: emptyUsage(),
               transcript: []
            };
            details.agents.push(record);
            persistence.checkpoint({ immediate: true });
            emit(false);

            const agentAbortController = new AbortController();
            abortControllers.set(record.index, agentAbortController);
            if (parentInvocationSignal) {
               if (parentInvocationSignal.aborted) agentAbortController.abort(parentInvocationSignal.reason);
               else
                  parentInvocationSignal.addEventListener(
                     "abort",
                     () => agentAbortController.abort(parentInvocationSignal.reason),
                     { once: true }
                  );
            }
            const invocationSignal = agentAbortController.signal;

            const fail = (error: string): ScriptAgentResult => {
               abortControllers.delete(record.index);
               record.state = "error";
               record.error = error;
               record.finishedAt = Date.now();
               emit();
               const isUserAbort = agentAbortController.signal.aborted;
               const errorMsg = isUserAbort
                  ? "aborted by user (ignore this subagent output; do not re-run workflow)"
                  : error;
               return { ok: false, output: "", error: errorMsg };
            };

            const prompt = typeof promptValue === "string" ? promptValue : "";
            if (!prompt.trim()) return fail("agent() requires a non-empty prompt string");
            if (!profile) {
               const requested = typeof opts.agent === "string" && opts.agent.trim() ? opts.agent.trim() : "good";
               return fail(`Unknown agent profile "${requested}".`);
            }
            if (controller.signal.aborted) return fail("Workflow was aborted before this agent started");

            return controller
               .schedule(async (runSignal) => {
                  // Profiles own model, tool, and thinking-level selection.
                  const thinkingLevel = profile.thinking ?? pi.getThinkingLevel();
                  record.profile = profile.name;
                  record.provider = ctx.model?.provider;
                  record.model = ctx.model?.id;
                  record.contextWindow = ctx.model?.contextWindow;
                  emit();

                  const resources = await getResources(profile);
                  const outcome = await runAgent({
                     prompt,
                     schema: opts.schema,
                     profile,
                     thinkingLevel,
                     cwd: ctx.cwd,
                     parentSessionFile: ctx.sessionManager.getSessionFile?.(),
                     loader: resources.loader,
                     settingsManager: resources.settingsManager,
                     model: ctx.model,
                     modelRegistry: ctx.modelRegistry,
                     signal: runSignal,
                     onSession: (session) => {
                        childSessions.set(record.index, session);
                     },
                     onProgress: (progress) => {
                        record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
                        record.usage = progress.usage;
                        record.provider = progress.provider ?? record.provider;
                        record.model = progress.model ?? record.model;
                        record.contextWindow = progress.contextWindow ?? record.contextWindow;
                        record.profile = progress.profile ?? record.profile;
                        record.sessionId = progress.sessionId ?? record.sessionId;
                        record.sessionFile = progress.sessionFile ?? record.sessionFile;
                        record.systemPrompt = progress.systemPrompt ?? record.systemPrompt;
                        record.transcript = progress.transcript;
                        emit();
                     }
                  });

                  record.usage = outcome.usage;
                  record.provider = outcome.provider ?? record.provider;
                  record.model = outcome.model ?? record.model;
                  record.contextWindow = outcome.contextWindow ?? record.contextWindow;
                  record.profile = outcome.profile ?? record.profile;
                  record.sessionId = outcome.sessionId ?? record.sessionId;
                  record.sessionFile = outcome.sessionFile ?? record.sessionFile;
                  record.systemPrompt = outcome.systemPrompt ?? record.systemPrompt;
                  record.transcript = outcome.transcript;
                  record.preview = (outcome.output || record.preview).slice(0, PREVIEW_LENGTH);
                  record.finishedAt = Date.now();
                  childSessions.delete(record.index);
                  abortControllers.delete(record.index);
                  record.state = outcome.ok ? "done" : "error";
                  if (outcome.ok) {
                     delete record.error;
                     record.result = outcome.structured !== undefined ? outcome.structured : outcome.output;
                  } else {
                     record.error =
                        outcome.aborted || agentAbortController.signal.aborted
                           ? "aborted by user (ignore this subagent output; do not re-run workflow)"
                           : (outcome.error ?? "Agent failed");
                  }
                  emit();

                  return {
                     ok: outcome.ok,
                     output: outcome.output,
                     ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
                     ...(outcome.error !== undefined
                        ? {
                             error:
                                outcome.aborted || agentAbortController.signal.aborted
                                   ? "aborted by user (ignore this subagent output; do not re-run workflow)"
                                   : outcome.error
                          }
                        : {})
                  };
               }, invocationSignal)
               .catch((error) => fail(errorText(error)));
         };

         const runScript = async () => {
            let status: WorkflowDetails["status"] = "completed";
            try {
               details.result = await runWorkflowSandbox({
                  source: prepared.source,
                  args,
                  cwd: ctx.cwd,
                  signal: controller.signal,
                  onAgent: agentFn,
                  onPhase: phaseFn
               });
            } catch (error) {
               details.error = errorText(error);
               status = controller.signal.aborted ? "aborted" : "failed";
               controller.abort("Workflow script failed");
            }

            const settled = await controller.settle({
               abort: status !== "completed"
            });
            if (!settled) {
               status = "failed";
               details.error = details.error
                  ? `${details.error}; agent shutdown deadline exceeded`
                  : "Agent shutdown deadline exceeded";
            }
            for (const record of details.agents) {
               if (record.state !== "running") continue;
               record.state = "error";
               record.error = record.error ?? "Agent did not settle before run cleanup";
               record.finishedAt = Date.now();
            }
            details.status = status;
            details.finishedAt = Date.now();
            try {
               persistence.flush();
            } catch (error) {
               details.status = "failed";
               details.error = `Artifact persistence failed: ${errorText(error)}`;
               throw new Error(details.error, { cause: error });
            } finally {
               flushNow();
            }
         };

         // Registered for /workflows visibility and session_shutdown abort;
         // blocking runs are watchable live from the dashboard too.
         const childSessions = new Map<number, AgentSession>();
         const abortControllers = new Map<number, AbortController>();
         const activeRun = { details, controller, childSessions, abortControllers } as {
            details: WorkflowDetails;
            controller: RunController;
            completion?: Promise<void>;
            childSessions?: Map<number, AgentSession>;
            abortControllers?: Map<number, AbortController>;
         };
         activeRuns.set(runId, activeRun);
         const completion = runScript();
         activeRun.completion = completion;
         if (ctx.hasUI) lastUi = ctx.ui;
         updateIndicator();
         if (!background) flushNow();

         if (background) {
            void completion
               .catch((error) => {
                  details.status = "failed";
                  details.finishedAt = Date.now();
                  details.error = details.error ?? errorText(error);
               })
               .finally(() => {
                  activeRuns.delete(runId);
                  recordSettledRun(details.status);
                  updateIndicator();
                  try {
                     pi.sendUserMessage(
                        buildBackgroundWorkflowFollowUp({
                           runId,
                           status: details.status,
                           result: buildWorkflowResultMessage(details, runDir)
                        }),
                        { deliverAs: "followUp" }
                     );
                  } catch {
                     // Session may be shutting down.
                  }
               });
            return {
               content: [
                  {
                     type: "text",
                     text: buildBackgroundWorkflowLaunchResult({
                        runId,
                        name: details.name,
                        runDir
                     })
                  }
               ],
               details: compactToolDetails(details)
            };
         }

         try {
            await completion;
         } finally {
            activeRuns.delete(runId);
            recordSettledRun(details.status);
            updateIndicator();
         }
         if (details.status !== "completed") {
            // Pi marks tool failures only when execute throws; returning isError is
            // ignored by the extension API.
            throw new Error(buildWorkflowResultMessage(details, runDir));
         }
         return {
            content: [
               {
                  type: "text",
                  text: buildWorkflowResultMessage(details, runDir)
               }
            ],
            details: compactToolDetails(details)
         };
      },

      renderCall(args: Partial<WorkflowInput>, theme, context) {
         const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
         // When execution has started, or when the tool call has finished/settled (argsComplete is true or executionStarted is true),
         // or when a result is present, renderCall stays blank so the single unified workflow card is displayed without duplicate text.
         if (
            context?.executionStarted ||
            context?.argsComplete ||
            (typeof args.script === "string" && args.script.length > 0 && context?.argsComplete !== false)
         ) {
            component.setText("");
            return component;
         }

         if (context?.argsComplete === false) {
            component.setText(theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("dim", "(writing script)"));
            return component;
         }

         component.setText("");
         return component;
      },

      renderResult(result, { expanded }, theme, context) {
         const previous = context?.lastComponent;
         const details = result.details as WorkflowDetails | undefined;
         if (!details) {
            const first = result.content[0];
            const component = previous instanceof Text ? previous : new Text("", 0, 0);
            component.setText(first?.type === "text" ? first.text : "(no output)");
            return component;
         }

         const { done, failed } = countStates(details);
         const settled = done + failed;
         const elapsed = formatElapsed(details.startedAt, details.finishedAt);
         const totals = formatUsage(aggregateUsage(details.agents));
         const badge = statusBadge(details.status, theme);

         if (!expanded) {
            const titleLine = `${theme.fg("toolTitle", theme.bold("WORKFLOW  "))}${theme.fg("accent", details.name ?? details.runId)}  ${badge}`;
            const headerSection: string[] = [titleLine];
            if (details.description) {
               headerSection.push(theme.fg("dim", details.description));
            }
            let collapsedSummaryLine = theme.fg(
               "dim",
               `Agents: ${settled}/${details.agents.length} settled · ${elapsed}`
            );
            if (failed) collapsedSummaryLine += theme.fg("error", ` · ${failed} failed`);
            if (details.background) collapsedSummaryLine += theme.fg("dim", " · (background)");
            if (details.status === "running" && details.currentPhase) {
               collapsedSummaryLine += theme.fg("muted", ` · Active Phase: ${details.currentPhase}`);
            }
            headerSection.push(collapsedSummaryLine);

            const agentSection: string[] = [];
            if (details.agents.length > 0) {
               agentSection.push(theme.bold("AGENTS"));
               for (const agent of details.agents) {
                  const agentContextText = agentContext(agent);
                  const icon = agentBadge(agent.state, theme);
                  const line = `  ${icon} ${theme.fg("accent", agent.label)}${agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""}${theme.fg(
                     "dim",
                     `${agentContextText ? ` · ${agentContextText}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`
                  )}`;
                  agentSection.push(line);
               }
            }

            const usageSection: string[] = [];
            if (totals) {
               usageSection.push(theme.bold("TOTAL USAGE"));
               usageSection.push(`  ${theme.fg("dim", totals)}`);
            }
            if (details.error) {
               usageSection.push(theme.fg("error", `Error: ${details.error}`));
            }
            usageSection.push("");
            usageSection.push(theme.fg("muted", `(Press ${keyHint("app.tools.expand", "to expand details")})`));

            const text = formatCleanSections([headerSection, agentSection, usageSection], theme);
            const component = previous instanceof Text ? previous : new Text("", 0, 0);
            component.setText(text);
            return component;
         }

         const container = previous instanceof Container ? previous : new Container();
         container.clear();

         const titleLine = `${theme.fg("toolTitle", theme.bold("WORKFLOW  "))}${theme.fg("accent", details.name ?? details.runId)}  ${badge}`;
         const headerSection: string[] = [titleLine];
         if (details.description) {
            headerSection.push(theme.fg("dim", details.description));
         }
         let expandedSummaryLine = theme.fg(
            "dim",
            `Run ID: ${details.runId} · ${settled}/${details.agents.length} agents` +
               `${failed ? ` · ${failed} failed` : ""} · ${elapsed}`
         );
         if (details.background) expandedSummaryLine += theme.fg("dim", " · (background)");
         if (details.status === "running" && details.currentPhase) {
            expandedSummaryLine += theme.fg("muted", ` · Active Phase: ${details.currentPhase}`);
         }
         headerSection.push(expandedSummaryLine);

         const sections: string[][] = [headerSection];

         for (const group of phaseGroups(details)) {
            const phaseSection: string[] = [];
            const matchingMetaPhase = details.phases.find((p) => p.title === group.title);
            phaseSection.push(theme.bold(`PHASE: ${group.title}`));
            if (matchingMetaPhase?.detail) {
               phaseSection.push(theme.fg("dim", `  ${matchingMetaPhase.detail}`));
            }
            for (const agent of group.agents) {
               const icon = agentBadge(agent.state, theme);
               phaseSection.push(`  ${icon} ${theme.fg("accent", agent.label)}`);
               const model = formatAgentModel(agent);
               const contextText = agentContext(agent);
               const subLineParts = [
                  model ? `Model: ${model}` : undefined,
                  contextText ? `Context: ${contextText}` : undefined,
                  formatElapsed(agent.startedAt, agent.finishedAt)
               ].filter(Boolean);
               phaseSection.push(theme.fg("dim", `    ${subLineParts.join(" · ")}`));

               const usage = formatUsage(agent.usage);
               if (usage) {
                  phaseSection.push(theme.fg("dim", `    Usage: ${usage}`));
               }
               if (agent.error) {
                  phaseSection.push(theme.fg("error", `    Error: ${agent.error}`));
               } else if (agent.preview) {
                  phaseSection.push(theme.fg("dim", "    Preview:"));
                  for (const line of agent.preview.split("\n").slice(0, 4)) {
                     phaseSection.push(theme.fg("dim", `      ${line}`));
                  }
               }
            }
            sections.push(phaseSection);
         }

         if (details.error) {
            sections.push([theme.bold(theme.fg("error", "WORKFLOW ERROR")), `  ${theme.fg("error", details.error)}`]);
         }

         if (details.result !== undefined) {
            const resultLines: string[] = [theme.bold("RESULT")];
            const formattedJson = resultJson(details.result);
            for (const line of formattedJson.split("\n")) {
               resultLines.push(`  ${theme.fg("accent", line)}`);
            }
            sections.push(resultLines);
         }

         if (totals) {
            sections.push([theme.bold("TOTAL USAGE"), `  ${theme.fg("dim", totals)}`]);
         }

         const text = formatCleanSections(sections, theme);
         container.addChild(new Text(text, 0, 0));
         return container;
      }
   });
}
