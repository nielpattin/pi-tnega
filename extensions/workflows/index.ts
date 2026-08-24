/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime work phase progression
 *   await agent(prompt, { agent?, label?, phase?, schema? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly. The runtime
 * appends one no-tools `Summary` phase after the work phases; its assistant
 * text is the workflow result.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; child session files
 * provide agent transcripts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
   getAgentDir,
   getMarkdownTheme,
   getSelectListTheme,
   keyHint,
   type AgentSession,
   type ExtensionAPI,
   type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Input, Markdown, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { listAgentProfiles, resolveAgentProfile } from "../shared/agent-profiles.ts";
import { resolveProfileModel } from "../shared/model-resolution.ts";
import { formatActivityStatus } from "./activity-status.ts";
import { createWorkflowPersistence, persistWorkflowJson, recoverWorkflowDetails } from "./artifacts.ts";
import { MAX_AGENT_CALLS, RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import { prepareWorkflowScript } from "./meta.ts";
import { openAgentsPanel } from "./agents-panel.ts";
import {
   agentContext,
   aggregateUsage,
   countStates,
   displayPhaseTitle,
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
   appendSummaryPhase,
   buildBackgroundWorkflowFollowUp,
   buildBackgroundWorkflowLaunchResult,
   buildWorkflowResultMessage,
   buildWorkflowSummaryPrompt,
   buildWorkflowSummaryTranscript,
   collectPreviousPhaseResults,
   createSummaryAgentRecord,
   SUMMARY_PHASE_TITLE,
   WORKFLOW_PARAMETER_DESCRIPTIONS,
   WORKFLOW_PROMPT_GUIDELINES,
   WORKFLOW_PROMPT_SNIPPET,
   WORKFLOW_TOOL_DESCRIPTION
} from "./prompt.ts";
import {
   capWorkflowModelToParentContext,
   createWorkflowResources,
   resolveModelById,
   runAgent,
   runWorkflowSummary,
   type AgentOutcome
} from "./runner.ts";
import {
   DEFAULT_WORKFLOW_SETTINGS,
   readWorkflowSettings,
   type WorkflowSettings,
   type WorkflowThinkingLevel,
   WORKFLOW_THINKING_LEVELS,
   writeWorkflowSettings
} from "./settings.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "../shared/serialization.ts";

export const WORKFLOW_TOOL_EMIT_INTERVAL_MS = 500;
export const WORKFLOW_BACKGROUND_RESULT_MESSAGE_TYPE = "workflow-background-result";
const PREVIEW_LENGTH = 200;

interface WorkflowToolRendererState {
   liveDetails?: WorkflowDetails;
   backgroundRunId?: string;
   backgroundRefreshTimer?: ReturnType<typeof setInterval>;
}

export function renderBackgroundWorkflowMessage(
   message: { content: unknown; details?: unknown },
   options: { expanded: boolean },
   theme: ExtensionContext["ui"]["theme"]
) {
   const content =
      typeof message.content === "string"
         ? message.content
         : Array.isArray(message.content)
           ? message.content
                .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
                .join("")
           : "";
   const [marker, ...bodyLines] = content.split(/\r?\n/);
   const details =
      message.details && typeof message.details === "object" ? (message.details as Record<string, unknown>) : {};
   const markerMatch = marker?.match(/^\[Background workflow (\S+) (\S+)\]$/);
   const runId = typeof details.runId === "string" ? details.runId : (markerMatch?.[1] ?? "unknown");
   const status = typeof details.status === "string" ? details.status : (markerMatch?.[2] ?? "completed");
   const header = theme.fg("customMessageLabel", `[Background workflow ${runId} ${status}]`);
   const body = bodyLines.join("\n").replaceAll("\\", "/").trim();
   const bodyRows = body ? body.split("\n") : [];
   const resultRow = bodyRows.findIndex((row) => row.trim() === "Result:");
   const hasCollapsedResult = resultRow >= 0;
   const previewRows = hasCollapsedResult ? bodyRows.slice(0, resultRow) : bodyRows;
   const visibleBodyRows = options.expanded ? bodyRows : previewRows;
   const renderedBody = visibleBodyRows.join("\n");
   const box = new Box(1, 1, (text) => theme.bg(status === "completed" ? "toolSuccessBg" : "toolErrorBg", text));
   box.addChild(new Text(header, 0, 0));
   if (renderedBody) {
      box.addChild(new Spacer(1));
      box.addChild(
         new Markdown(renderedBody, 0, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("customMessageText", text)
         })
      );
   }
   if (!options.expanded && hasCollapsedResult) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("muted", "(ctrl+o to view result)"), 0, 0));
   }
   return box;
}

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
   if (status === "completed") return theme.fg("success", "✓ done");
   if (status === "running") return theme.fg("warning", "● running");
   if (status === "aborted") return theme.fg("error", "✗ aborted");
   return theme.fg("error", "✗ failed");
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
   /** Compatibility alias accepted by older workflow scripts. */
   profile?: unknown;
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

