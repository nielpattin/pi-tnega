import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type MarkdownTheme, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentSpec } from "../domain.js";
import type { AgentCancelToolParams, AgentListToolParams, AgentSpawnToolParams } from "../tools/agent.js";

interface ToolResultLike {
   readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
   readonly details?: unknown;
}

interface RenderOptions {
   readonly expanded: boolean;
   readonly isPartial: boolean;
}

interface AgentRenderState {
   spinnerIndex?: number;
   spinnerTimer?: ReturnType<typeof setTimeout>;
   spinnerRunning?: boolean;
   taskStatuses?: ReadonlyArray<string | undefined>;
   startedAt?: number;
   endedAt?: number;
}

interface RenderContext {
   readonly isError?: boolean;
   readonly state?: AgentRenderState;
   readonly invalidate?: () => void;
   readonly executionStarted?: boolean;
}

type Details = Record<string, unknown>;

function isRecord(value: unknown): value is Details {
   return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): ReadonlyArray<Details> {
   return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
   return typeof value === "string" && value.length > 0 ? value : undefined;
}

function taskStatusesFromDetails(details: unknown): ReadonlyArray<string | undefined> {
   if (!isRecord(details)) return [];
   if (Array.isArray(details.tasks)) {
      return details.tasks.map((task) => stringValue((task as Details).status));
   }
   if (Array.isArray(details.jobs)) {
      return details.jobs.map((job) => stringValue((job as Details).status));
   }
   const status = stringValue(details.status);
   return status !== undefined ? [status] : [];
}

