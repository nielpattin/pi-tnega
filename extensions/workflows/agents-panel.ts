/**
 * Fullscreen /agents panel.
 *
 * Single unified list (no section tabs):
 * - Regular agents with [built-in] / (override) tags.
 *
 * Detail & Edit Screen:
 * - Name, Enabled, Harness, Model, Thinking, Tools, Description, and System Prompt.
 * - Agents save to ~/.pi/agent/agents/<name>.md.
 */

import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { TextContent } from "@earendil-works/pi-ai";
import {
   deleteAgentProfile,
   listAgentProfiles,
   saveAgentProfile,
   type AgentHarness,
   type AgentProfile,
   type AgentThinkingLevel
} from "../shared/agent-profiles.ts";

type AgentDefinition = AgentProfile;
type HarnessName = AgentHarness;
type WorkflowAgentRuntime = unknown;

function runTool<T>(_runtime: WorkflowAgentRuntime, value: T | PromiseLike<T>): Promise<T> {
   return Promise.resolve(value);
}

const AgentProfilesStore = {
   use<A>(
      fn: (store: {
         listAgents: (cwd?: string) => ReadonlyArray<AgentProfile>;
         updateAgent: (agent: AgentProfile, cwd?: string) => AgentProfile;
      }) => A
   ): A {
      return fn({
         listAgents: (cwd) => listAgentProfiles(cwd),
         updateAgent: (agent, cwd) => ({ ...agent, filePath: saveAgentProfile(agent, { cwd }) })
      });
   }
};

const deleteAgentFromDisk = (agent: AgentDefinition | string, cwd?: string) => deleteAgentProfile(agent, { cwd });
const loadAllAgentsFromDisk = (cwd?: string) => listAgentProfiles(cwd);
const saveAgentToDisk = (agent: AgentDefinition, cwd?: string) => saveAgentProfile(agent, { cwd });

export type AgentsViewMode = "list" | "detail";
export type AgentDetailField = "name" | "enabled" | "harness" | "model" | "thinking" | "tools" | "description" | "body";
export type DetailField = AgentDetailField;

export interface AgentToolInfo {
   name: string;
   description?: string;
   promptSnippet?: string;
   promptGuidelines?: string[];
   source?: string;
}

export type ViewState =
   | "list"
   | "detail"
   | "create_name"
   | "create_intent"
   | "generating"
   | "select_model"
   | "select_thinking"
   | "select_tools";

export interface AgentsPanelOptions {
   initialViewModel?: AgentsPanelViewModel;
   getAllTools?: () => AgentToolInfo[];
   /** Called after the panel persists any agent change (toggle, edit, create). */
   onAgentsChanged?: () => void | Promise<void>;
}

/** Structured completion is supplied by the workflow runner when a schema is requested. */
export const PROFILE_LOCKED_TOOLS = new Set(["structured_output"]);
/** Workflow children must not recursively orchestrate or ask the parent questions. */
export const DISABLED_NESTED_TOOLS = new Set(["workflow", "ask_user"]);

export interface AgentsPanelViewModel {
   agents: AgentDefinition[];
}

export interface AgentsPanelState {
   selectedIndex: number;
   viewMode: AgentsViewMode;
   detailFieldIndex: number;
   isOpen: boolean;
}

export interface PanelKeyInput {
   key: string;
   shift?: boolean;
   alt?: boolean;
   ctrl?: boolean;
}

export type AgentsPanelIntent =
   | { type: "open_detail" }
   | { type: "close_detail" }
   | { type: "close_panel" }
   | { type: "toggle_enabled" }
   | { type: "cycle_harness" }
   | { type: "cycle_model"; direction: 1 | -1 }
   | { type: "cycle_thinking"; direction: 1 | -1 }
   | { type: "open_picker"; picker: "model" | "thinking" | "tools" }
   | { type: "edit_name" }
   | { type: "edit_description" }
   | { type: "edit_body" }
   | { type: "none" };

export const AGENT_DETAIL_FIELDS: AgentDetailField[] = [
   "name",
   "enabled",
   "harness",
   "model",
   "thinking",
   "tools",
   "description",
   "body"
];
const AGENT_FIELDS = AGENT_DETAIL_FIELDS;

const REASONING_EFFORTS = ["(inherit)", "low", "medium", "high", "xhigh", "max"];
const DESC_PANEL_MAX_LINES = 100;

export function buildAgentsPanelViewModel(params: { agents: ReadonlyArray<AgentDefinition> }): AgentsPanelViewModel {
   return { agents: [...params.agents] };
}

export function createAgentsPanelState(initial?: Partial<AgentsPanelState>): AgentsPanelState {
   return {
      selectedIndex: 0,
      viewMode: "list",
      detailFieldIndex: 0,
      isOpen: true,
      ...initial
   };
}

export function detailFieldsFor(agent?: AgentDefinition, harness?: HarnessName): readonly DetailField[] {
   const effectiveHarness = harness ?? agent?.harness ?? "pi";
   return effectiveHarness === "agy" ? ["name", "enabled", "harness", "model", "description", "body"] : AGENT_FIELDS;
}

function listItemCount(viewModel?: AgentsPanelViewModel): number {
   return viewModel?.agents.length ?? 0;
}

export function getSelectedDescription(state: AgentsPanelState, viewModel?: AgentsPanelViewModel): string | undefined {
   if (!viewModel) return undefined;
   return viewModel.agents[state.selectedIndex]?.description;
}

export function agentDisplayTags(agent: AgentDefinition): ReadonlyArray<"built-in" | "override"> {
   const tags: Array<"built-in" | "override"> = [];
   if (agent.source === "builtin") tags.push("built-in");
   if (agent.isOverride) tags.push("override");
   return tags;
}

export function renderAgentDescriptionPanel(
   description: string | undefined,
   width: number,
   theme: Theme,
   maxLines: number = DESC_PANEL_MAX_LINES
): string[] {
   const lines: string[] = [];
   lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
   lines.push(theme.fg("dim", "Description"));
   const desc = description?.trim() || "No description";
   const wrapped = wrapTextWithAnsi(desc, Math.max(1, width));
   for (const line of wrapped.slice(0, maxLines)) {
      lines.push(theme.fg("muted", line));
   }
   return lines;
}

function padLine(text: string, width: number): string {
   const w = Math.max(0, width);
   const visible = visibleWidth(text);
   if (visible >= w) return text;
   return text + " ".repeat(w - visible);
}

function configuredKeys(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
   return keybindings.getKeys(binding).join("/") || "unbound";
}

function cycleValue(values: readonly string[], current: string | undefined, direction: 1 | -1): string {
   const normalized = current?.trim() || values[0];
   let idx = values.indexOf(normalized);
   if (idx < 0) idx = 0;
   const next = (idx + direction + values.length) % values.length;
   return values[next];
}

export function reduceAgentsPanelKey(
   state: AgentsPanelState,
   input: PanelKeyInput,
   viewModel?: AgentsPanelViewModel
): { state: AgentsPanelState; intent: AgentsPanelIntent } {
   const key = input.key.toLowerCase();
   const selected = viewModel?.agents[state.selectedIndex];
   const fields = detailFieldsFor(selected, selected?.harness);
   const safeFieldIndex = Math.min(state.detailFieldIndex, Math.max(0, fields.length - 1));

   if (state.viewMode === "detail") {
      if (key === "escape" || key === "q" || key === "backspace") {
         return {
            state: { ...state, viewMode: "list", detailFieldIndex: 0 },
            intent: { type: "close_detail" }
         };
      }
      if (key === "up" || key === "k") {
         const nextIdx = (safeFieldIndex - 1 + fields.length) % fields.length;
         return {
            state: { ...state, detailFieldIndex: nextIdx },
            intent: { type: "none" }
         };
      }
      if (key === "down" || key === "j") {
         const nextIdx = (safeFieldIndex + 1) % fields.length;
         return {
            state: { ...state, detailFieldIndex: nextIdx },
            intent: { type: "none" }
         };
      }

      const field = fields[safeFieldIndex] ?? fields[0];
      if (key === " " || key === "space" || key === "enter") {
         if (field === "name")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "edit_name" } };
         if (field === "enabled")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "toggle_enabled" } };
         if (field === "harness")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "cycle_harness" } };
         if (field === "model")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "open_picker", picker: "model" }
            };
         if (field === "thinking")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "open_picker", picker: "thinking" }
            };
         if (field === "tools")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "open_picker", picker: "tools" }
            };
         if (field === "description")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "edit_description" } };
         if (field === "body")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "edit_body" } };
         return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "none" } };
      }
      if (key === "right" || key === "l") {
         if (field === "harness")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "cycle_harness" } };
         if (field === "model")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "cycle_model", direction: 1 }
            };
         if (field === "thinking")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "cycle_thinking", direction: 1 }
            };
         if (field === "enabled")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "toggle_enabled" } };
         return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "none" } };
      }
      if (key === "left" || key === "h") {
         if (field === "harness")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "cycle_harness" } };
         if (field === "model")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "cycle_model", direction: -1 }
            };
         if (field === "thinking")
            return {
               state: { ...state, detailFieldIndex: safeFieldIndex },
               intent: { type: "cycle_thinking", direction: -1 }
            };
         if (field === "enabled")
            return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "toggle_enabled" } };
         return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "none" } };
      }
      return { state: { ...state, detailFieldIndex: safeFieldIndex }, intent: { type: "none" } };
   }

   if (key === "escape" || key === "q") {
      return { state: { ...state, isOpen: false }, intent: { type: "close_panel" } };
   }

   // Single list: left/right no longer switch sections
   if (key === "tab" || key === "right" || key === "l" || key === "left" || key === "h") {
      return { state, intent: { type: "none" } };
   }

   if (key === "down" || key === "j") {
      const maxCount = listItemCount(viewModel);
      const nextIdx = maxCount > 0 ? (state.selectedIndex + 1) % maxCount : 0;
      return { state: { ...state, selectedIndex: nextIdx }, intent: { type: "none" } };
   }

   if (key === "up" || key === "k") {
      const maxCount = listItemCount(viewModel);
      const nextIdx = maxCount > 0 ? (state.selectedIndex - 1 + maxCount) % maxCount : 0;
      return {
         state: { ...state, selectedIndex: nextIdx },
         intent: { type: "none" }
      };
   }

   if (key === "enter") {
      const maxCount = listItemCount(viewModel);
      if (maxCount === 0) return { state, intent: { type: "none" } };
      return {
         state: { ...state, viewMode: "detail", detailFieldIndex: 0 },
         intent: { type: "open_detail" }
      };
   }

   return { state, intent: { type: "none" } };
}