function resolveSummaryModel(settings: WorkflowSettings, ctx: ExtensionContext) {
   if (!settings.summaryModel) return ctx.model;
   return capWorkflowModelToParentContext(
      resolveProfileModel(
         ctx.modelRegistry,
         { model: settings.summaryModel },
         ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined
      ),
      ctx.model
   );
}

function appendError(existing: string | undefined, next: string): string {
   return existing ? `${existing}; ${next}` : next;
}

type WorkflowModelOption = { label: string; value?: string };
const ACTIVE_WORKFLOW_MODEL = "__active_session_model__";

function workflowModelOptions(ctx: ExtensionContext, currentModel?: string): WorkflowModelOption[] {
   const options: Array<{ label: string; value?: string }> = [{ label: "Active session model" }];
   const values = new Set<string>();
   try {
      for (const model of ctx.modelRegistry.getAvailable()) {
         const value = `${model.provider}/${model.id}`;
         if (values.has(value)) continue;
         values.add(value);
         options.push({ label: value, value });
      }
   } catch {
      // Keep the active-model option if the registry is temporarily unavailable.
   }
   if (currentModel && !values.has(currentModel)) {
      options.splice(1, 0, { label: `${currentModel} (saved, unavailable)`, value: currentModel });
   }
   return options;
}

export function filterWorkflowModelOptions<T extends WorkflowModelOption>(options: readonly T[], query: string): T[] {
   const normalized = query.trim().toLowerCase();
   if (!normalized) return [...options];
   return options.filter((option) => `${option.label} ${option.value ?? ""}`.toLowerCase().includes(normalized));
}

type WorkflowSettingsPickerItem = {
   value: string;
   label: string;
   description?: string;
};

type WorkflowSettingsView =
   | "menu"
   | "model"
   | "thinking"
   | "fallbacks"
   | "add_fallback"
   | "edit_fallback"
   | "replace_fallback";

class WorkflowSettingsPanel {
   private settings: WorkflowSettings;
   private view: WorkflowSettingsView = "menu";
   private selectList!: SelectList;
   private filterInput?: Input;
   private items: WorkflowSettingsPickerItem[] = [];
   private selectedFallbackIndex = -1;

   constructor(
      private ctx: ExtensionContext,
      private tui: { requestRender: () => void },
      private theme: ExtensionContext["ui"]["theme"],
      private done: (result: void) => void
   ) {
      this.settings = readWorkflowSettings();
      this.setMenu();
   }

   private save(next: WorkflowSettings): void {
      try {
         writeWorkflowSettings(next);
         this.settings = next;
         this.ctx.ui.notify("Workflow settings saved.", "info");
      } catch (error) {
         this.ctx.ui.notify(`Could not save Workflow settings: ${errorText(error)}`, "error");
      }
   }

   private setItems(items: WorkflowSettingsPickerItem[], selectedValue?: string): void {
      this.items = items;
      this.selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
      const selectedIndex = selectedValue === undefined ? -1 : items.findIndex((item) => item.value === selectedValue);
      if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
      this.selectList.onSelect = (item) => this.select(item.value);
      this.selectList.onCancel = () => this.cancelPicker();
   }

   private setMenu(): void {
      this.view = "menu";
      this.filterInput = undefined;
      const fallbackCount = this.settings.fallbackModels?.length ?? 0;
      const fallbackLabel = fallbackCount === 0 ? "none" : `${fallbackCount} configured`;
      this.setItems(
         [
            {
               value: "model",
               label: `Summary model: ${this.settings.summaryModel ?? "Active session model"}`
            },
            {
               value: "thinking",
               label: `Summary thinking: ${this.settings.summaryThinking ?? "Inherit active level"}`
            },
            {
               value: "fallbacks",
               label: `Fallback models: ${fallbackLabel}`
            },
            { value: "reset", label: "Reset to active defaults" },
            { value: "done", label: "Done" }
         ],
         "model"
      );
      this.tui.requestRender();
   }