function preview(value: unknown, limit = 72): string {
   if (typeof value !== "string") return "";
   const compact = value.replace(/\s+/g, " ").trim();
   return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function textContent(result: ToolResultLike): string {
   return result.content.find((part) => part.type === "text")?.text ?? "";
}

function errorText(result: ToolResultLike): string | undefined {
   if (isRecord(result.details)) return stringValue(result.details.error);
   return undefined;
}

function statusMark(status: string | undefined, theme: Theme, struck = false): string {
   const mark =
      status === "completed" || status === "exited" || status === "delivered"
         ? "✓"
         : status === "failed" || status === "cancelled"
           ? "✗"
           : status === "running" || status === "starting" || status === "pending"
             ? "●"
             : "·";
   const color =
      status === "completed" || status === "exited" || status === "delivered"
         ? "success"
         : status === "failed" || status === "cancelled"
           ? "error"
           : status === "running" || status === "starting" || status === "pending"
             ? "warning"
             : "muted";
   return theme.fg(color, struck ? theme.strikethrough(mark) : mark);
}

function resultPrelude(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext,
   noun: string
): Component | undefined {
   if (options.isPartial) return new Text(theme.fg("warning", `${noun} working…`), 0, 0);
   const error = errorText(result);
   if (context.isError || error) {
      const message = error ?? (textContent(result).trim() || `${noun} failed`);
      return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
   }
   return undefined;
}

function fallbackResult(result: ToolResultLike, theme: Theme): Component {
   const text = preview(textContent(result), 240);
   return new Text(theme.fg("muted", text || "Done"), 0, 0);
}

const JOB_JSON_PREVIEW_LINES = 6;

function renderJsonResult(details: Details, options: RenderOptions, theme: Theme): Component {
   const json = JSON.stringify(details, null, 2);
   const lines = json.split("\n");
   const visibleLines = options.expanded ? lines : lines.slice(0, JOB_JSON_PREVIEW_LINES);
   // Pi owns the expand/collapse interaction and passes `expanded` back to
   // this renderer. Do not replace the hidden JSON with a lossy ellipsis.
   const rendered = visibleLines.map((line) => theme.fg("toolOutput", line));
   return new Text(rendered.join("\n"), 0, 0);
}

const AGENT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function agentIndicator(index: number, theme: Theme, context?: RenderContext): string {
   const aborted = context?.isError === true;
   const status = aborted ? "cancelled" : context?.state?.taskStatuses?.[index];
   return statusMark(status, theme, aborted);
}

function agentCountLabel(count: number): string {
   return `${count} agent${count === 1 ? "" : "s"}`;
}

class SingleLineText implements Component {
   constructor(private readonly lines: ReadonlyArray<string>) {}

   invalidate(): void {}

   render(width: number): string[] {
      return this.lines.map((line) => truncateToWidth(line, Math.max(0, width)));
   }
}

/** Render the agent_spawn tool call as a compact agent plan. */
export function renderAgentCall(args: Partial<AgentSpawnToolParams>, theme: Theme, context?: RenderContext): Component {
   const agents: ReadonlyArray<Partial<AgentSpec>> = args.agents ?? [];
   const countLabel = agentCountLabel(agents.length);
   const [singleAgent] = agents;

   const aborted = context?.isError === true;
   const strike = (text: string) => (aborted ? theme.strikethrough(text) : text);

   // One compact line per agent while running. Once every agent settles,
   // the result block below lists each agent with its output, so the call
   // collapses to the header instead of repeating every name twice.
   // (Pi re-renders both blocks on each update, so this collapse applies.)
   const header = `${theme.fg("toolTitle", theme.bold("agent_spawn"))} ${theme.fg("muted", `batch · ${countLabel}`)}`;
   const settledStatuses = context?.state?.taskStatuses;
   const allSettled =
      settledStatuses !== undefined &&
      settledStatuses.length > 0 &&
      settledStatuses.every((status) => status === "completed" || status === "failed" || status === "cancelled");
   if (allSettled) return new SingleLineText([header]);

   if (singleAgent !== undefined && agents.length === 1) {
      const name = stringValue(singleAgent.name) ?? "agent_spawn";
      const agentLabel = stringValue(singleAgent.profile) ?? "unknown";
      const task = preview(singleAgent.task ?? "");
      return new SingleLineText([
         `${agentIndicator(0, theme, context)} ${theme.fg("accent", strike(name))} ${theme.fg("muted", strike(`· ${agentLabel}`))} ${theme.fg("dim", strike(task))}`
      ]);
   }

   const lines = [header];
   for (const [index, agent] of agents.entries()) {
      const name = stringValue(agent.name) ?? "agent_spawn";
      const agentLabel = stringValue(agent.profile) ?? "unknown";
      lines.push(
         `${agentIndicator(index, theme, context)} ${theme.fg("accent", strike(name))} ${theme.fg("muted", strike(`· ${agentLabel}`))}`
      );
   }
   return new SingleLineText(lines);
}

/** Render the agent_spawn result as job handles and lifecycle states. */
export function renderAgentResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   const statuses = taskStatusesFromDetails(result.details);
   if (context.state) {
      let nextStatuses: ReadonlyArray<string | undefined> = statuses;
      if (!options.isPartial && nextStatuses.length === 0) {
         const error = errorText(result);
         nextStatuses = [context.isError || error ? "failed" : "completed"];
      }
      if (nextStatuses.length > 0) {
         const nextStatusesArray = Array.from(nextStatuses);
         const previousStatuses = context.state.taskStatuses;
         const statusesChanged =
            !previousStatuses ||
            previousStatuses.length !== nextStatusesArray.length ||
            nextStatusesArray.some((status, index) => status !== previousStatuses[index]);
         const allSettled = nextStatusesArray.every(
            (status) => status === "completed" || status === "failed" || status === "cancelled"
         );
         context.state.taskStatuses = nextStatusesArray;
         context.state.spinnerRunning = !allSettled;
         if (allSettled && context.state.spinnerTimer) clearTimeout(context.state.spinnerTimer);
         if (allSettled) context.state.spinnerTimer = undefined;
         if (statusesChanged && context.invalidate) queueMicrotask(context.invalidate);
      }
   }

   if (options.isPartial) return new Text("", 0, 0);
   const prelude = resultPrelude(result, options, theme, context, "agent_spawn");
   if (prelude) return prelude;
   if (!isRecord(result.details)) return fallbackResult(result, theme);
   const jobs = records(result.details.tasks ?? result.details.jobs);
   const agentRows = jobs.length > 0 ? jobs : stringValue(result.details.id) ? [result.details] : [];
   if (agentRows.length === 0) return fallbackResult(result, theme);
   const allSettled = agentRows.every((task) => {
      const status = stringValue(task.status);
      return status === "completed" || status === "failed" || status === "cancelled";
   });
   const isSpawnAcknowledgement =
      agentRows.length > 0 && agentRows.every((task) => stringValue(task.status) === "spawned");

   if (!allSettled) {
      if (isSpawnAcknowledgement) {
         const lines = [theme.fg("dim", "---")];
         if (options.expanded) {
            lines.push(
               ...expandedOutput(result.details)
                  .split("\n")
                  .map((line) => theme.fg("toolOutput", line))
            );
         } else {
            lines.push(
               theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`
            );
         }
         return new Text(lines.join("\n"), 0, 0);
      }

      const payload = options.expanded
         ? expandedOutput(result.details)
         : agentRows
              .map((task) => {
                 const id = stringValue(task.id) ?? "agent_spawn";
                 const name = stringValue(task.name) ?? id;
                 const status = stringValue(task.status) ?? "pending";
                 return `${id} · ${name} · ${status}`;
              })
              .join("\n");
      const lines = [theme.fg("dim", "---"), ...payload.split("\n").map((line) => theme.fg("toolOutput", line))];
      if (!options.expanded) {
         lines.push(theme.fg("dim", "---"));
         lines.push(
            theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to see schema")}${theme.fg("muted", ")")}`
         );
      }
      return new Text(lines.join("\n"), 0, 0);
   }

   if (allSettled) {
      const outputs = agentRows
         .map((task) => ({ task, output: task.result ?? task.resultData ?? task.errorText }))
         .filter((entry) => entry.output !== null && entry.output !== undefined);

      if (!options.expanded) {
         const lines: string[] = [];
         if (outputs.length === 1) {
            const { task, output } = outputs[0];
            const err =
               typeof task.errorText === "string"
                  ? task.errorText
                  : isRecord(task.errorText)
                    ? JSON.stringify(task.errorText)
                    : undefined;
            if (err) {
               lines.push(theme.fg("error", `✗ ${err}`));
            } else {
               const mdText = extractMarkdownText(output);
               const lineCount = mdText ? mdText.split("\n").length : 0;
               lines.push(
                  formatAgentStatLine(
                     {
                        status: stringValue(task.status) ?? "completed",
                        name: stringValue(task.name) ?? stringValue(task.id) ?? "agent_spawn",
                        profile: stringValue(task.profile),
                        usage: task.usage as AgentStatLineInput["usage"] | undefined,
                        lineCount
                     },
                     theme
                  )
               );
            }
            lines.push(
               theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to expand output")}${theme.fg("muted", ")")}`
            );
            return new Text(lines.join("\n"), 0, 0);
         }

         lines.push(theme.fg("dim", "---"));
         for (const { task, output } of outputs) {
            const name = stringValue(task.name) ?? stringValue(task.id) ?? "agent_spawn";
            const mdText = extractMarkdownText(output);
            const lineCount = mdText ? mdText.split("\n").length : 0;
            lines.push(
               formatAgentStatLine(
                  {
                     status: stringValue(task.status) ?? "completed",
                     name,
                     profile: stringValue(task.profile),
                     usage: task.usage as AgentStatLineInput["usage"] | undefined,
                     lineCount
                  },
                  theme
               )
            );
            const err =
               typeof task.errorText === "string"
                  ? task.errorText
                  : isRecord(task.errorText)
                    ? JSON.stringify(task.errorText)
                    : undefined;
            if (err) {
               lines.push(theme.fg("error", `  ✗ ${err}`));
            }
         }
         lines.push(theme.fg("dim", "---"));
         lines.push(
            theme.fg("muted", "(") + `${keyHint("app.tools.expand", "to expand output")}${theme.fg("muted", ")")}`
         );
         return new Text(lines.join("\n"), 0, 0);
      }

      const container = new Container();
      if (outputs.length === 1) {
         const { task, output } = outputs[0];
         const mdText = extractMarkdownText(output);
         if (mdText.trim().length > 0) {
            container.addChild(new Markdown(mdText, 0, 0, createMarkdownTheme(theme)));
         }
         return container;
      }

      container.addChild(new Text(theme.fg("dim", "---"), 0, 0));
      for (const { task, output } of outputs) {
         const name = stringValue(task.name) ?? stringValue(task.id) ?? "agent_spawn";
         const mdText = extractMarkdownText(output);
         const lineCount = mdText ? mdText.split("\n").length : 0;
         container.addChild(
            new Text(
               formatAgentStatLine(
                  {
                     status: stringValue(task.status) ?? "completed",
                     name,
                     profile: stringValue(task.profile),
                     usage: task.usage as AgentStatLineInput["usage"] | undefined,
                     lineCount,
                     boldName: true
                  },
                  theme
               ),
               0,
               0
            )
         );
         if (mdText.trim().length > 0) {
            container.addChild(new Markdown(mdText, 0, 0, createMarkdownTheme(theme)));
         }
      }
      return container;
   }
   return new Text("", 0, 0);
}