export class BodyEditor {
   private value: string = "";
   private cursorIndex: number = 0;

   setValue(val: string): void {
      this.value = val;
      this.cursorIndex = val.length;
   }

   getValue(): string {
      return this.value;
   }

   getCursorIndex(): number {
      return this.cursorIndex;
   }

   moveCursorVertical(delta: 1 | -1): void {
      const lines = this.value.split("\n");
      let lineIdx = 0;
      let colIdx = 0;
      let pos = 0;

      for (let i = 0; i < lines.length; i++) {
         const len = lines[i].length;
         if (pos + len >= this.cursorIndex) {
            lineIdx = i;
            colIdx = this.cursorIndex - pos;
            break;
         }
         pos += len + 1;
      }

      const targetLine = lineIdx + delta;
      if (targetLine < 0 || targetLine >= lines.length) return;

      const targetCol = Math.min(lines[targetLine].length, colIdx);
      let newPos = 0;
      for (let i = 0; i < targetLine; i++) {
         newPos += lines[i].length + 1;
      }
      this.cursorIndex = newPos + targetCol;
   }

   handleInput(data: string): void {
      if (!data) return;
      if (data === "\r" || data === "\n") {
         this.insertText("\n");
         return;
      }
      if (data === "\x7f" || data === "\x08") {
         if (this.cursorIndex > 0) {
            this.value = this.value.slice(0, this.cursorIndex - 1) + this.value.slice(this.cursorIndex);
            this.cursorIndex--;
         }
         return;
      }
      if (data === "\x1b[A") {
         this.moveCursorVertical(-1);
         return;
      }
      if (data === "\x1b[B") {
         this.moveCursorVertical(1);
         return;
      }
      if (data === "\x1b[D") {
         if (this.cursorIndex > 0) this.cursorIndex--;
         return;
      }
      if (data === "\x1b[C") {
         if (this.cursorIndex < this.value.length) this.cursorIndex++;
         return;
      }
      if (data.startsWith("\x1b")) return;
      this.insertText(data);
   }

   private insertText(text: string): void {
      this.value = this.value.slice(0, this.cursorIndex) + text + this.value.slice(this.cursorIndex);
      this.cursorIndex += text.length;
   }
}

export class FullScreenAgentsManager implements Component, Focusable {
   private state: AgentsPanelState;
   private viewState: ViewState = "list";
   private closed = false;
   private _focused = false;
   private ticker: ReturnType<typeof setInterval>;
   private viewModel?: AgentsPanelViewModel;

   private isEditingText = false;
   private textInput = new Input();

   private isEditingBody = false;
   private systemPromptEditor = new BodyEditor();
   private initialBodyValue: string = "";
   private initialAgentSnapshot: string = "";
   private pendingEscConfirm = false;
   private pendingDetailEscConfirm = false;
   private systemPromptScrollOffset = 0;
   private editorScrollOffset = 0;

   private createNameInput = new Input();
   private createIntentInput = new Input();
   private newName = "";
   private newIntent = "";
   private statusMessage = "";