   private setModelPicker(): void {
      this.view = "model";
      this.filterInput = new Input();
      this.filterInput.focused = true;
      const options = workflowModelOptions(this.ctx, this.settings.summaryModel);
      const items = options.map((option) => ({
         value: option.value ?? ACTIVE_WORKFLOW_MODEL,
         label: option.label
      }));
      this.setItems(items, this.settings.summaryModel ?? ACTIVE_WORKFLOW_MODEL);
      this.tui.requestRender();
   }

   private setThinkingPicker(): void {
      this.view = "thinking";
      this.filterInput = undefined;
      this.setItems(
         [
            { value: "__inherit__", label: "Inherit active level" },
            ...WORKFLOW_THINKING_LEVELS.map((level) => ({ value: level, label: level }))
         ],
         this.settings.summaryThinking ?? "__inherit__"
      );
      this.tui.requestRender();
   }

   private setFallbacksView(): void {
      this.view = "fallbacks";
      this.filterInput = undefined;
      const fallbacks = this.settings.fallbackModels ?? [];
      const items: WorkflowSettingsPickerItem[] = [
         { value: "add", label: "+ Add fallback model" },
         ...fallbacks.map((model, idx) => ({
            value: `item:${idx}`,
            label: `#${idx + 1}: ${model}`
         }))
      ];
      if (fallbacks.length > 0) {
         items.push({ value: "clear", label: "Clear all fallback models" });
      }
      items.push({ value: "back", label: "Back" });
      this.setItems(items, "add");
      this.tui.requestRender();
   }

   private setAddFallbackPicker(): void {
      this.view = "add_fallback";
      this.filterInput = new Input();
      this.filterInput.focused = true;
      const options = workflowModelOptions(this.ctx);
      const filteredOptions = options.filter((opt) => opt.value !== undefined && opt.value !== ACTIVE_WORKFLOW_MODEL);
      const items = filteredOptions.map((opt) => ({
         value: opt.value!,
         label: opt.label
      }));
      this.setItems(items);
      this.tui.requestRender();
   }

   private setReplaceFallbackPicker(): void {
      this.view = "replace_fallback";
      this.filterInput = new Input();
      this.filterInput.focused = true;
      const options = workflowModelOptions(this.ctx);
      const filteredOptions = options.filter((opt) => opt.value !== undefined && opt.value !== ACTIVE_WORKFLOW_MODEL);
      const items = filteredOptions.map((opt) => ({
         value: opt.value!,
         label: opt.label
      }));
      this.setItems(items);
      this.tui.requestRender();
   }

   private setEditFallbackView(index: number): void {
      this.selectedFallbackIndex = index;
      this.view = "edit_fallback";
      this.filterInput = undefined;
      const fallbacks = this.settings.fallbackModels ?? [];
      const currentModel = fallbacks[index] ?? `Model #${index + 1}`;
      const items: WorkflowSettingsPickerItem[] = [
         { value: "remove", label: `Remove ${currentModel}` },
         { value: "replace", label: `Replace ${currentModel}` }
      ];
      if (index > 0) items.push({ value: "move_up", label: "Move up" });
      if (index < fallbacks.length - 1) items.push({ value: "move_down", label: "Move down" });
      items.push({ value: "back", label: "Back" });
      this.setItems(items, "remove");
      this.tui.requestRender();
   }

   private updateModelFilter(): void {
      if (!this.filterInput) return;
      const isFallbackSearch = this.view === "add_fallback" || this.view === "replace_fallback";
      const options = workflowModelOptions(this.ctx, isFallbackSearch ? undefined : this.settings.summaryModel);
      const candidates = isFallbackSearch
         ? options.filter((opt) => opt.value !== undefined && opt.value !== ACTIVE_WORKFLOW_MODEL)
         : options;
      const filtered = filterWorkflowModelOptions(candidates, this.filterInput.getValue()).map((option) => ({
         value: option.value ?? ACTIVE_WORKFLOW_MODEL,
         label: option.label
      }));
      const internals = this.selectList as unknown as {
         items: WorkflowSettingsPickerItem[];
         filteredItems: WorkflowSettingsPickerItem[];
         selectedIndex: number;
      };
      internals.items = filtered;
      internals.filteredItems = filtered;
      internals.selectedIndex = 0;
      this.items = filtered;
   }