export function renderAgentListCall(
   _args: Partial<AgentListToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
}

export function renderAgentCancelCall(
   args: Partial<AgentCancelToolParams>,
   theme: Theme,
   _context?: RenderContext
): Component {
   const id = stringValue(args.id) ?? "agent";
   return new Text(`${theme.fg("toolTitle", theme.bold("agent_cancel"))} ${theme.fg("accent", id)}`, 0, 0);
}

export function createMarkdownTheme(theme: Theme): MarkdownTheme {
   const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme.fg(color, text);
   return {
      heading: (text: string) => fg("accent", theme.bold(text)),
      link: (text: string) => fg("mdLink", text),
      linkUrl: (text: string) => fg("dim", text),
      code: (text: string) => fg("mdCode", text),
      codeBlock: (text: string) => fg("mdCode", text),
      codeBlockBorder: (text: string) => fg("dim", text),
      quote: (text: string) => fg("muted", text),
      quoteBorder: (text: string) => fg("dim", text),
      hr: (text: string) => fg("dim", text),
      listBullet: (text: string) => fg("accent", text),
      bold: (text: string) => theme.bold(text),
      italic: (text: string) => (theme.italic ? theme.italic(text) : `\x1b[3m${text}\x1b[23m`),
      strikethrough: (text: string) => (theme.strikethrough ? theme.strikethrough(text) : `\x1b[9m${text}\x1b[29m`),
      underline: (text: string) => (theme.underline ? theme.underline(text) : `\x1b[4m${text}\x1b[24m`)
   };
}