   private selectorFilterInput = new Input();
   private selectorSelectedIndex = 0;
   private toolDetailScrollOffset = 0;
   private tempSelectedTools: string[] = [];

   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      this.textInput.focused = value;
      this.createNameInput.focused = value;
      this.createIntentInput.focused = value;
      this.selectorFilterInput.focused = value;
   }

   constructor(
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private runtime: WorkflowAgentRuntime,
      private done: (value: null) => void,
      initialState?: Partial<AgentsPanelState>,
      private ctx?: ExtensionCommandContext,
      private options?: AgentsPanelOptions
   ) {
      this.state = createAgentsPanelState(initialState);
      if (options?.initialViewModel) {
         this.viewModel = options.initialViewModel;
      }
      this.textInput.onSubmit = (val) => void this.commitTextEdit(val);

      this.createNameInput.onSubmit = (val) => {
         const clean = val
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "");
         if (!clean) {
            this.statusMessage = "Invalid agent name. Use lowercase alphanumeric, dash, or underscore.";
            this.tui.requestRender();
            return;
         }
         this.newName = clean;
         this.viewState = "create_intent";
         this.createIntentInput.setValue("");
         this.createIntentInput.focused = true;
         this.statusMessage = "";
         this.tui.requestRender();
      };

      this.createIntentInput.onSubmit = async (val) => {
         this.newIntent = val.trim();
         this.viewState = "generating";
         this.statusMessage = "Generating agent definition draft with model...";
         this.tui.requestRender();
         await this.generateAndOpenDraft();
      };

      if (!this.viewModel) {
         const cwd = this.ctx?.cwd;
         const initialAgents = loadAllAgentsFromDisk(cwd);
         this.viewModel = buildAgentsPanelViewModel({ agents: initialAgents });
      }

      this.ticker = setInterval(() => {
         void this.refreshData();
      }, 1000);
      void this.refreshData();
   }

   private async generateAndOpenDraft() {
      let generatedFields: any = null;
      let generationFailed = false;

      if (this.ctx?.model) {
         try {
            const systemPrompt =
               "You are an expert AI subagent designer. Return a JSON object with description, guidance, and body.";
            const userPrompt = `Create subagent definition for: Name="${this.newName}", Intent="${this.newIntent}". Return JSON ONLY.`;
            const auth = await this.ctx.modelRegistry?.getApiKeyAndHeaders?.(this.ctx.model);
            const apiKey = auth?.ok ? auth.apiKey : undefined;
            const headers = auth?.ok ? auth.headers : undefined;

            const response = await completeSimple(
               this.ctx.model,
               {
                  systemPrompt,
                  messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }]
               },
               { apiKey, headers }
            );

            let responseText = "";
            if (response && response.content) {
               const textBlocks = response.content.filter((c): c is TextContent => c.type === "text");
               responseText = textBlocks.map((b) => b.text).join("");
            }
            generatedFields = JSON.parse(responseText.replace(/```json\n?|\n?```/g, "").trim());
         } catch {
            generationFailed = true;
         }
      } else {
         generationFailed = true;
      }

      const fallbackBody = `# ${this.newName.toUpperCase()} PROFILE\n\nSpecialized profile for: ${this.newIntent || "custom agent work"}.\n\n## Role\nExecute the assigned profile task according to its intent.\n\n## Constraints\n- Follow the profile instructions strictly.`;

      const newAgent: AgentDefinition = {
         name: this.newName,
         description: generatedFields?.description || this.newIntent || "Custom agent",
         guidance: generatedFields?.guidance || `Use for ${this.newIntent || "custom agent work"}.`,
         harness: "pi",
         tools: ["read", "grep", "find"],
         enabled: true,
         source: "global",
         systemPrompt: generatedFields?.body || fallbackBody
      };

      const cwd = this.ctx?.cwd;
      saveAgentToDisk(newAgent, cwd);
      await runTool(
         this.runtime,
         AgentProfilesStore.use((s) => s.updateAgent(newAgent, cwd))
      ).catch(() => {});
      void this.options?.onAgentsChanged?.();
      await this.refreshData();

      this.state.selectedIndex = Math.max(0, (this.viewModel?.agents.length ?? 1) - 1);
      this.state.viewMode = "detail";
      this.state.detailFieldIndex = 0;
      this.viewState = "detail";
      this.initialAgentSnapshot = JSON.stringify(this.currentAgent());
      this.statusMessage = generationFailed ? "Draft created!" : "AI Draft generated & saved!";
      this.tui.requestRender();
   }

   private async refreshData() {
      if (this.closed) return;
      if (this.options?.initialViewModel && !this.ctx) return;
      try {
         const cwd = this.ctx?.cwd;
         const agents = await runTool(
            this.runtime,
            AgentProfilesStore.use((s) => s.listAgents(cwd))
         );
         if (this.state.viewMode === "detail" && this.viewModel) {
            const editingIdx = this.state.selectedIndex;
            const currentEditAgent = this.viewModel.agents[editingIdx];
            if (currentEditAgent) {
               const nextVm = buildAgentsPanelViewModel({ agents });
               // Preserve in-progress edits for the selected row.
               const sameNameIdx = nextVm.agents.findIndex((a) => a.name === currentEditAgent.name);
               if (sameNameIdx >= 0) nextVm.agents[sameNameIdx] = currentEditAgent;
               this.viewModel = nextVm;
               this.tui.requestRender();
               return;
            }
         }

         this.viewModel = buildAgentsPanelViewModel({ agents });
         this.tui.requestRender();
      } catch {}
   }

   private cleanup() {
      if (this.closed) return false;
      this.closed = true;
      clearInterval(this.ticker);
      return true;
   }

   private close() {
      if (this.cleanup()) this.done(null);
   }

   dispose(): void {
      this.cleanup();
   }

   private currentAgent(): AgentDefinition | undefined {
      return this.viewModel?.agents[this.state.selectedIndex];
   }

   private currentHarness(): HarnessName {
      return this.currentAgent()?.harness ?? "pi";
   }

   private getAvailableTools(): AgentToolInfo[] {
      const list: AgentToolInfo[] = [];

      const addTool = (
         name?: string,
         description?: string,
         promptSnippet?: string,
         promptGuidelines?: string[],
         source?: string
      ) => {
         if (!name || typeof name !== "string") return;
         const existing = list.find((t) => t.name === name);
         if (!existing) {
            list.push({
               name,
               description: typeof description === "string" ? description : undefined,
               promptSnippet: typeof promptSnippet === "string" ? promptSnippet : undefined,
               promptGuidelines: Array.isArray(promptGuidelines) ? promptGuidelines : undefined,
               source: typeof source === "string" ? source : undefined
            });
         } else {
            if (!existing.description && typeof description === "string") existing.description = description;
            if (!existing.promptSnippet && typeof promptSnippet === "string") existing.promptSnippet = promptSnippet;
            if (!existing.promptGuidelines && Array.isArray(promptGuidelines))
               existing.promptGuidelines = promptGuidelines;
            if (!existing.source && typeof source === "string") existing.source = source;
         }
      };

      // 0. Discover tools from options callback if provided
      if (this.options?.getAllTools) {
         try {
            const rawTools = this.options.getAllTools();
            for (const t of rawTools) {
               addTool(t.name, t.description, t.promptSnippet, t.promptGuidelines, t.source);
            }
         } catch {}
      }

      // 1. Discover tools dynamically from WorkflowAgentRuntime, ExtensionCommandContext & Registries
      if (this.runtime && typeof (this.runtime as any).getAllTools === "function") {
         try {
            const all = (this.runtime as any).getAllTools();
            if (Array.isArray(all)) {
               for (const t of all) {
                  if (typeof t === "string") addTool(t);
                  else if (t && typeof t === "object") {
                     addTool(
                        t.name,
                        t.description,
                        t.promptSnippet,
                        t.promptGuidelines,
                        t.sourceInfo?.path ?? t.sourceInfo?.source ?? t.source
                     );
                  }
               }
            }
         } catch {}
      }

      if (this.ctx) {
         try {
            const ctxAny = this.ctx as any;
            const getAllToolsFn = ctxAny.getAllTools ?? ctxAny.pi?.getAllTools;
            if (typeof getAllToolsFn === "function") {
               const all = getAllToolsFn.call(ctxAny);
               if (Array.isArray(all)) {
                  for (const t of all) {
                     if (typeof t === "string") addTool(t);
                     else if (t && typeof t === "object") {
                        addTool(
                           t.name,
                           t.description,
                           t.promptSnippet,
                           t.promptGuidelines,
                           t.sourceInfo?.path ?? t.sourceInfo?.source ?? t.source
                        );
                     }
                  }
               }
            }

            const rawTools = typeof ctxAny.getTools === "function" ? ctxAny.getTools() : ctxAny.tools;
            if (Array.isArray(rawTools)) {
               for (const t of rawTools) {
                  if (typeof t === "string") addTool(t);
                  else if (t && typeof t === "object") {
                     addTool(
                        t.name,
                        t.description,
                        t.promptSnippet,
                        t.promptGuidelines,
                        t.sourceInfo?.path ?? t.sourceInfo?.source ?? t.source
                     );
                  }
               }
            } else if (rawTools && typeof rawTools === "object") {
               for (const [name, t] of Object.entries(rawTools)) {
                  const tAny = t as any;
                  addTool(
                     name,
                     tAny?.description,
                     tAny?.promptSnippet,
                     tAny?.promptGuidelines,
                     tAny?.sourceInfo?.path ?? tAny?.sourceInfo?.source ?? tAny?.source
                  );
               }
            }

            if (ctxAny.toolRegistry) {
               const reg = ctxAny.toolRegistry;
               const regTools =
                  typeof reg.getAll === "function"
                     ? reg.getAll()
                     : typeof reg.getTools === "function"
                       ? reg.getTools()
                       : Array.isArray(reg.tools)
                         ? reg.tools
                         : [];
               for (const t of regTools) {
                  if (typeof t === "string") addTool(t);
                  else if (t && typeof t === "object") {
                     addTool(
                        t.name,
                        t.description,
                        t.promptSnippet,
                        t.promptGuidelines,
                        t.sourceInfo?.path ?? t.sourceInfo?.source ?? t.source
                     );
                  }
               }
            }
         } catch {}
      }

      // 2. Baseline built-in tool metadata so built-in tools always have descriptive info
      const BASELINE_TOOLS: Array<{
         name: string;
         description?: string;
         promptSnippet?: string;
         promptGuidelines?: string[];
      }> = [
         {
            name: "read",
            description: "Read file contents from workspace directory.",
            promptSnippet: "Read file contents"
         },
         {
            name: "write",
            description: "Create or overwrite file content.",
            promptSnippet: "Create/replace file content"
         },
         {
            name: "edit",
            description: "Perform exact search-and-replace edits on existing files.",
            promptSnippet: "Exact text replacement"
         },
         {
            name: "grep",
            description: "Search file contents using quick ripgrep pattern matching.",
            promptSnippet: "Ripgrep search"
         },
         {
            name: "find",
            description: "Locate files matching glob or name patterns.",
            promptSnippet: "Find files by pattern"
         },
         {
            name: "bash",
            description: "Execute terminal commands in workspace shell.",
            promptSnippet: "Execute bash commands"
         },
         {
            name: "workflow",
            description: "Run a multi-agent workflow. Disabled inside workflow children.",
            promptSnippet: "Workflow orchestration"
         },
         {
            name: "ask_user",
            description: "Ask the parent user a question. Disabled inside workflow children.",
            promptSnippet: "Interactive question"
         },
         {
            name: "process_start",
            description: "Start a long-running process job.",
            promptSnippet: "Start process job"
         },
         {
            name: "process_list",
            description: "List all long-running process jobs.",
            promptSnippet: "List processes"
         },
         {
            name: "process_snapshot",
            description: "Read process status and recent logs.",
            promptSnippet: "Read process snapshot"
         },
         {
            name: "process_restart",
            description: "Restart a process job.",
            promptSnippet: "Restart process job"
         },
         {
            name: "process_stop",
            description: "Stop a long-running process job.",
            promptSnippet: "Stop process"
         },
         {
            name: "structured_output",
            description: "Return the final structured workflow result when a schema is supplied.",
            promptSnippet: "Return structured workflow result"
         },
         {
            name: "web_search_exa",
            description: "Search the web using Exa AI search.",
            promptSnippet: "Web search engine"
         },
         {
            name: "web_fetch_exa",
            description: "Fetch text content from web URLs.",
            promptSnippet: "Fetch web URL content"
         }
      ];
      for (const toolDef of BASELINE_TOOLS) {
         addTool(toolDef.name, toolDef.description, toolDef.promptSnippet, toolDef.promptGuidelines);
      }

      // 3. Include any configured tools across all agents
      const vm = this.viewModel;
      if (vm) {
         for (const agent of vm.agents) {
            if (agent.tools) {
               for (const name of agent.tools) {
                  addTool(name);
               }
            }
         }
      }

      return list;
   }

   private getAvailableModels(): string[] {
      const harness = this.currentHarness();
      if (harness === "agy") {
         return [
            "gemini-3.6-flash-high",
            "gemini-3.6-flash-medium",
            "gemini-3.6-flash-low",
            "gemini-3.5-flash-high",
            "gemini-3.5-flash-medium",
            "gemini-3.5-flash-low",
            "gemini-3.1-pro-high",
            "gemini-3.1-pro-low",
            "claude-sonnet-4-6",
            "claude-opus-4-6-thinking"
         ];
      }

      const options: string[] = ["(inherit)"];
      if (this.ctx?.modelRegistry) {
         try {
            const registered = (this.ctx.modelRegistry.getAvailable?.() ?? []) as any[];
            for (const m of registered) {
               if (typeof m === "string") {
                  if (!options.includes(m)) options.push(m);
               } else if (m && typeof m === "object") {
                  const provider = m.provider ?? m.providerId;
                  const id = m.id ?? m.name;
                  if (provider && id) {
                     const fullId = String(id).startsWith(`${provider}/`) ? String(id) : `${provider}/${id}`;
                     if (!options.includes(fullId)) options.push(fullId);
                  } else if (id) {
                     const strId = String(id);
                     if (!options.includes(strId)) options.push(strId);
                  }
               }
            }
         } catch {}
      }
      return options;
   }

   private openPicker(picker: "model" | "thinking" | "tools") {
      this.selectorFilterInput.setValue("");
      this.selectorFilterInput.focused = true;
      this.selectorSelectedIndex = 0;

      if (picker === "model") this.viewState = "select_model";
      else if (picker === "thinking") this.viewState = "select_thinking";
      else if (picker === "tools") {
         this.viewState = "select_tools";
         const agent = this.currentAgent();
         const baseSelected = (agent?.tools ? [...agent.tools] : []).filter((t) => !DISABLED_NESTED_TOOLS.has(t));
         for (const locked of PROFILE_LOCKED_TOOLS) {
            if (!baseSelected.includes(locked)) baseSelected.push(locked);
         }
         this.tempSelectedTools = baseSelected;
      }
      this.tui.requestRender();
   }

   private startTextEdit(field: "name" | "description" | "body") {
      const agent = this.currentAgent();
      if (field === "body") {
         this.isEditingBody = true;
         this.pendingEscConfirm = false;
         this.editorScrollOffset = 0;
         this.initialBodyValue = agent?.systemPrompt || "";
         this.systemPromptEditor.setValue(agent?.systemPrompt || "");
         this.tui.requestRender();
         return;
      }

      const val = field === "name" ? (agent?.name ?? "") : (agent?.description ?? "");
      this.isEditingText = true;
      this.textInput.setValue(val);
      this.textInput.focused = true;
      this.tui.requestRender();
   }

   private async commitTextEdit(val: string) {
      const v = val.trim();
      this.isEditingText = false;
      const cwd = this.ctx?.cwd;

      const agent = this.currentAgent();
      if (!agent) return;
      const fields = detailFieldsFor(agent, this.currentHarness());
      const field = fields[this.state.detailFieldIndex];
      let patch: Partial<AgentDefinition> = {};

      if (field === "name") {
         const cleanName = v.toLowerCase().replace(/[^a-z0-9_-]/g, "");
         if (cleanName && cleanName !== agent.name) {
            deleteAgentFromDisk(agent, cwd);
            patch = { name: cleanName };
         }
      } else if (field === "description") {
         patch = { description: v };
      }

      if (Object.keys(patch).length === 0) return;
      const nextAgent: AgentDefinition = { ...agent, ...patch };

      if (this.viewModel?.agents[this.state.selectedIndex]) {
         this.viewModel.agents[this.state.selectedIndex] = nextAgent;
      }
      this.tui.requestRender();
   }

   private async saveDetailChanges() {
      const cwd = this.ctx?.cwd;
      const agent = this.currentAgent();
      if (!agent) return;

      const agentToSave: AgentDefinition = {
         ...agent,
         scope: "global",
         scopes: ["global"],
         isOverride: agent.source === "builtin" ? true : agent.isOverride
      };

      const filePath = saveAgentToDisk(agentToSave, cwd);
      const updatedAgent: AgentDefinition = {
         ...agentToSave,
         filePath
      };

      if (this.viewModel?.agents[this.state.selectedIndex]) {
         this.viewModel.agents[this.state.selectedIndex] = updatedAgent;
      }

      await runTool(
         this.runtime,
         AgentProfilesStore.use((s) => s.updateAgent(updatedAgent, cwd))
      ).catch(() => {});
      this.initialAgentSnapshot = JSON.stringify(updatedAgent);
      this.pendingDetailEscConfirm = false;
      const saveMessage =
         updatedAgent.harness === "agy"
            ? `Saved ${updatedAgent.name} to ${filePath} and linked its Agy agent`
            : `Saved ${updatedAgent.name} to ${filePath}`;
      this.statusMessage = saveMessage;
      if (this.ctx?.hasUI) {
         try {
            this.ctx.ui.notify(saveMessage, "info");
         } catch {}
      }
      void this.options?.onAgentsChanged?.();
      this.tui.requestRender();
   }

   private async saveBodyEdit() {
      const v = this.systemPromptEditor.getValue();
      // Stay in editor upon save!
      this.initialBodyValue = v;
      this.pendingEscConfirm = false;
      const cwd = this.ctx?.cwd;

      const agent = this.currentAgent();
      if (!agent) return;

      const nextAgent: AgentDefinition = {
         ...agent,
         systemPrompt: v,
         scope: "global",
         scopes: ["global"],
         isOverride: agent.source === "builtin" ? true : agent.isOverride
      };

      const filePath = saveAgentToDisk(nextAgent, cwd);
      const updatedAgent: AgentDefinition = { ...nextAgent, filePath };
      if (this.viewModel?.agents[this.state.selectedIndex]) {
         this.viewModel.agents[this.state.selectedIndex] = updatedAgent;
      }
      await runTool(
         this.runtime,
         AgentProfilesStore.use((s) => s.updateAgent(updatedAgent, cwd))
      ).catch(() => {});
      void this.options?.onAgentsChanged?.();
      const saveMessage =
         updatedAgent.harness === "agy"
            ? `Saved ${updatedAgent.name} to ${filePath} and linked its Agy agent`
            : `Saved ${updatedAgent.name} to ${filePath}`;
      this.statusMessage = saveMessage;
      if (this.ctx?.hasUI) {
         try {
            this.ctx.ui.notify(saveMessage, "info");
         } catch {}
      }
      this.tui.requestRender();
   }

   private async applyIntent(intent: AgentsPanelIntent) {
      if (intent.type === "open_picker") {
         this.openPicker(intent.picker);
         return;
      }
      if (intent.type === "edit_name") {
         this.startTextEdit("name");
         return;
      }
      if (intent.type === "edit_description") {
         this.startTextEdit("description");
         return;
      }
      if (intent.type === "edit_body") {
         this.startTextEdit("body");
         return;
      }

      if (intent.type === "none") return;

      if (intent.type === "open_detail") {
         this.initialAgentSnapshot = JSON.stringify(this.currentAgent());
         this.pendingDetailEscConfirm = false;
         return;
      }

      if (intent.type === "close_detail" || intent.type === "close_panel") return;

      const agent = this.currentAgent();
      if (!agent) return;
      let patch: Partial<AgentDefinition> = {};

      if (intent.type === "toggle_enabled") {
         patch = { enabled: !agent.enabled };
      } else if (intent.type === "cycle_harness") {
         patch = { harness: agent.harness === "pi" ? "agy" : "pi" };
      } else if (intent.type === "cycle_model") {
         const models = this.getAvailableModels();
         const model = cycleValue(models, agent.model, intent.direction);
         patch = { model: model || undefined };
      } else if (intent.type === "cycle_thinking") {
         const thinking = cycleValue(REASONING_EFFORTS, agent.thinking, intent.direction);
         patch = { thinking: thinking ? (thinking as AgentThinkingLevel) : undefined };
      }
      if (Object.keys(patch).length === 0) return;
      const nextAgent: AgentDefinition = { ...agent, ...patch };

      if (this.viewModel?.agents[this.state.selectedIndex]) {
         this.viewModel.agents[this.state.selectedIndex] = nextAgent;
      }
      this.tui.requestRender();
   }

   handleInput(data: string): void {
      if (
         this.viewState === "select_model" ||
         this.viewState === "select_thinking" ||
         this.viewState === "select_tools"
      ) {
         this.handlePickerInput(data);
         return;
      }

      if (this.viewState === "create_name") {
         if (data === "\x1b") {
            this.viewState = "list";
            this.tui.requestRender();
            return;
         }
         this.createNameInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.viewState === "create_intent") {
         if (data === "\x1b") {
            this.viewState = "list";
            this.tui.requestRender();
            return;
         }
         this.createIntentInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.isEditingBody) {
         const isDirty = this.systemPromptEditor.getValue() !== this.initialBodyValue;

         if (data === "\x1b") {
            if (isDirty && !this.pendingEscConfirm) {
               this.pendingEscConfirm = true;
               this.tui.requestRender();
               return;
            }
            this.isEditingBody = false;
            this.pendingEscConfirm = false;
            this.tui.requestRender();
            return;
         }

         this.pendingEscConfirm = false;

         if (data === "\x13") {
            void this.saveBodyEdit();
            return;
         }
         this.systemPromptEditor.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.isEditingText) {
         if (data === "\r" || data === "\n" || data === "\x13") {
            const textVal = this.textInput.getValue();
            void this.commitTextEdit(textVal);
            this.isEditingText = false;
            void this.saveDetailChanges();
            this.tui.requestRender();
            return;
         }
         let key = data.toLowerCase();
         if (data === "\u001b") key = "escape";
         if (key === "escape") {
            this.isEditingText = false;
            this.tui.requestRender();
            return;
         }
         this.textInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.state.viewMode === "detail") {
         const isDirtyDetail = Boolean(
            this.initialAgentSnapshot && JSON.stringify(this.currentAgent()) !== this.initialAgentSnapshot
         );

         if (data === "\x13" || data.toLowerCase() === "s") {
            void this.saveDetailChanges();
            return;
         }

         if (data === "\x1b" || data.toLowerCase() === "q" || data === "\x7f" || data === "\x08") {
            if (isDirtyDetail && !this.pendingDetailEscConfirm) {
               this.pendingDetailEscConfirm = true;
               this.tui.requestRender();
               return;
            }
            if (isDirtyDetail && this.pendingDetailEscConfirm) {
               // Revert agent changes if discarding
               if (this.initialAgentSnapshot && this.viewModel) {
                  try {
                     const original = JSON.parse(this.initialAgentSnapshot);
                     if (this.viewModel.agents[this.state.selectedIndex]) {
                        this.viewModel.agents[this.state.selectedIndex] = original;
                     }
                  } catch {}
               }
            }
            this.state.viewMode = "list";
            this.state.detailFieldIndex = 0;
            this.pendingDetailEscConfirm = false;
            this.tui.requestRender();
            return;
         }

         this.pendingDetailEscConfirm = false;
      }

      if (this.state.viewMode === "list") {
         if (data === "n") {
            this.viewState = "create_name";
            this.createNameInput.setValue("");
            this.createNameInput.focused = true;
            this.statusMessage = "";
            this.tui.requestRender();
            return;
         }
         if (data === "d") {
            const agent = this.currentAgent();
            if (agent) {
               deleteAgentFromDisk(agent, this.ctx?.cwd);
               void this.refreshData();
            }
            return;
         }
         if (data === "e" && this.state.viewMode === "list") {
            const res = reduceAgentsPanelKey(this.state, { key: "enter" }, this.viewModel);
            this.state = res.state;
            this.initialAgentSnapshot = JSON.stringify(this.currentAgent());
            this.pendingDetailEscConfirm = false;
            this.tui.requestRender();
            return;
         }
      }

      const fields = detailFieldsFor(this.currentAgent(), this.currentHarness());
      const safeIndex = Math.min(this.state.detailFieldIndex, fields.length - 1);
      const isBody = this.state.viewMode === "detail" && fields[safeIndex] === "body";

      if (isBody) {
         if (data === "\x1b[5~" || data === "\x15") {
            this.systemPromptScrollOffset = Math.max(0, this.systemPromptScrollOffset - 5);
            this.tui.requestRender();
            return;
         }
         if (data === "\x1b[6~" || data === "\x04") {
            this.systemPromptScrollOffset += 5;
            this.tui.requestRender();
            return;
         }
      }

      let key = data.toLowerCase();
      if (data === "\u001b") key = "escape";
      else if (data === "\r" || data === "\n") key = "enter";
      else if (data === "\t") key = "tab";
      else if (data === " ") key = "space";
      else if (data === "\u001b[A") key = "up";
      else if (data === "\u001b[B") key = "down";
      else if (data === "\u001b[C") key = "right";
      else if (data === "\u001b[D") key = "left";
      else if (data === "\u007f" || data === "\b") key = "backspace";

      const res = reduceAgentsPanelKey(this.state, { key }, this.viewModel);
      this.state = res.state;

      if (!this.state.isOpen) {
         this.close();
         return;
      }

      if (res.intent.type === "open_detail") {
         this.initialAgentSnapshot = JSON.stringify(this.currentAgent());
         this.pendingDetailEscConfirm = false;
      } else if (res.intent.type !== "none" && res.intent.type !== "close_detail") {
         void this.applyIntent(res.intent);
      }

      this.tui.requestRender();
   }

   private handlePickerInput(data: string) {
      const q = this.selectorFilterInput.getValue().toLowerCase();

      if (data === "\x1b") {
         this.viewState = "detail";
         this.tui.requestRender();
         return;
      }

      if (this.viewState === "select_tools") {
         const available = this.getAvailableTools();
         const filtered = available.filter(
            (t) => t.name.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q))
         );

         if (data === "\r" || data === "\n") {
            void this.commitToolsPicker();
            return;
         }
         if (data === "\x1b[A" || data === "k") {
            this.selectorSelectedIndex = Math.max(0, this.selectorSelectedIndex - 1);
            this.toolDetailScrollOffset = 0;
            this.tui.requestRender();
            return;
         }
         if (data === "\x1b[B" || data === "j") {
            this.selectorSelectedIndex = Math.min(Math.max(0, filtered.length - 1), this.selectorSelectedIndex + 1);
            this.toolDetailScrollOffset = 0;
            this.tui.requestRender();
            return;
         }
         if (
            data === "\x1b[5~" ||
            data === "\x1b[5;2~" ||
            data === "\x1b[5;5~" ||
            this.keybindings.matches(data, "tui.editor.pageUp")
         ) {
            this.toolDetailScrollOffset = Math.max(0, this.toolDetailScrollOffset - 3);
            this.tui.requestRender();
            return;
         }
         if (
            data === "\x1b[6~" ||
            data === "\x1b[6;2~" ||
            data === "\x1b[6;5~" ||
            this.keybindings.matches(data, "tui.editor.pageDown")
         ) {
            this.toolDetailScrollOffset += 3;
            this.tui.requestRender();
            return;
         }
         if (data === " ") {
            const tool = filtered[this.selectorSelectedIndex];
            if (tool) {
               if (PROFILE_LOCKED_TOOLS.has(tool.name) || DISABLED_NESTED_TOOLS.has(tool.name)) {
                  this.tui.requestRender();
                  return;
               }
               const idx = this.tempSelectedTools.indexOf(tool.name);
               if (idx >= 0) this.tempSelectedTools.splice(idx, 1);
               else this.tempSelectedTools.push(tool.name);
            }
            this.tui.requestRender();
            return;
         }
         if (data === "a" && !q) {
            this.tempSelectedTools = filtered.map((t) => t.name).filter((name) => !DISABLED_NESTED_TOOLS.has(name));
            for (const locked of PROFILE_LOCKED_TOOLS) {
               if (!this.tempSelectedTools.includes(locked)) this.tempSelectedTools.push(locked);
            }
            this.tui.requestRender();
            return;
         }
         if (data === "n" && !q) {
            this.tempSelectedTools = Array.from(PROFILE_LOCKED_TOOLS);
            this.tui.requestRender();
            return;
         }

         this.toolDetailScrollOffset = 0;
         this.selectorFilterInput.handleInput(data);
         this.tui.requestRender();
         return;
      }

      const options = this.viewState === "select_model" ? this.getAvailableModels() : REASONING_EFFORTS;
      const filtered = options.filter((o) => o.toLowerCase().includes(q));

      if (data === "\r" || data === "\n") {
         const selected = filtered[this.selectorSelectedIndex] ?? options[0];
         void this.commitSingleValuePicker(selected);
         return;
      }
      if (data === "\x1b[A" || data === "k") {
         this.selectorSelectedIndex = Math.max(0, this.selectorSelectedIndex - 1);
         this.tui.requestRender();
         return;
      }
      if (data === "\x1b[B" || data === "j") {
         this.selectorSelectedIndex = Math.min(Math.max(0, filtered.length - 1), this.selectorSelectedIndex + 1);
         this.tui.requestRender();
         return;
      }

      this.selectorFilterInput.handleInput(data);
      this.tui.requestRender();
   }

   private async commitSingleValuePicker(val: string) {
      const isModel = this.viewState === "select_model";
      const cleanVal = val.trim();
      this.viewState = "detail";

      const agent = this.currentAgent();
      if (!agent) return;
      const patch = isModel ? { model: cleanVal } : { thinking: cleanVal as AgentThinkingLevel };
      const nextAgent: AgentDefinition = { ...agent, ...patch };

      if (this.viewModel?.agents[this.state.selectedIndex]) {
         this.viewModel.agents[this.state.selectedIndex] = nextAgent;
      }
      this.tui.requestRender();
   }

   private async commitToolsPicker() {
      this.viewState = "detail";

      const agent = this.currentAgent();
      if (!agent) return;
      const nextAgent: AgentDefinition = { ...agent, tools: [...this.tempSelectedTools] };

      if (this.viewModel?.agents[this.state.selectedIndex]) {
         this.viewModel.agents[this.state.selectedIndex] = nextAgent;
      }
      this.tui.requestRender();
   }

   render(width: number): string[] {
      const theme = this.theme;
      const rows = this.tui.terminal.rows || 30;
      const targetRows = Math.max(8, rows - 1);

      if (this.viewState === "create_name") {
         return [
            theme.bold("Create New Agent (Step 1/2)"),
            "Enter agent name/identifier (lowercase alphanumeric, dash, underscore):",
            ...this.createNameInput.render(width),
            this.statusMessage ? theme.fg("error", this.statusMessage) : ""
         ];
      }
      if (this.viewState === "create_intent") {
         return [
            theme.bold(`Create New Agent: "${this.newName}" (Step 2/2)`),
            "Describe what this agent should do:",
            ...this.createIntentInput.render(width)
         ];
      }
      if (this.viewState === "generating") {
         return [theme.fg("accent", "Generating agent definition draft with model...")];
      }

      if (
         this.viewState === "select_model" ||
         this.viewState === "select_thinking" ||
         this.viewState === "select_tools"
      ) {
         return this.renderPickerOverlay(width, targetRows);
      }

      if (this.isEditingBody) {
         return this.renderBodyEditorOverlay(width, targetRows);
      }

      if (this.state.viewMode === "detail") {
         const detail = this.renderDetailScreen(width, targetRows);
         while (detail.length < targetRows) detail.push("");
         return detail.slice(0, targetRows);
      }

      const lines: string[] = [];
      const vm = this.viewModel;
      const headerLeft = theme.fg("accent", theme.bold("Workflow Agent Profiles"));
      const headerRight = theme.fg(
         "muted",
         vm ? `${vm.agents.length} agent${vm.agents.length === 1 ? "" : "s"}` : "loading"
      );
      const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
      lines.push(padLine(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));
      lines.push("");

      const rawListFooter = `${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · Enter detail · n new · d delete · Esc/q close`;
      const wrappedListFooter = wrapTextWithAnsi(rawListFooter, Math.max(1, width - 4));
      const footerLines = ["", ...wrappedListFooter.map((l) => padLine(theme.fg("dim", `  ${l.trimStart()}`), width))];

      const contentBudget = Math.max(4, targetRows - lines.length - footerLines.length);
      const desc = getSelectedDescription(this.state, this.viewModel);
      let panelBlock = renderAgentDescriptionPanel(desc, width, theme, DESC_PANEL_MAX_LINES);
      panelBlock = ["", ...panelBlock];
      if (panelBlock.length > contentBudget) {
         panelBlock = panelBlock.slice(0, contentBudget);
      }

      const listArea = Math.max(0, contentBudget - panelBlock.length);
      const listRows = this.renderListRows(width, listArea);
      const listSlice = listRows.slice(0, listArea);
      const padCount = Math.max(0, listArea - listSlice.length);

      const body: string[] = [...listSlice];
      for (let i = 0; i < padCount; i++) body.push("");
      body.push(...panelBlock);
      while (body.length < contentBudget) body.push("");

      const out = [...lines, ...body.slice(0, contentBudget), ...footerLines];
      while (out.length < targetRows) out.push("");
      return out.slice(0, targetRows);
   }

   private renderPickerOverlay(width: number, targetRows: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];
      const isTools = this.viewState === "select_tools";
      const isModel = this.viewState === "select_model";
      const title = isTools ? "Select Tools" : isModel ? "Select Model" : "Select Thinking";

      lines.push(padLine(theme.fg("accent", theme.bold(`Popup Picker · ${title}`)), width));
      lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
      lines.push(`Filter: ${this.selectorFilterInput.render(Math.max(1, width - 10))[0] ?? ""}`);
      lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

      const q = this.selectorFilterInput.getValue().toLowerCase();

      if (isTools) {
         const available = this.getAvailableTools();
         const filtered = available.filter(
            (t) => t.name.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q))
         );
         this.selectorSelectedIndex = Math.max(
            0,
            Math.min(this.selectorSelectedIndex, Math.max(0, filtered.length - 1))
         );

         // 1. Build detail body lines array
         const selectedTool = filtered[this.selectorSelectedIndex];
         const detailBodyLines: string[] = [];
         if (selectedTool) {
            if (selectedTool.description) {
               const label = theme.fg("accent", theme.bold("desc: "));
               const text = theme.fg("muted", selectedTool.description);
               const wrappedDesc = wrapTextWithAnsi(`${label}${text}`, Math.max(1, width - 2));
               for (const l of wrappedDesc) {
                  detailBodyLines.push(padLine(l, width));
               }
            }
            if (selectedTool.promptGuidelines && selectedTool.promptGuidelines.length > 0) {
               detailBodyLines.push(padLine(theme.fg("accent", theme.bold("guidelines:")), width));
               for (const g of selectedTool.promptGuidelines) {
                  const wrappedG = wrapTextWithAnsi(`  · ${g}`, Math.max(1, width - 2));
                  for (const l of wrappedG) {
                     detailBodyLines.push(padLine(theme.fg("muted", l), width));
                  }
               }
            }
            if (selectedTool.source) {
               const label = theme.fg("accent", theme.bold("source: "));
               const text = theme.fg("muted", selectedTool.source);
               const wrappedSource = wrapTextWithAnsi(`${label}${text}`, Math.max(1, width - 2));
               for (const l of wrappedSource) {
                  detailBodyLines.push(padLine(l, width));
               }
            }
            if (
               !selectedTool.description &&
               (!selectedTool.promptGuidelines || selectedTool.promptGuidelines.length === 0) &&
               !selectedTool.source
            ) {
               detailBodyLines.push(padLine(theme.fg("dim", "(no metadata)"), width));
            }
         }

         // 2. Cap detail pane body height to MAX 40% of targetRows
         const maxDetailBodyHeight = Math.max(1, Math.floor(targetRows * 0.4) - 1);
         const totalBodyLines = detailBodyLines.length;

         // Clamp detail scroll offset
         const maxScroll = Math.max(0, totalBodyLines - maxDetailBodyHeight);
         this.toolDetailScrollOffset = Math.max(0, Math.min(this.toolDetailScrollOffset, maxScroll));

         const visibleDetailSlice = detailBodyLines.slice(
            this.toolDetailScrollOffset,
            this.toolDetailScrollOffset + maxDetailBodyHeight
         );

         // Render divider line with scroll indicator if scrollable
         let dividerStr = "─".repeat(Math.max(1, width));
         if (totalBodyLines > maxDetailBodyHeight) {
            const pageStr = ` [detail ${this.toolDetailScrollOffset + 1}-${Math.min(totalBodyLines, this.toolDetailScrollOffset + visibleDetailSlice.length)} of ${totalBodyLines} · PgUp/PgDn] `;
            const padLen = Math.max(0, width - visibleWidth(pageStr));
            dividerStr =
               "─".repeat(Math.floor(padLen / 2)) + theme.fg("dim", pageStr) + "─".repeat(Math.ceil(padLen / 2));
         }

         const detailLines = [dividerStr, ...visibleDetailSlice];

         // 3. Dynamically allocate list visibility budget based on detail pane size
         const HEADER_RESERVED = 4;
         const FOOTER_RESERVED = 2; // 1 spacer + 1 footer line
         const maxVis = Math.max(1, targetRows - HEADER_RESERVED - FOOTER_RESERVED - detailLines.length);

         let startIdx = 0;
         if (this.selectorSelectedIndex >= maxVis) {
            startIdx = this.selectorSelectedIndex - maxVis + 1;
         }
         const visibleItems = filtered.slice(startIdx, startIdx + maxVis);

         // Render tool items with short promptSnippet next to the name
         for (let idx = 0; idx < visibleItems.length; idx++) {
            const i = startIdx + idx;
            const tool = visibleItems[idx];
            const isSel = i === this.selectorSelectedIndex;
            const isLockedProfile = PROFILE_LOCKED_TOOLS.has(tool.name);
            const isDisabledNested = DISABLED_NESTED_TOOLS.has(tool.name);

            const checked = !isDisabledNested && (isLockedProfile || this.tempSelectedTools.includes(tool.name));
            const cursor = isSel ? theme.fg("accent", "❯ ") : "  ";

            let box = theme.fg("dim", "[ ] ");
            if (isLockedProfile) {
               box = theme.fg("accent", "[✓] ");
            } else if (isDisabledNested) {
               box = theme.fg("dim", "[ ] ");
            } else if (checked) {
               box = theme.fg("success", "[✓] ");
            }

            let nameStr = theme.fg("text", tool.name);
            if (isDisabledNested) {
               nameStr = theme.fg("dim", tool.name);
            } else if (isSel) {
               nameStr = theme.fg("accent", theme.bold(tool.name));
            }

            const snippetStr = tool.promptSnippet ? theme.fg("dim", ` - ${tool.promptSnippet}`) : "";
            let lockBadge = "";
            if (isLockedProfile) {
               lockBadge = theme.fg("dim", " (profile requires)");
            } else if (isDisabledNested) {
               lockBadge = theme.fg("dim", " (disabled)");
            }

            lines.push(padLine(`${cursor}${box}${nameStr}${snippetStr}${lockBadge}`, width));
         }

         // Pad list slice to maxVis so total frame height stays exactly targetRows
         const listPad = Math.max(0, maxVis - visibleItems.length);
         for (let p = 0; p < listPad; p++) {
            lines.push("");
         }

         // Append dynamic detail pane + footer
         lines.push(...detailLines);
         lines.push("");
         lines.push(theme.fg("dim", "Space: toggle · a: select all · n: clear all · Enter: confirm · Esc: cancel"));
      } else {
         const maxVis = Math.max(1, targetRows - 6);
         const options = isModel ? this.getAvailableModels() : REASONING_EFFORTS;
         const filtered = options.filter((o) => o.toLowerCase().includes(q));
         this.selectorSelectedIndex = Math.max(
            0,
            Math.min(this.selectorSelectedIndex, Math.max(0, filtered.length - 1))
         );

         let startIdx = 0;
         if (this.selectorSelectedIndex >= maxVis) {
            startIdx = this.selectorSelectedIndex - maxVis + 1;
         }
         const visibleItems = filtered.slice(startIdx, startIdx + maxVis);

         for (let idx = 0; idx < visibleItems.length; idx++) {
            const i = startIdx + idx;
            const opt = visibleItems[idx];
            const isSel = i === this.selectorSelectedIndex;
            const cursor = isSel ? theme.fg("accent", "❯ ") : "  ";
            const optStr = isSel ? theme.fg("accent", theme.bold(opt)) : theme.fg("text", opt);
            lines.push(padLine(`${cursor}${optStr}`, width));
         }
         lines.push("");
         lines.push(theme.fg("dim", "Up/Down or j/k: navigate · Enter: select · Esc: cancel"));
      }

      while (lines.length < targetRows) lines.push("");
      return lines.slice(0, targetRows);
   }

   private renderBodyEditorOverlay(width: number, targetRows: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];
      const agent = this.currentAgent();
      const isDirty = this.systemPromptEditor.getValue() !== this.initialBodyValue;

      const title = `System Prompt Editor · ${agent?.name ?? "Agent"}${isDirty ? " (UNSAVED)" : ""}`;
      if (this.pendingEscConfirm) {
         const escWarning = theme.bold(theme.fg("error", "  [Unsaved changes! Press Esc again to discard]"));
         lines.push(padLine(theme.fg("accent", theme.bold(title)) + escWarning, width));
      } else {
         lines.push(padLine(theme.fg("accent", theme.bold(title)), width));
      }
      lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

      const val = this.systemPromptEditor.getValue();
      const cursorIndex = this.systemPromptEditor.getCursorIndex();
      const rawLines = val.split("\n");

      // Find cursor line and column
      let cursorLineIndex = 0;
      let cursorColIndex = 0;
      let pos = 0;

      for (let i = 0; i < rawLines.length; i++) {
         const len = rawLines[i].length;
         if (cursorIndex <= pos + len) {
            cursorLineIndex = i;
            cursorColIndex = cursorIndex - pos;
            break;
         }
         pos += len + 1;
      }

      const maxLineWidth = Math.max(10, width - 6);
      const wrappedEditorLines: { lineNum: number; text: string }[] = [];

      let runningWrappedRowIndex = 0;
      let cursorRowIndex = 0;

      for (let i = 0; i < rawLines.length; i++) {
         const rLine = rawLines[i];
         const isCursorLine = i === cursorLineIndex;

         let styledLine = rLine;
         if (isCursorLine) {
            if (cursorColIndex < rLine.length) {
               const charAt = rLine[cursorColIndex];
               styledLine =
                  rLine.slice(0, cursorColIndex) + `\x1b[7m${charAt}\x1b[27m` + rLine.slice(cursorColIndex + 1);
            } else {
               styledLine = rLine + theme.fg("accent", "█");
            }
         }

         const wrapped = wrapTextWithAnsi(styledLine, maxLineWidth);
         const lineArr = wrapped.length > 0 ? wrapped : [""];

         for (let j = 0; j < lineArr.length; j++) {
            if (isCursorLine && (cursorColIndex < rLine.length ? true : j === lineArr.length - 1)) {
               cursorRowIndex = runningWrappedRowIndex;
            }
            wrappedEditorLines.push({
               lineNum: i + 1,
               text: lineArr[j]
            });
            runningWrappedRowIndex++;
         }
      }

      const editorViewportHeight = Math.max(5, targetRows - 4);

      if (cursorRowIndex >= this.editorScrollOffset + editorViewportHeight) {
         this.editorScrollOffset = cursorRowIndex - editorViewportHeight + 1;
      } else if (cursorRowIndex < this.editorScrollOffset) {
         this.editorScrollOffset = cursorRowIndex;
      }

      const visibleSlice = wrappedEditorLines.slice(
         this.editorScrollOffset,
         this.editorScrollOffset + editorViewportHeight
      );

      for (let i = 0; i < editorViewportHeight; i++) {
         const item = visibleSlice[i];
         if (item) {
            const numStr = theme.fg("dim", `${item.lineNum.toString().padStart(3, " ")} │ `);
            lines.push(padLine(`${numStr}${item.text}`, width));
         } else {
            const numStr = theme.fg("dim", "    │ ");
            lines.push(padLine(numStr, width));
         }
      }

      lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

      if (this.pendingEscConfirm) {
         lines.push(
            padLine(theme.bold(theme.fg("error", "Unsaved changes! Press Esc again to exit without saving")), width)
         );
      } else {
         const navHint = theme.fg("dim", "Type prompt text · Up/Down/Left/Right navigate · Enter newline · ");
         const saveHint = isDirty ? theme.bold(theme.fg("accent", "Ctrl+S save *")) : theme.fg("dim", "Ctrl+S save");
         const cancelHint = theme.fg("dim", " · Esc cancel");
         lines.push(padLine(`${navHint}${saveHint}${cancelHint}`, width));
      }

      while (lines.length < targetRows) lines.push("");
      return lines.slice(0, targetRows);
   }

   private renderListRows(width: number, height: number): string[] {
      const theme = this.theme;
      const out: string[] = [];
      const vm = this.viewModel;

      if (!vm) {
         out.push(theme.fg("dim", "  (loading agent profiles)"));
         return out;
      }

      const list: AgentDefinition[] = vm.agents;
      if (list.length === 0) {
         out.push(theme.fg("dim", "  (no agents available)"));
         return out;
      }

      this.state.selectedIndex = Math.max(0, Math.min(this.state.selectedIndex, list.length - 1));
      const rows: string[] = [];
      for (let i = 0; i < list.length; i++) {
         const agent = list[i];
         const isSelected = i === this.state.selectedIndex;
         const marker = isSelected ? theme.fg("accent", "❯") : " ";
         const statusStr = agent.enabled ? theme.fg("success", "[on]") : theme.fg("dim", "[off]");
         const title = isSelected ? theme.fg("accent", theme.bold(agent.name)) : theme.fg("text", agent.name);

         const tagStr = agentDisplayTags(agent)
            .map((tag) => (tag === "built-in" ? theme.fg("dim", "[built-in]") : theme.fg("warning", "(override)")))
            .join(" ");

         const harnessBadge = theme.fg("muted", `(${agent.harness})`);
         const left = tagStr
            ? ` ${marker} ${statusStr} ${title} ${tagStr} ${harnessBadge}`
            : ` ${marker} ${statusStr} ${title} ${harnessBadge}`;
         const wrapped = wrapTextWithAnsi(left, width);
         rows.push(...wrapped.map((line, idx) => (idx === 0 ? line : `   ${line.trimStart()}`)));
      }

      let start = 0;
      if (rows.length > height) {
         const selectedRow = Math.min(this.state.selectedIndex, Math.max(0, rows.length - 1));
         start = Math.min(Math.max(0, selectedRow - Math.floor(height / 2)), rows.length - height);
      }
      return rows.slice(start, start + height);
   }

   private renderDetailScreen(width: number, targetRows: number): string[] {
      const theme = this.theme;
      const lines: string[] = [];
      const agent = this.currentAgent();
      const isDirtyDetail = Boolean(this.initialAgentSnapshot && JSON.stringify(agent) !== this.initialAgentSnapshot);

      const titleBase = `Editing Agent: ${agent?.name ?? "?"}`;
      const title = `${titleBase}${isDirtyDetail ? " (UNSAVED)" : ""}`;

      lines.push(padLine(`  ${theme.fg("accent", theme.bold(title))}`, width));
      lines.push(theme.fg("border", "╭" + "─".repeat(Math.max(0, width - 2)) + "╮"));

      const footerLines: string[] = [theme.fg("border", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯")];

      if (this.pendingDetailEscConfirm) {
         const msg = "Unsaved changes! Press Esc again to exit without saving";
         const wrapped = wrapTextWithAnsi(msg, Math.max(1, width - 4));
         for (const wLine of wrapped) {
            footerLines.push(padLine(theme.bold(theme.fg("error", `  ${wLine}`)), width));
         }
      } else if (this.isEditingText) {
         const msg = "Editing -> Type text & press Enter to save · Esc cancel";
         const wrapped = wrapTextWithAnsi(msg, Math.max(1, width - 4));
         for (const wLine of wrapped) {
            footerLines.push(padLine(theme.fg("dim", `  ${wLine}`), width));
         }
      } else {
         const saveToken = isDirtyDetail ? "Ctrl+S save *" : "Ctrl+S save";
         const rawFull = `Up/Down field · Enter/Space edit/picker · ${saveToken} · PgUp/PgDn scroll prompt · Esc back`;
         const wrapped = wrapTextWithAnsi(rawFull, Math.max(1, width - 4));

         for (const wLine of wrapped) {
            const idx = wLine.indexOf(saveToken);
            if (idx !== -1) {
               const before = wLine.slice(0, idx);
               const token = wLine.slice(idx, idx + saveToken.length);
               const after = wLine.slice(idx + saveToken.length);

               const beforeStr = before ? theme.fg("dim", before) : "";
               const tokenStr = isDirtyDetail ? theme.bold(theme.fg("accent", token)) : theme.fg("dim", token);
               const afterStr = after ? theme.fg("dim", after) : "";

               footerLines.push(padLine(`  ${beforeStr}${tokenStr}${afterStr}`, width));
            } else {
               footerLines.push(padLine(theme.fg("dim", `  ${wLine}`), width));
            }
         }
      }
      const bodyBudget = Math.max(3, targetRows - lines.length - footerLines.length);
      const divider = theme.fg("border", "│");
      const inner = Math.max(1, width - 2);
      const content = this.buildDetailFields(inner, bodyBudget);
      const body: string[] = [];
      for (let i = 0; i < bodyBudget; i++) {
         body.push(divider + padLine(content[i] ?? "", inner) + divider);
      }
      return [...lines, ...body, ...footerLines];
   }

   private getOriginalAgent(): AgentDefinition | undefined {
      if (!this.initialAgentSnapshot) return undefined;
      try {
         return JSON.parse(this.initialAgentSnapshot);
      } catch {
         return undefined;
      }
   }

   private isFieldChanged(field: AgentDetailField): boolean {
      const agent = this.currentAgent();
      const orig = this.getOriginalAgent();
      if (!agent || !orig) return false;

      if (field === "name") return agent.name !== orig.name;
      if (field === "enabled") return agent.enabled !== orig.enabled;
      if (field === "harness") return agent.harness !== orig.harness;
      if (field === "model") return agent.model !== orig.model;
      if (field === "thinking") return agent.thinking !== orig.thinking;
      if (field === "tools") return JSON.stringify(agent.tools) !== JSON.stringify(orig.tools);
      if (field === "description") return agent.description !== orig.description;
      if (field === "body") return agent.systemPrompt !== orig.systemPrompt;
      return false;
   }

   private buildDetailFields(width: number, viewportBudget: number): string[] {
      const theme = this.theme;
      const out: string[] = [];
      const agent = this.currentAgent();
      if (!agent) {
         out.push(theme.fg("dim", "  (no agent selected)"));
         return out;
      }

      const allFieldDefs: { field: AgentDetailField; label: string; val: string }[] = [
         { field: "name", label: "Name", val: agent.name },
         { field: "enabled", label: "Enabled", val: agent.enabled ? "on" : "off" },
         { field: "harness", label: "Harness", val: agent.harness },
         {
            field: "model",
            label: "Model",
            val: agent.harness === "agy" ? (agent.model ?? "gemini-3.6-flash-medium") : (agent.model ?? "(inherit)")
         },
         { field: "thinking", label: "Thinking", val: agent.thinking ?? "(inherit)" },
         { field: "tools", label: "Tools", val: agent.tools.join(", ") || "(none)" },
         { field: "description", label: "Description", val: agent.description || "(none)" }
      ];

      // Agy agents do not expose thinking or tools in this panel.
      let fieldDefs = allFieldDefs;
      if (agent.harness === "agy") {
         fieldDefs = fieldDefs.filter((f) => f.field !== "thinking" && f.field !== "tools");
      }

      const LABEL_COL_WIDTH = 13;
      const headerLines: string[] = [];
      for (let i = 0; i < fieldDefs.length; i++) {
         const isSelected = i === this.state.detailFieldIndex;
         const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";
         const item = fieldDefs[i];
         const rawLabel = `${item.label}:`;
         const labelPadded = rawLabel.padEnd(LABEL_COL_WIDTH, " ");
         const labelStr = isSelected ? theme.fg("accent", theme.bold(labelPadded)) : theme.fg("text", labelPadded);
         const changed = this.isFieldChanged(item.field);

         if (isSelected && this.isEditingText) {
            headerLines.push(`${cursor}${labelStr}Editing ->`);
            headerLines.push(...this.textInput.render(width));
         } else {
            const displayVal = changed ? `${item.val} *` : item.val;
            const valStr = changed ? theme.fg("warning", displayVal) : theme.fg("muted", displayVal);
            const fullLine = `${cursor}${labelStr}${valStr}`;
            const wrapped = wrapTextWithAnsi(fullLine, width);
            if (wrapped.length > 0) {
               headerLines.push(wrapped[0]);
               const indent = " ".repeat(2 + LABEL_COL_WIDTH);
               for (let w = 1; w < wrapped.length; w++) {
                  headerLines.push(padLine(indent + theme.fg("muted", wrapped[w].trimStart()), width));
               }
            }
         }
      }

      const fileLoc = agent.filePath ? agent.filePath : "(built-in default)";
      const fileLabelText = "File Path:".padEnd(LABEL_COL_WIDTH, " ");
      const fileLine = `  ${theme.fg("dim", fileLabelText)}${theme.fg("dim", fileLoc)}`;
      const wrappedFile = wrapTextWithAnsi(fileLine, width);
      if (wrappedFile.length > 0) {
         headerLines.push(wrappedFile[0]);
         const indent = " ".repeat(2 + LABEL_COL_WIDTH);
         for (let w = 1; w < wrappedFile.length; w++) {
            headerLines.push(padLine(indent + theme.fg("dim", wrappedFile[w].trimStart()), width));
         }
      }

      out.push(...headerLines);
      out.push("");
      out.push(theme.fg("border", "─".repeat(Math.max(1, width))));
      out.push("");

      const isBodySelected = this.state.detailFieldIndex === fieldDefs.length;
      const isBodyChanged = this.isFieldChanged("body");
      const bodyCursor = isBodySelected ? theme.fg("accent", "❯ ") : "  ";
      const bodyText = isBodyChanged ? "System Prompt *" : "System Prompt";
      const bodyLabel = isBodySelected
         ? theme.fg("accent", theme.bold(bodyText))
         : isBodyChanged
           ? theme.fg("warning", bodyText)
           : theme.fg("text", bodyText);
      out.push(`${bodyCursor}${bodyLabel}`);
      out.push("");

      const rawBody = agent.systemPrompt || "(no system prompt)";
      const rawBodyLines = rawBody.split("\n");
      const wrappedLines: string[] = [];
      for (const rLine of rawBodyLines) {
         const wrapped = wrapTextWithAnsi(rLine, Math.max(1, width - 4));
         wrappedLines.push(...(wrapped.length > 0 ? wrapped : [""]));
      }

      const nonBodyCount = headerLines.length + 4;
      const bodyViewportHeight = Math.max(3, viewportBudget - nonBodyCount);

      let startIdx = Math.max(0, Math.min(this.systemPromptScrollOffset, Math.max(0, wrappedLines.length - 1)));
      const above = startIdx;
      const below = Math.max(0, wrappedLines.length - (startIdx + bodyViewportHeight));

      if (above > 0) {
         out.push(theme.fg("dim", `  ↑ ${above} line${above === 1 ? "" : "s"} above`));
      }
      const visibleLines = wrappedLines.slice(startIdx, startIdx + bodyViewportHeight);
      for (const line of visibleLines) {
         out.push(`  ${theme.fg("muted", line)}`);
      }
      if (below > 0) {
         out.push(theme.fg("dim", `  ↓ ${below} line${below === 1 ? "" : "s"} below`));
      }

      return out;
   }
   invalidate(): void {
      this.textInput.invalidate();
      this.createNameInput.invalidate();
      this.createIntentInput.invalidate();
      this.selectorFilterInput.invalidate();
   }
}

export async function openAgentsPanel(
   ctx: ExtensionCommandContext,
   runtime: WorkflowAgentRuntime,
   options?: AgentsPanelOptions
): Promise<void> {
   if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") return;
   await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
         new FullScreenAgentsManager(tui, theme, keybindings, runtime, done, undefined, ctx, options),
      {
         overlay: true,
         overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" }
      }
   );
}