   private cancelPicker(): void {
      if (this.view === "menu") this.done(undefined);
      else if (this.view === "add_fallback" || this.view === "edit_fallback" || this.view === "replace_fallback") {
         this.setFallbacksView();
      } else this.setMenu();
   }

   private select(value: string): void {
      if (this.view === "menu") {
         if (value === "model") this.setModelPicker();
         else if (value === "thinking") this.setThinkingPicker();
         else if (value === "fallbacks") this.setFallbacksView();
         else if (value === "reset") {
            this.save({ ...DEFAULT_WORKFLOW_SETTINGS });
            this.setMenu();
         } else this.done(undefined);
         return;
      }

      if (this.view === "fallbacks") {
         if (value === "add") {
            this.setAddFallbackPicker();
         } else if (value === "clear") {
            this.save({ ...this.settings, fallbackModels: undefined });
            this.setFallbacksView();
         } else if (value === "back") {
            this.setMenu();
         } else if (value.startsWith("item:")) {
            const idx = Number.parseInt(value.slice(5), 10);
            this.setEditFallbackView(idx);
         }
         return;
      }

      if (this.view === "add_fallback") {
         const current = this.settings.fallbackModels ?? [];
         this.save({ ...this.settings, fallbackModels: [...current, value] });
         this.setFallbacksView();
         return;
      }

      if (this.view === "replace_fallback") {
         const current = [...(this.settings.fallbackModels ?? [])];
         if (this.selectedFallbackIndex >= 0 && this.selectedFallbackIndex < current.length) {
            current[this.selectedFallbackIndex] = value;
            this.save({ ...this.settings, fallbackModels: current });
         }
         this.setFallbacksView();
         return;
      }

      if (this.view === "edit_fallback") {
         const current = [...(this.settings.fallbackModels ?? [])];
         const idx = this.selectedFallbackIndex;
         if (value === "remove") {
            if (idx >= 0 && idx < current.length) {
               current.splice(idx, 1);
               this.save({ ...this.settings, fallbackModels: current.length > 0 ? current : undefined });
            }
            this.setFallbacksView();
         } else if (value === "replace") {
            this.setReplaceFallbackPicker();
         } else if (value === "move_up") {
            if (idx > 0 && idx < current.length) {
               const temp = current[idx - 1];
               current[idx - 1] = current[idx];
               current[idx] = temp;
               this.save({ ...this.settings, fallbackModels: current });
            }
            this.setFallbacksView();
         } else if (value === "move_down") {
            if (idx >= 0 && idx < current.length - 1) {
               const temp = current[idx + 1];
               current[idx + 1] = current[idx];
               current[idx] = temp;
               this.save({ ...this.settings, fallbackModels: current });
            }
            this.setFallbacksView();
         } else {
            this.setFallbacksView();
         }
         return;
      }

      if (this.view === "model") {
         this.save({ ...this.settings, summaryModel: value === ACTIVE_WORKFLOW_MODEL ? undefined : value });
      } else {
         this.save({
            ...this.settings,
            summaryThinking: value === "__inherit__" ? undefined : (value as WorkflowThinkingLevel)
         });
      }
      this.setMenu();
   }

   handleInput(data: string): void {
      if (data === "\x1b") {
         this.cancelPicker();
         return;
      }

      const isSearch = this.view === "model" || this.view === "add_fallback" || this.view === "replace_fallback";
      if (isSearch && this.filterInput) {
         const navigation = data === "\r" || data === "\n" || data === "\x1b[A" || data === "\x1b[B";
         if (navigation) this.selectList.handleInput(data);
         else {
            this.filterInput.handleInput(data);
            this.updateModelFilter();
         }
      } else {
         this.selectList.handleInput(data);
      }
      this.tui.requestRender();
   }