export function extractMarkdownText(value: unknown): string {
   if (typeof value === "string") return value;
   if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (typeof obj.output === "string") return obj.output;
      if (typeof obj.summary === "string") return obj.summary;
      if (typeof obj.result === "string") return obj.result;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.markdown === "string") return obj.markdown;
   }
   if (value === undefined || value === null) return "";
   return JSON.stringify(value, null, 2);
}

export interface AgentStatLineInput {
   readonly status?: string;
   readonly name: string;
   readonly profile?: string;
   readonly usage?: {
      readonly cost?: number;
      readonly toolCalls?: number;
      readonly contextTokens?: number;
   };
   readonly lineCount?: number;
   readonly boldName?: boolean;
}

function formatCompactTokens(tokens: number): string {
   if (tokens >= 1000) return `${parseFloat((tokens / 1000).toFixed(1))}k`;
   return `${Math.round(tokens)}`;
}

/**
 * One-line agent summary: mark, name, profile, cost, tool calls,
 * context footprint, and output line count. Missing stats are skipped.
 */
export function formatAgentStatLine(input: AgentStatLineInput, theme: Theme): string {
   const name = input.boldName ? theme.fg("accent", theme.bold(input.name)) : theme.fg("accent", input.name);
   const segments: string[] = [];
   const cost = input.usage?.cost;
   if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
      segments.push(`$${parseFloat(cost.toFixed(3))}`);
   }
   const toolCalls = input.usage?.toolCalls;
   if (typeof toolCalls === "number" && Number.isFinite(toolCalls) && toolCalls > 0) {
      segments.push(`${toolCalls} call${toolCalls === 1 ? "" : "s"}`);
   }
   const contextTokens = input.usage?.contextTokens;
   if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) {
      segments.push(`${formatCompactTokens(contextTokens)} ctx`);
   }
   const agentStr = input.profile ? theme.fg("dim", ` · ${input.profile}`) : "";
   const statsStr = segments.length > 0 ? theme.fg("dim", ` · ${segments.join(" · ")}`) : "";
   const lineCountStr =
      typeof input.lineCount === "number" && input.lineCount > 0
         ? theme.fg("muted", ` (${input.lineCount} line${input.lineCount === 1 ? "" : "s"})`)
         : "";
   return `${statusMark(input.status, theme)} ${name}${agentStr}${statsStr}${lineCountStr}`;
}