   render(width: number): string[] {
      const title =
         this.view === "menu"
            ? "Workflow Settings"
            : this.view === "model"
              ? "Summary model"
              : this.view === "thinking"
                ? "Summary thinking"
                : this.view === "fallbacks"
                  ? "Fallback models"
                  : this.view === "add_fallback"
                    ? "Add fallback model"
                    : this.view === "replace_fallback"
                      ? "Replace fallback model"
                      : "Edit fallback model";
      const description =
         this.view === "fallbacks" ||
         this.view === "add_fallback" ||
         this.view === "edit_fallback" ||
         this.view === "replace_fallback"
            ? "Configure fallback models to retry workflow agents or the final Summary with."
            : "Configure workflow summary and agent execution settings.";
      const lines = [this.theme.bold(this.theme.fg("accent", title)), this.theme.fg("muted", description), ""];
      const isSearch = this.view === "model" || this.view === "add_fallback" || this.view === "replace_fallback";
      if (isSearch && this.filterInput) {
         lines.push(this.theme.fg("muted", "Search models by provider or model id:"));
         lines.push(...this.filterInput.render(width));
         lines.push("");
      }
      lines.push(...this.selectList.render(width));
      lines.push(
         this.theme.fg(
            "dim",
            isSearch
               ? "Type to filter · ↑/↓ navigate · Enter select · Esc back"
               : "↑/↓ navigate · Enter select · Esc back"
         )
      );
      return lines;
   }

   invalidate(): void {
      this.selectList.invalidate();
   }
}

async function openWorkflowSettings(ctx: ExtensionContext): Promise<void> {
   await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WorkflowSettingsPanel(ctx, tui, theme, done), {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "80%", margin: 1 }
   });
}

function summaryLine(details: WorkflowDetails): string {
   const { done, failed } = countStates(details);
   const settled = done + failed;
   return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
      details.currentPhase ? ` · ${displayPhaseTitle(details.currentPhase)}` : ""
   }`;
}

export function insertWorkflowAgentBeforeSummary(agents: AgentRecord[], record: AgentRecord): void {
   const summaryIndex = agents.findIndex((agent) => agent.phase === SUMMARY_PHASE_TITLE);
   if (summaryIndex < 0) agents.push(record);
   else agents.splice(summaryIndex, 0, record);
}

function renderAbortedWorkflowResult(
   details: WorkflowDetails,
   expanded: boolean,
   theme: ExtensionContext["ui"]["theme"],
   previous: unknown
) {
   const { done, failed } = countStates(details);
   const settled = done + failed;
   const title = `${theme.fg("error", theme.bold("workflow aborted"))}  ${theme.fg("accent", details.name ?? details.runId)}`;
   const sections = [
      [title],
      [
         theme.fg("error", "the workflow was stopped before completion."),
         theme.fg("dim", `run id: ${details.runId} · ${settled}/${details.agents.length} agents settled`)
      ],
      ...(details.error
         ? [[theme.bold(theme.fg("error", "abort details")), `  ${theme.fg("error", details.error)}`]]
         : [])
   ];
   const text = formatCleanSections(sections, theme);
   if (!expanded) {
      const component = previous instanceof Text ? previous : new Text("", 0, 0);
      component.setText(text);
      return component;
   }
   const container = previous instanceof Container ? previous : new Container();
   container.clear();
   container.addChild(new Text(text, 0, 0));
   if (failed > 0) {
      container.addChild(
         new Text(theme.fg("error", `${failed} agent${failed === 1 ? "" : "s"} failed before abort.`), 0, 0)
      );
   }
   return container;
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

function compactToolDetails(details: WorkflowDetails) {
   return {
      ...details,
      ...(details.result !== undefined
         ? {
              result: JSON.parse(safeStringify(details.result, { maxBytes: 64 * 1024 }))
           }
         : {}),
      agents: details.agents.map(({ transcript: _transcript, preview: _preview, ...agent }) => {
         void _transcript;
         void _preview;
         return agent;
      })
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
   pi.registerMessageRenderer?.(WORKFLOW_BACKGROUND_RESULT_MESSAGE_TYPE, renderBackgroundWorkflowMessage);

   /** Live background runs, for /wf and shutdown cleanup. */
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

   pi.registerCommand("wf", {
      description: "List workflow runs",
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
         const abortWorkflow = (runId: string): boolean => {
            const run = activeRuns.get(runId);
            if (!run || run.details.status !== "running") return false;
            run.controller.abort("Workflow aborted by user");
            return true;
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
               getAvailableModels,
               abortWorkflow,
               () => openWorkflowSettings(ctx)
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
         const workflowSettings = readWorkflowSettings();
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
            phases: appendSummaryPhase(meta.phases),
            agents: []
         };
         const summaryRecord = createSummaryAgentRecord({
            index: MAX_AGENT_CALLS,
            startedAt: details.startedAt,
            model: ctx.model
         });
         details.agents.push(summaryRecord);

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
         // runs are covered by the below-editor indicator and /wf.
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
            if (controller.calls >= MAX_AGENT_CALLS - 1) {
               return {
                  ok: false,
                  output: "",
                  error: "Workflow reached the regular-agent limit; one call is reserved for the mandatory Summary phase"
               };
            }
            const index = ++agentCounter;
            const opts: AgentCallOptions =
               optsValue && typeof optsValue === "object" ? (optsValue as AgentCallOptions) : {};
            const label =
               typeof opts.label === "string" && opts.label.trim() ? opts.label.trim().slice(0, 160) : `agent-${index}`;
            const profile = resolveAgentProfile(opts.agent ?? opts.profile, ctx.cwd);

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
            insertWorkflowAgentBeforeSummary(details.agents, record);
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
                     fallbackModels: workflowSettings.fallbackModels,
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

         const runFinalSummary = async () => {
            phaseFn(SUMMARY_PHASE_TITLE);
            const previous = collectPreviousPhaseResults(details.agents);
            const prompt = buildWorkflowSummaryPrompt(previous);
            let summaryModel: ExtensionContext["model"];
            let modelError: string | undefined;
            try {
               summaryModel = resolveSummaryModel(workflowSettings, ctx);
            } catch (error) {
               modelError = errorText(error);
            }

            const record = summaryRecord;
            record.state = "running";
            record.preview = "";
            if (summaryModel) {
               record.provider = summaryModel.provider;
               record.model = summaryModel.id;
               record.contextWindow = summaryModel.contextWindow;
            }
            record.transcript = buildWorkflowSummaryTranscript({ prompt });
            persistence.checkpoint({ immediate: true });
            emit(false);

            const summaryFailure = (error: string, aborted = false): AgentOutcome => ({
               ok: false,
               output: "",
               error,
               aborted,
               usage: emptyUsage(),
               transcript: []
            });

            let outcome: AgentOutcome;
            if (modelError) {
               outcome = summaryFailure(modelError);
            } else if (!summaryModel) {
               outcome = summaryFailure("Final Summary requires an active model or Workflow Summary settings");
            } else {
               const summaryFallbackModels = (workflowSettings.fallbackModels ?? [])
                  .map((modelId) =>
                     capWorkflowModelToParentContext(resolveModelById(ctx.modelRegistry, modelId), ctx.model)
                  )
                  .filter(
                     (model): model is NonNullable<typeof model> =>
                        model !== undefined &&
                        (model.provider !== summaryModel.provider || model.id !== summaryModel.id)
                  );
               try {
                  outcome = await controller.schedule(
                     (runSignal) =>
                        runWorkflowSummary({
                           prompt,
                           model: summaryModel,
                           fallbackModels: summaryFallbackModels,
                           thinkingLevel: workflowSettings.summaryThinking ?? pi.getThinkingLevel(),
                           modelRegistry: ctx.modelRegistry,
                           signal: runSignal
                        }),
                     controller.signal
                  );
               } catch (error) {
                  outcome = summaryFailure(errorText(error), controller.signal.aborted);
               }
            }

            record.finishedAt = Date.now();
            record.state = outcome.ok ? "done" : "error";
            record.usage = outcome.usage;
            record.preview = outcome.output.slice(0, PREVIEW_LENGTH);
            record.provider = outcome.provider ?? record.provider;
            record.model = outcome.model ?? record.model;
            record.contextWindow = outcome.contextWindow ?? record.contextWindow;
            record.transcript = buildWorkflowSummaryTranscript({
               prompt,
               ...(outcome.ok ? { output: outcome.output } : {})
            });
            if (outcome.ok) {
               delete record.error;
               record.result = outcome.output;
               details.result = outcome.output;
            } else {
               record.error = outcome.error ?? "Final Summary failed";
            }
            emit();

            if (!outcome.ok) throw new Error(record.error ?? "Final Summary failed");
         };

         const runScript = async () => {
            let status: WorkflowDetails["status"] = "completed";
            try {
               await runWorkflowSandbox({
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
            }

            if (status !== "aborted") {
               try {
                  await runFinalSummary();
               } catch (error) {
                  status = controller.signal.aborted ? "aborted" : "failed";
                  details.error = appendError(details.error, errorText(error));
               }
            }

            if (status !== "completed") controller.abort("Workflow completed with errors");
            const settled = await controller.settle({
               abort: status !== "completed"
            });
            if (!settled) {
               status = "failed";
               details.error = appendError(details.error, "Agent shutdown deadline exceeded");
            }
            for (const record of details.agents) {
               if (record.state !== "running" && record.state !== "waiting") continue;
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

         // Registered for /wf visibility and session_shutdown abort;
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
                     const followUp = buildBackgroundWorkflowFollowUp({
                        runId,
                        status: details.status,
                        result: buildWorkflowResultMessage(details, runDir)
                     });
                     pi.sendMessage(
                        {
                           customType: WORKFLOW_BACKGROUND_RESULT_MESSAGE_TYPE,
                           content: followUp,
                           display: true,
                           details: { runId, status: details.status }
                        },
                        { deliverAs: "followUp", triggerTurn: true }
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
            const message = buildWorkflowResultMessage(details, runDir);
            if (details.status === "aborted") {
               return {
                  content: [{ type: "text", text: message }],
                  isError: true,
                  details: compactToolDetails(details)
               };
            }
            throw new Error(message);
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
            context?.isPartial === false ||
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
         const resultDetails = result.details as WorkflowDetails | undefined;
         if (!resultDetails) {
            const first = result.content[0];
            const component = previous instanceof Text ? previous : new Text("", 0, 0);
            component.setText(first?.type === "text" ? first.text : "(no output)");
            return component;
         }

         const rendererState = context?.state as WorkflowToolRendererState | undefined;
         const liveDetails = resultDetails.background ? activeRuns.get(resultDetails.runId)?.details : undefined;
         if (liveDetails && rendererState) rendererState.liveDetails = liveDetails;
         const details =
            rendererState?.liveDetails?.runId === resultDetails.runId ? rendererState.liveDetails : resultDetails;

         if (details.background && context && rendererState && activeRuns.has(details.runId)) {
            if (rendererState.backgroundRunId !== details.runId) {
               if (rendererState.backgroundRefreshTimer) clearInterval(rendererState.backgroundRefreshTimer);
               rendererState.backgroundRunId = details.runId;
               rendererState.backgroundRefreshTimer = undefined;
            }
            if (!rendererState.backgroundRefreshTimer) {
               rendererState.backgroundRefreshTimer = setInterval(() => {
                  context.invalidate();
                  const live = activeRuns.get(details.runId)?.details ?? rendererState.liveDetails;
                  if (!activeRuns.has(details.runId) && live?.status !== "running") {
                     if (rendererState.backgroundRefreshTimer) clearInterval(rendererState.backgroundRefreshTimer);
                     rendererState.backgroundRefreshTimer = undefined;
                  }
               }, WORKFLOW_TOOL_EMIT_INTERVAL_MS);
            }
         }

         if (details.status === "aborted") {
            return renderAbortedWorkflowResult(details, expanded, theme, previous);
         }

         const { done, failed } = countStates(details);
         const settled = done + failed;
         const elapsed = formatElapsed(details.startedAt, details.finishedAt);
         const totals = formatUsage(aggregateUsage(details.agents));
         const badge = statusBadge(details.status, theme);

         if (!expanded) {
            const titleLine = `${theme.fg("toolTitle", theme.bold("workflow  "))}${theme.fg("accent", details.name ?? details.runId)}  ${badge}`;
            const headerSection: string[] = [titleLine];
            if (details.description) {
               headerSection.push(theme.fg("dim", details.description));
            }
            let collapsedSummaryLine = theme.fg(
               "dim",
               `agents: ${settled}/${details.agents.length} settled · ${elapsed}`
            );
            if (failed) collapsedSummaryLine += theme.fg("error", ` · ${failed} failed`);
            if (details.background) collapsedSummaryLine += theme.fg("dim", " · (background)");
            if (details.status === "running" && details.currentPhase) {
               collapsedSummaryLine += theme.fg("muted", ` · active phase: ${displayPhaseTitle(details.currentPhase)}`);
            }
            headerSection.push(collapsedSummaryLine);

            const agentSection: string[] = [];
            if (details.agents.length > 0) {
               agentSection.push(theme.bold("agents"));
               for (const agent of details.agents) {
                  const agentContextText = agentContext(agent);
                  const icon = agentBadge(agent.state, theme);
                  const line = `  ${icon} ${theme.fg("accent", agent.label)}${agent.phase ? theme.fg("dim", ` (${displayPhaseTitle(agent.phase)})`) : ""}${theme.fg(
                     "dim",
                     `${agentContextText ? ` · ${agentContextText}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`
                  )}`;
                  agentSection.push(line);
               }
            }

            const usageSection: string[] = [];
            if (totals) {
               usageSection.push(theme.bold("usage"));
               usageSection.push(`  ${theme.fg("dim", totals)}`);
            }
            if (details.error) {
               usageSection.push(theme.fg("error", `error: ${details.error}`));
            }
            usageSection.push("");
            usageSection.push(theme.fg("muted", `(press ${keyHint("app.tools.expand", "to expand details")})`));

            const text = formatCleanSections([headerSection, agentSection, usageSection], theme);
            const component = previous instanceof Text ? previous : new Text("", 0, 0);
            component.setText(text);
            return component;
         }

         const container = previous instanceof Container ? previous : new Container();
         container.clear();

         const titleLine = `${theme.fg("toolTitle", theme.bold("workflow  "))}${theme.fg("accent", details.name ?? details.runId)}  ${badge}`;
         const headerSection: string[] = [titleLine];
         if (details.description) {
            headerSection.push(theme.fg("dim", details.description));
         }
         let expandedSummaryLine = theme.fg(
            "dim",
            `run id: ${details.runId} · ${settled}/${details.agents.length} agents` +
               `${failed ? ` · ${failed} failed` : ""} · ${elapsed}`
         );
         if (details.background) expandedSummaryLine += theme.fg("dim", " · (background)");
         if (details.status === "running" && details.currentPhase) {
            expandedSummaryLine += theme.fg("muted", ` · active phase: ${displayPhaseTitle(details.currentPhase)}`);
         }
         headerSection.push(expandedSummaryLine);

         const sections: string[][] = [headerSection];

         for (const group of phaseGroups(details)) {
            const phaseSection: string[] = [];
            const matchingMetaPhase = details.phases.find((p) => p.title === group.title);
            phaseSection.push(theme.bold(`phase: ${displayPhaseTitle(group.title)}`));
            if (matchingMetaPhase?.detail) {
               phaseSection.push(theme.fg("dim", `  ${matchingMetaPhase.detail}`));
            }
            for (const agent of group.agents) {
               const icon = agentBadge(agent.state, theme);
               phaseSection.push(`  ${icon} ${theme.fg("accent", agent.label)}`);
               const model = formatAgentModel(agent);
               const contextText = agentContext(agent);
               const subLineParts = [
                  model ? `model: ${model}` : undefined,
                  contextText ? `context: ${contextText}` : undefined,
                  formatElapsed(agent.startedAt, agent.finishedAt)
               ].filter(Boolean);
               phaseSection.push(theme.fg("dim", `    ${subLineParts.join(" · ")}`));

               const usage = formatUsage(agent.usage);
               if (usage) {
                  phaseSection.push(theme.fg("dim", `    usage: ${usage}`));
               }
               if (agent.error) {
                  phaseSection.push(theme.fg("error", `    error: ${agent.error}`));
               } else if (agent.preview) {
                  phaseSection.push(theme.fg("dim", "    preview:"));
                  for (const line of agent.preview.split("\n").slice(0, 4)) {
                     phaseSection.push(theme.fg("dim", `      ${line}`));
                  }
               }
            }
            sections.push(phaseSection);
         }

         if (details.error) {
            sections.push([theme.bold(theme.fg("error", "workflow error")), `  ${theme.fg("error", details.error)}`]);
         }

         if (details.result !== undefined) {
            const resultLines: string[] = [theme.bold("result")];
            const formattedJson = resultJson(details.result);
            for (const line of formattedJson.split("\n")) {
               resultLines.push(`  ${theme.fg("accent", line)}`);
            }
            sections.push(resultLines);
         }

         if (totals) {
            sections.push([theme.bold("usage"), `  ${theme.fg("dim", totals)}`]);
         }

         const text = formatCleanSections(sections, theme);
         container.addChild(new Text(text, 0, 0));
         return container;
      }
   });
}