function recordOutput(item: Details): unknown {
   return item.errorText ?? item.resultData;
}

function outputPreview(value: unknown): string {
   if (typeof value === "string") return preview(value, 120);
   if (isRecord(value) && typeof value.summary === "string") return preview(value.summary, 120);
   if (value !== undefined) return preview(JSON.stringify(value), 120);
   return "";
}

function agentPayloadText(value: unknown): string {
   if (typeof value === "string") return value;
   if (isRecord(value) && typeof value.summary === "string") return value.summary;
   if (value === undefined) return "";
   return JSON.stringify(value) ?? "";
}

function expandedOutput(value: unknown): string {
   if (typeof value === "string") return value;
   return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function renderRecordList(
   noun: string,
   items: ReadonlyArray<Details>,
   options: RenderOptions,
   theme: Theme
): Component {
   const lines = [theme.fg("muted", `${items.length} ${noun}${items.length === 1 ? "" : "s"}`)];
   const shown = options.expanded ? items : items.slice(0, 4);
   for (const item of shown) {
      const status = stringValue(item.status);
      const id = stringValue(item.id) ?? stringValue(item.name) ?? "item";
      const detail = status ?? stringValue(item.agent) ?? "";
      const output = recordOutput(item);
      const summary = outputPreview(output);
      lines.push(
         `${statusMark(status, theme)} ${theme.fg("accent", id)}${detail ? ` ${theme.fg("muted", preview(detail))}` : ""}${!options.expanded && summary ? theme.fg("dim", ` · ${summary}`) : ""}`
      );
      if (options.expanded && output !== undefined) {
         for (const line of expandedOutput(output).split("\n")) lines.push(`  ${theme.fg("toolOutput", line)}`);
      }
   }
   if (shown.length < items.length) lines.push(theme.fg("dim", `… ${items.length - shown.length} more`));
   return new Text(lines.join("\n"), 0, 0);
}

/** Render a agent run result without exposing raw JSON envelopes. */
export function renderJobListResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext,
   noun = "run"
): Component {
   const details = isRecord(result.details) ? result.details : undefined;
   const prelude = resultPrelude(result, options, theme, context, noun);
   if (prelude) return prelude;
   if (!details) return fallbackResult(result, theme);
   if (Array.isArray(details.jobs)) {
      return renderRecordList("run", records(details.jobs), options, theme);
   }

   if (Array.isArray(details.lines)) {
      const lines = details.lines.filter((line): line is string => typeof line === "string");
      const shown = options.expanded ? lines : lines.slice(-4);
      return new Text(
         `${theme.fg("muted", `${lines.length} log lines`)}\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`,
         0,
         0
      );
   }
   const entity = isRecord(details.job) ? details.job : undefined;
   if (entity) {
      return renderRecordList("item", [entity], options, theme);
   }
   return renderJsonResult(details, options, theme);
}

export function renderAgentListResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderJobListResult(result, options, theme, context, "agent");
}

export function renderAgentCancelResult(
   result: ToolResultLike,
   options: RenderOptions,
   theme: Theme,
   context: RenderContext
): Component {
   return renderJobListResult(result, options, theme, context, "agent");
}
