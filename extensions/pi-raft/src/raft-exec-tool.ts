import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

type AnyToolDefinition = ToolDefinition<any, any>;

// Local mirror of the host's defineTool declaration shape (pi 0.84.2):
// identity at runtime, inference-preserving in the type system.
const defineTool = <TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition =>
  tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
import { arcItemStyled } from "./ui/arc-group.js";
import type { CodePreviewSettings } from "./ui/code-preview.js";
import { type RaftToolShellDecorator, withCodePreviewShell } from "./ui/code-preview-shell.js";
import { raftExecTitleHintCached } from "./ui/raft-title-hint.js";
import { Type } from "typebox";
import {
  createRaftPersistedExecutionDetails,
  readRaftExecutionRenderDetails,
} from "./audit/index.js";
import { DEFAULT_RAFT_CONFIG } from "./config.js";
import type { RaftState } from "./raft-state.js";
import { formatFailureProgress } from "./failure-progress.js";
import { prepareRaftExecArguments, resolveRaftExecPayloads } from "./raft-exec-arguments.js";
import { typeErrorRecoveryHint } from "./type-error-guidance.js";
import { normalizeRunDisplay } from "./run-display.js";
import type { RaftMediaBlock } from "./protocol.js";
import {
  captureRaftAgentPreviews,
  captureRaftCallHeadlinePreviews,
  captureRaftCoreToolPreviews,
  captureRaftWritePreviews,
  expandHint,
  raftMulticallCallLimit,
  raftWriteBindings,
  inheritComponentBackground,
  modelReadHint,
  nestedCallBody,
  nestedCallTitle,
  renderBoundedLines,
  renderRaftMulticallPartial,
  renderRaftWriteArgumentPreview,
  renderAgentToolPreviewLines,
  restoreRaftAgentPreviews,
  restoreRaftCallHeadlinePreviews,
  restoreRaftCoreToolPreviews,
  restoreRaftWritePreviews,
  restoreLegacyBashCommands,
  safeTerminalText,
  singleCallProgressLine,
  type RaftAgentPreview,
  type RaftCallHeadlinePreview,
  type RaftCoreToolPreview,
  type RaftRenderAudit,
  type RaftWriteBinding,
  type RaftWritePreview,
} from "./ui/raft-render.js";
import {
  coreToolPreviewEnabled,
  coreToolRendererEnabled,
  isCoreToolAudit,
  renderCoreToolBody,
} from "./ui/core-tool-render.js";
import { renderExternalToolBody } from "./ui/external-tool-renderers/index.js";
import { highlightCode, observePiTheme } from "./ui/highlight.js";
import {
  HiddenRowBorrowingComponent,
  observeResultRows,
  type ResultRowBalance,
} from "./ui/row-balance.js";
import { type SpinnerTimerState, updateSpinner } from "./ui/spinner.js";
import type { RaftToolDisplayController } from "./ui/tool-display.js";
import { boundModelOutput, modelOutputBudget } from "./output-budget.js";
import { formatRaftValue } from "./ui/structured.js";
import { countNewlines } from "./util.js";

const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const MAX_RAFT_CODE_TRANSFER_LINES = 12;

type RaftRendererState = {
  raftKernel?: "typescript" | "python";
  raftWriteBindingsCode?: string;
  raftWriteBindings?: RaftWriteBinding[];
  raftWritePreviews?: RaftWritePreview[];
  raftCoreToolPreviews?: RaftCoreToolPreview[];
  raftCallHeadlinePreviews?: RaftCallHeadlinePreview[];
  raftAgentPreviews?: RaftAgentPreview[];
  raftResultRowBalance?: ResultRowBalance;
  raftSpinner?: SpinnerTimerState;
};

type RaftToolDisplayMode = "full" | "compact";

// Bootstrap, not runtime activation, is the config-readiness seam: upstream's
// deferred startup loads configuration into RaftState without creating the
// heavyweight runtime, so a resumed session must honor the bootstrapped
// ui.toolDisplay even while state.initialized is still false. The explicit
// bootstrapped check also guards the failed-bootstrap window (config loaded
// unsuccessfully): compact is the configured default, but a broken or absent
// configuration falls back to full so a degraded startup never hides the
// underlying transcript.
const toolDisplayMode = (state: RaftState): RaftToolDisplayMode =>
  state.bootstrapped ? state.config.appearance.ui.toolDisplay : "full";

const toolKernel = (state: RaftState): "typescript" | "python" =>
  state.bootstrapped ? (state.config.execution.executor?.kernel ?? "typescript") : "typescript";

const compactResultHeader = (theme: Theme, audits: RaftRenderAudit[], failed: boolean): string => {
  const failedCalls = audits.filter((audit) => audit.success === false).length;
  const isFailed = failed || failedCalls > 0;
  return (
    theme.fg(isFailed ? "error" : "success", `${isFailed ? "✗" : "✓"} Tools`) +
    theme.fg(
      "dim",
      ` · ${countLabel(audits.length, "call")}${failedCalls > 0 ? ` · ${failedCalls} failed` : ""}`,
    )
  );
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

export const createRaftExecTool = (
  state: RaftState,
  codePreviewSettings: CodePreviewSettings,
  decorateShell: RaftToolShellDecorator = withCodePreviewShell,
  toolDisplay?: RaftToolDisplayController,
): ToolDefinition<any, any> => {
  const python = toolKernel(state) === "python";
  const monty = python && state.config.execution.executor.pythonRuntime === "monty";
  return decorateShell(
    defineTool({
      name: "raft_exec",
      label: "Raft",
      description: python
        ? monty
          ? "Execute Python through Raft's configured Monty sandbox. Monty runs a Python subset with VM resource limits, no native filesystem/network/environment access, and only host-mediated tools. Each invocation starts fresh."
          : "Execute Python through Raft’s configured CPython kernel for MCP tools, Raft providers, and discovery. Each call uses a fresh process. Native execution is trusted code."
        : "Execute type-checked TypeScript through Raft's configured executor for MCP tools, Raft providers, and discovery. QuickJS is isolated by default; the optional Node/Bun process is an unsafe trusted-code escape hatch.",
      promptSnippet: "MCP tools, Raft providers, and discovery",
      promptGuidelines: [
        python
          ? "Batch independent operations in one `raft_exec` Python program with `asyncio.gather`; await dependent/conditional steps sequentially. Coalesce independent replacements after catalog discovery. Return only the compact final JSON-compatible value."
          : "Batch independent operations in one `raft_exec` program (`Promise.all` for parallel, sequential `await` for ordered), not one call per tool; keep dependent/conditional steps sequential. Coalesce non-dependent replacements after catalog discovery, using `all:true` only for intentional repeated exact anchors. Return only the compact final value; intermediate results stay in the sandbox.",
        python
          ? 'Call what you can name: MCP tools as `mcp.<server>.<tool>(args)` and fixed Raft actions as `memory.*`/`agents.*`. Pi core tools and registered extension tools stay on their native direct path and are unavailable inside raft_exec. Use `await tools.search("<intent>")` only for dynamic namespaces you cannot name, and `await tools.call(ref=..., args={...})` for computed refs. Use Python dict syntax, `True`/`False`/`None`, and bounded reads; unbounded reads cap at 2000 lines or 50KB. Do not dump catalogs.'
          : 'Call what you can name: MCP tools as `mcp.<server>.<tool>(args)` and fixed Raft actions as `memory.*`/`agents.*`. Pi core tools and registered extension tools stay on their native direct path and are unavailable inside raft_exec. Use `await tools.search("<intent>")` only for dynamic namespaces you cannot name, and `await tools.call({ ref, args })` for computed refs. Read bounded ranges; unbounded reads cap at 2000 lines or 50KB. Do not dump catalogs.',
        "For coding tasks, keep an acceptance ledger: turn the request into concrete checks, trace the relevant execution path before editing, implement end to end, then run targeted tests and direct behavioral probes. Mechanically confirm requested public symbols, registrations, and configuration entries. Use the smallest checks that cover the ledger, escalating only for failures or cross-cutting risk; inspect failures and iterate instead of rerunning unchanged passing checks. A build alone is not completion.",
        python
          ? "For test/probe nonzero exits, inspect the returned dict: `r['ok']`, `r['output']`, and `r.get('exitCode')`. Set shell `timeout` in seconds once for long suites. Return decisions and evidence rather than raw logs."
          : "Amortize round trips without inflating context: batch only independent, bounded work. Keep search→read and edit→verify sequential when an output determines the next action. Call nameable actions directly (`mcp.*`, `memory.*`, `agents.*`) and use `tools.call` only for refs you discovered or computed. Return decisions, failures, and evidence rather than raw logs or unused intermediate results.",
        "For edits/writes, pass named payloads through top-level `payloads`; each `π.key` must exactly match a key there. Name the tool you need before selecting an action; shell actions have no stdin.",
        "Use `display.name` and objective `display.description`; Raft pairs them with verified outcomes in deterministic compaction.",
        ...(monty
          ? [
              "Monty requires acyclic JSON host arguments. For underscore-prefixed provider/tool names, use `await tools.call(ref=..., args={...})`, not direct attributes. Use `payloads['key']` for private/non-identifier payload keys.",
            ]
          : []),
      ],
      // The model-facing schema is intentionally flat: one large `code` string
      // plus scalar/optional params. Do not add nested arrays-of-objects with
      // escaped content here. SOTA models are post-trained on one dominant
      // harness's flat tool shapes and can invent trailing keys at the
      // highest-entropy point of a nested escaped-JSON field, which a strict
      // schema hard-rejects. Keep this surface string/scalar-heavy; the only
      // nested field (display) ignores unknown keys. See
      // lucumr.pocoo.org/2026/7/4/better-models-worse-tools/ and pi-tool-repair.
      // display also accepts a bare (or JSON-object) string, silently repaired
      // to { name } via normalizeRunDisplay: flash-tier models cold-start with
      // that near-miss, and repairing beats a zero-work rejection round trip.
      // payloads is the remaining nested map (legacy alias: strings). The old
      // name collides with the JSON string type, so models stringify it;
      // prepareArguments remaps `strings` and parses a JSON-object string
      // back to Record<string, string> before Pi validates.
      parameters: Type.Object({
        code: Type.String({
          description: python
            ? monty
              ? "Python async function body executed by Monty, a sandboxed Python subset (not CPython). Top-level await/return and asyncio.gather are supported. Use only Monty's supported syntax/modules; native imports, filesystem, network, and environment are unavailable. Host globals: tools, mcp, memory, agents. Await dict/keyword calls; use native dict results r['output']. Payloads: π.key or payloads['key']. Return JSON-compatible data; each invocation starts fresh."
              : "Python async function body executed by CPython. Top-level await and return are supported; standard-library imports are available. Globals: tools, mcp, memory, agents. Await host calls using a dict or keyword arguments. Results are native dicts/lists: r['output'], not r.output. Use asyncio.gather for concurrency. Named payloads are π.key or payloads['key']. Return a JSON-compatible value. Each call starts fresh."
            : "TypeScript function body. Top-level await and return are supported. Globals include `tools`, `mcp`, `memory`, `agents`, `print`, and `π`. `π` contains only the exact keys supplied by this call's `payloads`. See session guidance / `raft-exec` skill for exact signatures.",
        }),
        payloads: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Named payloads exposed under the same exact name as π.key (for example, payloads.contract becomes π.contract). Never reference a π key absent from this map. Useful for content that is awkward to quote inside code. Prefer an object of string values; a JSON-object string is parsed.",
          }),
        ),
        resultFormat: Type.Optional(Type.Union(RESULT_FORMATS.map((value) => Type.Literal(value)))),
        ...(python
          ? {}
          : {
              tokenBudget: Type.Optional(
                Type.Number({
                  minimum: 1,
                  description: "Optional token budget observed by agent calls",
                }),
              ),
            }),
        agentBudget: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "Optional agent-call cap, bounded by Raft configuration",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            minimum: 1,
            description:
              "Optional whole-program deadline in ms for this invocation; raises (never lowers) the configured executor.timeoutMs, capped by executor.maxTimeoutMs",
          }),
        ),
        display: Type.Optional(
          Type.Union([
            Type.Object({
              name: Type.Optional(
                Type.String({
                  description:
                    "Concise execution milestone used by the Raft activity UI and deterministic compaction continuity",
                }),
              ),
              description: Type.Optional(
                Type.String({
                  description:
                    "Compact declared objective or acceptance criterion shown in the dashboard and richer compaction activity",
                }),
              ),
            }),
            Type.String({
              description:
                "Objective shorthand normalized to { name } (a JSON-object string is parsed). Prefer the object form when available.",
            }),
          ]),
        ),
      }),
      // Pi validates custom-tool arguments before `tool_call` and `execute`, so
      // compatibility coercions for the model-facing boundary must live in the
      // official prepareArguments hook rather than execute-time fallbacks.
      prepareArguments(args) {
        return prepareRaftExecArguments(args) as any;
      },
      renderCall(params, theme, context) {
        observePiTheme(theme);
        const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
        const mode = toolDisplayMode(state);
        const rendererState = context.state as RaftRendererState;
        const python = (rendererState.raftKernel ?? toolKernel(state)) === "python";
        toolDisplay?.observe(context.toolCallId, "call", context.invalidate);
        const spinner = updateSpinner(
          (rendererState.raftSpinner ??= {}),
          context.isPartial,
          context.invalidate,
        );
        const rowBalance = (rendererState.raftResultRowBalance ??= {});
        if (rendererState.raftWriteBindingsCode !== code) {
          rendererState.raftWriteBindingsCode = code;
          rendererState.raftWriteBindings = python ? [] : raftWriteBindings(code);
        }
        // The write argument preview is a streaming affordance: it previews
        // pending writes while args are still arriving. Pi only flips
        // executionStarted for live calls; resumed cards stay at its false
        // default and are always complete (isPartial false), so their previews
        // belong to the result side alone. Without the isPartial gate, a
        // collapsed resumed card shows the same write twice.
        const writePreview =
          context.executionStarted || !context.isPartial
            ? null
            : renderRaftWriteArgumentPreview(
                {
                  bindings: rendererState.raftWriteBindings ?? [],
                  strings: resolveRaftExecPayloads(params),
                  expanded: context.expanded,
                  cwd: context.cwd,
                  settings: codePreviewSettings,
                  spinner,
                },
                theme,
                context.invalidate,
              );
        // Pi's app.tools.expand toggle (ctrl+o) flips context.expanded and
        // promotes a compact card to the full transcript below.
        if (mode === "compact" && !context.expanded) {
          const display = normalizeRunDisplay(params.display);
          // Session-wide memo keyed by the program string: the same hint serves
          // the live card, the activity feed, and compaction intent.
          const title =
            display?.name?.trim() || (python ? "Python program" : raftExecTitleHintCached(code));
          const header = renderBoundedLines(
            [
              theme.fg("toolTitle", theme.bold(safeTerminalText(title || "Raft"))),
              ...(display?.description
                ? [theme.fg("dim", safeTerminalText(display.description))]
                : []),
            ],
            theme,
            codePreviewSettings.diffIntensity,
          );
          if (!writePreview) return header;
          const composite = new Container();
          composite.addChild(header);
          composite.addChild(new Text("\n", 0, 0));
          composite.addChild(writePreview);
          return composite;
        }

        const lines = safeTerminalText(code).split("\n");
        const runDisplay = normalizeRunDisplay(params.display);
        const displayName = runDisplay?.name ? safeTerminalText(runDisplay.name) : "";
        const title = `${theme.fg("toolTitle", theme.bold("raft"))}${
          displayName ? ` ${theme.fg("accent", displayName)}` : ""
        } ${theme.fg("dim", `${python ? "Python" : "TypeScript"} · ${countLabel(lines.length, "line")}`)}`;
        // Match the compact header: the declared objective sits between the
        // title and the code preview.
        const description = runDisplay?.description
          ? theme.fg("dim", safeTerminalText(runDisplay.description))
          : "";
        const baseLimit = context.expanded ? lines.length : Math.min(lines.length, 8);
        const maxLimit = context.expanded
          ? lines.length
          : Math.min(lines.length, baseLimit + MAX_RAFT_CODE_TRANSFER_LINES);
        const renderCodePreview = (limit: number, width: number): string[] => {
          const shown = lines.slice(0, limit);
          const lineNumberWidth = String(Math.max(1, shown.length)).length;
          const preview = shown
            .map(
              (line, index) =>
                `${theme.fg("dim", String(index + 1).padStart(lineNumberWidth, " "))} ${theme.fg("muted", line || " ")}`,
            )
            .join("\n");
          const hidden = lines.length - shown.length;
          const hiddenHint =
            hidden > 0
              ? `\n${theme.fg("dim", `… ${countLabel(hidden, "line")} hidden · `)}${expandHint(theme)}`
              : "";
          return new Text(
            `${title}${description ? `\n${description}` : ""}${preview ? `\n${preview}` : ""}${hiddenHint}`,
            0,
            0,
          ).render(width);
        };
        const codePreview = new HiddenRowBorrowingComponent(
          baseLimit,
          maxLimit,
          renderCodePreview,
          rowBalance,
        );
        if (!writePreview) return codePreview;
        const composite = new Container();
        composite.addChild(codePreview);
        composite.addChild(new Text("\n", 0, 0));
        composite.addChild(writePreview);
        return composite;
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
        observePiTheme(theme);
        const details = readRaftExecutionRenderDetails(result.details);
        let audits = restoreLegacyBashCommands(details.audits as RaftRenderAudit[], context.args);
        const rendererState = context.state as RaftRendererState;
        const recordedKernel = details.kernel ?? (isPartial ? undefined : "typescript");
        if (recordedKernel && rendererState.raftKernel !== recordedKernel) {
          const renderedKernel = rendererState.raftKernel ?? toolKernel(state);
          rendererState.raftKernel = recordedKernel;
          delete rendererState.raftWriteBindingsCode;
          if (renderedKernel !== recordedKernel) context.invalidate();
        }
        toolDisplay?.observe(context.toolCallId, "result", context.invalidate);
        const spinner = updateSpinner(
          (rendererState.raftSpinner ??= {}),
          isPartial,
          context.invalidate,
        );
        const rowBalance = (rendererState.raftResultRowBalance ??= {});
        const trackRows = (component: Component): Component =>
          observeResultRows(inheritComponentBackground(component), rowBalance, {
            expanded,
            isPartial,
          });
        if (isPartial) {
          rendererState.raftCoreToolPreviews = captureRaftCoreToolPreviews(
            audits,
            rendererState.raftCoreToolPreviews,
          );
          rendererState.raftAgentPreviews = captureRaftAgentPreviews(
            audits,
            rendererState.raftAgentPreviews,
          );
          const headlinePreviews = captureRaftCallHeadlinePreviews(audits);
          if (headlinePreviews.length > 0) {
            rendererState.raftCallHeadlinePreviews = headlinePreviews;
          }
          const writePreviews = captureRaftWritePreviews(audits);
          if (writePreviews.length > 0) rendererState.raftWritePreviews = writePreviews;
        } else {
          if (rendererState.raftCoreToolPreviews) {
            audits = restoreRaftCoreToolPreviews(audits, rendererState.raftCoreToolPreviews);
          }
          if (rendererState.raftAgentPreviews) {
            audits = restoreRaftAgentPreviews(audits, rendererState.raftAgentPreviews);
          }
          if (rendererState.raftCallHeadlinePreviews) {
            audits = restoreRaftCallHeadlinePreviews(
              audits,
              rendererState.raftCallHeadlinePreviews,
            );
          }
          if (rendererState.raftWritePreviews) {
            audits = restoreRaftWritePreviews(audits, rendererState.raftWritePreviews);
          }
        }
        const phases = details.phases;
        const nl = "\n";
        const allRowIndexes = (
          lines: string[],
          enabled: boolean,
        ): ReadonlySet<number> | undefined =>
          enabled ? new Set(lines.map((_line, index) => index)) : undefined;
        // Expanded (app.tools.expand / ctrl+o) promotes compact cards to the
        // full rendering; compact only governs the collapsed presentation.
        const compact = !expanded && toolDisplayMode(state) === "compact";
        const corePreviewContext = { cwd: context.cwd, settings: codePreviewSettings };
        const showAgentToolPreview = state.initialized
          ? state.config.appearance.ui.showAgentToolPreview
          : DEFAULT_RAFT_CONFIG.appearance.ui.showAgentToolPreview;

        const renderBody = (
          audit: RaftRenderAudit,
          limit: number,
        ): { body: string; hidden: number } | null => {
          const core = renderCoreToolBody(audit, theme, {
            cwd: context.cwd,
            settings: codePreviewSettings,
            expanded,
            maxLines: limit,
            ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
          });
          if (core) return { body: core.lines.join(nl), hidden: core.hidden };
          if (coreToolRendererEnabled(audit, codePreviewSettings)) return null;
          const external = renderExternalToolBody(audit, theme, {
            maxLines: limit,
            expanded,
            ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
          });
          if (external) return { body: external.lines.join(nl), hidden: external.hidden };

          const body = nestedCallBody(audit);
          if (!body) return null;
          const bodyLines = safeTerminalText(body).split(nl);
          while (bodyLines.length > 0) {
            const last = bodyLines[bodyLines.length - 1];
            if (last === undefined || last.trim() === "") bodyLines.pop();
            else break;
          }
          if (bodyLines.length === 0) return null;
          const shown = bodyLines.slice(0, limit);
          return {
            body: shown.map((line) => theme.fg("toolOutput", line || " ")).join(nl),
            hidden: bodyLines.length - shown.length,
          };
        };

        if (isPartial) {
          const progress = details.progress;
          if (audits.length === 0) {
            const label = compact ? "Running…" : (progress ?? "Running Raft program…");
            return trackRows(new Text(theme.fg("warning", `◆ ${safeTerminalText(label)}`), 0, 0));
          }
          if (audits.length === 1) {
            const audit = audits[0]!;
            const glyph =
              audit.success === undefined
                ? theme.fg("warning", spinner)
                : audit.success === false
                  ? theme.fg("error", "✗")
                  : theme.fg("dim", "›");
            let text = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
            const previewLines = renderAgentToolPreviewLines(audit, theme, {
              expanded,
              showTools: showAgentToolPreview,
              core: corePreviewContext,
              ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
            });
            const progressLine = singleCallProgressLine(progress, previewLines);
            if (audit.success === false && audit.error) {
              text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
            } else {
              const rendered = renderBody(
                audit,
                expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 10,
              );
              if (rendered) {
                text += nl + rendered.body;
                if (rendered.hidden > 0) {
                  text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
                  if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
                }
              } else if (
                isCoreToolAudit(audit) &&
                !expanded &&
                !coreToolPreviewEnabled(audit, codePreviewSettings)
              ) {
                text += nl + arcItemStyled(theme, expandHint(theme));
              } else if (progressLine) {
                text += nl + theme.fg("dim", progressLine);
              }
            }
            if (audit.success !== false && previewLines[0]) {
              const firstBreak = text.indexOf(nl);
              if (firstBreak < 0) text += ` ${previewLines[0]}`;
              else
                text = `${text.slice(0, firstBreak)} ${previewLines[0]}${text.slice(firstBreak)}`;
              if (previewLines.length > 1) text += nl + previewLines.slice(1).join(nl);
            }
            const textLines = text.split(nl);
            return trackRows(
              renderBoundedLines(
                textLines,
                theme,
                codePreviewSettings.diffIntensity,
                allRowIndexes(textLines, previewLines.length > 0),
              ),
            );
          }
          let preview: { auditIndex: number; body: string; hidden: number } | undefined;
          for (let index = audits.length - 1; index >= 0; index--) {
            const audit = audits[index]!;
            if ((audit.tool !== "write" && audit.tool !== "edit") || audit.success === false)
              continue;
            const rendered = renderBody(audit, expanded ? 20 : 10);
            if (rendered) {
              preview = { auditIndex: index, ...rendered };
              break;
            }
          }
          return trackRows(
            renderRaftMulticallPartial(
              {
                audits,
                phases,
                progress,
                expanded,
                preview,
                core: corePreviewContext,
                showAgentToolPreview,
                spinner,
                ...(compact ? { activityLabel: "Tools" } : {}),
              },
              theme,
              context?.invalidate,
            ),
          );
        }

        const output = result.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(nl);
        const styleOutputLines = (lines: string[]): string[] => {
          if (!details.outputFormat || lines.length === 0) {
            return lines.map((line) => theme.fg("toolOutput", line || " "));
          }
          const highlightedStart = Math.min(lines.length, details.outputFormatStartLine ?? 0);
          const highlightedCount = Math.min(
            lines.length - highlightedStart,
            details.outputFormatLines ?? lines.length,
          );
          const highlightedSource = lines.slice(
            highlightedStart,
            highlightedStart + highlightedCount,
          );
          const highlighted =
            highlightedSource.length > 0
              ? highlightCode(highlightedSource.join(nl), details.outputFormat, context?.invalidate)
              : [];
          const styledPrefix =
            highlighted?.map((line) => line || " ") ??
            highlightedSource.map((line) => theme.fg("toolOutput", line || " "));
          return [
            ...lines.slice(0, highlightedStart).map((line) => theme.fg("toolOutput", line || " ")),
            ...styledPrefix,
            ...lines
              .slice(highlightedStart + highlightedCount)
              .map((line) => theme.fg("toolOutput", line || " ")),
          ];
        };
        const failed = details.success === false;

        if (audits.length === 0) {
          if (failed && details.error) {
            return trackRows(
              new Text(theme.fg("error", `✗ ${safeTerminalText(details.error)}`), 0, 0),
            );
          }
          if (!output) {
            return trackRows(
              new Text(
                compact
                  ? theme.fg(failed ? "error" : "success", failed ? "✗ Failed" : "✓ Evaluated")
                  : theme.fg("dim", "✓ Raft"),
                0,
                0,
              ),
            );
          }
          const lines = safeTerminalText(output).split(nl);
          const limit = expanded ? Math.min(lines.length, 200) : 12;
          const shown = lines.slice(0, limit);
          let text = styleOutputLines(shown).join(nl);
          if (compact) {
            text =
              theme.fg(failed ? "error" : "success", failed ? "✗ Failed" : "✓ Evaluated") +
              nl +
              text;
          }
          if (lines.length > shown.length) {
            text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")}`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
          return trackRows(
            renderBoundedLines(text.split(nl), theme, codePreviewSettings.diffIntensity),
          );
        }

        if (audits.length === 1) {
          const audit = audits[0]!;
          let text = compact
            ? `${compactResultHeader(theme, audits, failed)}${nl}${nestedCallTitle(
                audit,
                theme,
                context?.invalidate,
                corePreviewContext,
              )}`
            : nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext);
          const previewLines = renderAgentToolPreviewLines(audit, theme, {
            expanded,
            showTools: showAgentToolPreview,
            core: corePreviewContext,
            ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
          });
          if (audit.success === false) {
            if (audit.error) {
              text += nl + theme.fg("error", safeTerminalText(audit.error));
            }
            return trackRows(new Text(text, 0, 0));
          }
          if (previewLines[0]) {
            text += ` ${previewLines[0]}`;
            if (previewLines.length > 1) text += nl + previewLines.slice(1).join(nl);
          }
          const limit = expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 12;
          const rendered = previewLines.length > 0 ? null : renderBody(audit, limit);
          if (rendered) {
            text += nl + rendered.body;
            if (rendered.hidden > 0) {
              text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
              if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
            }
            const readHint = modelReadHint(audits, output, theme);
            if (readHint) text += nl + readHint;
          } else if (
            isCoreToolAudit(audit) &&
            !expanded &&
            !coreToolPreviewEnabled(audit, codePreviewSettings)
          ) {
            text += nl + arcItemStyled(theme, expandHint(theme));
          } else if (
            previewLines.length === 0 &&
            output &&
            !isCoreToolAudit(audit) &&
            (!compact || failed || expanded)
          ) {
            const lines = safeTerminalText(output).split(nl);
            const outLimit = expanded ? Math.min(lines.length, 200) : 12;
            const outShown = lines.slice(0, outLimit);
            text += nl + styleOutputLines(outShown).join(nl);
            if (lines.length > outShown.length) {
              text +=
                nl + theme.fg("dim", `… ${countLabel(lines.length - outShown.length, "line")}`);
              if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
            }
          }
          const textLines = text.split(nl);
          return trackRows(
            renderBoundedLines(
              textLines,
              theme,
              codePreviewSettings.diffIntensity,
              allRowIndexes(textLines, previewLines.length > 0),
            ),
          );
        }

        const failedCalls = audits.filter((audit) => audit.success === false).length;
        const status = failed ? "failed" : "complete";
        const statusColor = failed ? "error" : "success";
        const metadata = [
          countLabel(audits.length, "nested call"),
          failedCalls > 0 ? `${failedCalls} failed` : undefined,
          phases.length > 0 ? countLabel(phases.length, "phase") : undefined,
        ].filter((value): value is string => Boolean(value));
        let text = compact
          ? compactResultHeader(theme, audits, failed)
          : theme.fg(statusColor, `${failed ? "✗" : "✓"} Raft ${status}`);
        if (!compact && metadata.length > 0) text += theme.fg("dim", ` · ${metadata.join(" · ")}`);
        if (phases.length > 0)
          text += nl + theme.fg("dim", phases.map((phase) => `◆ ${phase}`).join("  "));

        const callLimit = raftMulticallCallLimit(expanded);
        const callsShown = audits.slice(0, callLimit);
        const callsHidden = audits.length - callsShown.length;
        let collapsedPreview: { auditIndex: number; body: string; hidden: number } | undefined;
        if (!expanded) {
          for (let index = callsShown.length - 1; index >= 0; index--) {
            const audit = callsShown[index]!;
            if ((audit.tool !== "write" && audit.tool !== "edit") || audit.success === false)
              continue;
            const rendered = renderBody(audit, 10);
            if (rendered) {
              collapsedPreview = { auditIndex: index, ...rendered };
              break;
            }
          }
        }
        let firstNested = true;
        const textRows = text.split(nl);
        const agentWrapLineIndexes = new Set<number>();
        for (let index = 0; index < callsShown.length; index++) {
          const audit = callsShown[index]!;
          if (expanded && !firstNested) textRows.push("");
          firstNested = false;
          const glyph = audit.success === false ? theme.fg("error", "✗") : theme.fg("dim", "›");
          const previewLines = renderAgentToolPreviewLines(audit, theme, {
            expanded,
            compact: !expanded,
            showTools: showAgentToolPreview,
            core: corePreviewContext,
            ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
          });
          let callRow = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
          if (previewLines[0] && audit.success !== false) {
            callRow += ` ${previewLines[0]}`;
            if (expanded) agentWrapLineIndexes.add(textRows.length);
          }
          textRows.push(callRow);
          if (audit.success === false && audit.error) {
            textRows.push(`  ${theme.fg("error", safeTerminalText(audit.error))}`);
          } else {
            if (previewLines.length > 1) {
              for (const line of previewLines.slice(1)) {
                agentWrapLineIndexes.add(textRows.length);
                textRows.push(line);
              }
            }
            const rendered = previewLines.length === 0 && expanded ? renderBody(audit, 40) : null;
            if (rendered) {
              textRows.push(...rendered.body.split(nl));
              if (rendered.hidden > 0) {
                textRows.push(theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`));
              }
            } else if (previewLines.length === 0 && collapsedPreview?.auditIndex === index) {
              textRows.push(...collapsedPreview.body.split(nl).map((line) => `  ${line}`));
              if (collapsedPreview.hidden > 0) {
                textRows.push(
                  theme.fg("dim", `  … ${countLabel(collapsedPreview.hidden, "line")}`),
                );
              }
            }
          }
        }
        text = textRows.join(nl);
        if (callsHidden > 0) {
          text += nl + theme.fg("dim", `… ${countLabel(callsHidden, "nested call")} hidden`);
          if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
        }
        const readHint = modelReadHint(audits, output, theme);
        if (readHint) text += nl + readHint;

        const showOutput = failed || expanded;
        if (showOutput && output) {
          const lines = safeTerminalText(output).split(nl);
          const limit = expanded ? Math.min(lines.length, 200) : 6;
          const shown = lines.slice(0, limit);
          if (shown.length > 0) {
            if (expanded) text += nl + theme.fg("dim", "↩ return");
            text += nl + styleOutputLines(shown).join(nl);
            if (lines.length > shown.length) {
              text +=
                nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")} hidden`);
              if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
            }
          }
        }
        return trackRows(
          renderBoundedLines(
            text.split(nl),
            theme,
            codePreviewSettings.diffIntensity,
            agentWrapLineIndexes,
          ),
        );
      },
      async execute(toolCallId, params, signal, onUpdate, context) {
        await state.ensure(context);
        // prepareArguments joins code arrays and remaps `strings` → `payloads`
        // before Pi validates this call; keep the same coercion here for direct
        // internal invocations.
        const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
        const runDisplay = normalizeRunDisplay(params.display);
        const strings = resolveRaftExecPayloads(params);
        const tokenBudget =
          "tokenBudget" in params && typeof params.tokenBudget === "number"
            ? params.tokenBudget
            : undefined;
        const result = await state.execution.execute({
          code,
          ...(strings ? { strings } : {}),
          signal,
          parentToolCallId: toolCallId,
          context,
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
          ...(params.agentBudget !== undefined ? { maxAgentCalls: params.agentBudget } : {}),
          ...(params.timeoutMs !== undefined ? { requestedTimeoutMs: params.timeoutMs } : {}),
          ...(runDisplay
            ? {
                display: {
                  ...(runDisplay.name !== undefined && { name: runDisplay.name }),
                  ...(runDisplay.description !== undefined && {
                    description: runDisplay.description,
                  }),
                },
              }
            : {}),
          onPartial(snapshot) {
            onUpdate?.({
              content: [{ type: "text", text: snapshot.progress ?? "" }],
              details: {
                progress: snapshot.progress,
                audits: snapshot.audits,
                phases: snapshot.phases,
              },
            });
          },
        });

        const selectedResultFormat =
          params.resultFormat ?? state.config.execution.executor.resultFormat;
        const fullFormattedValue = formatRaftValue(result.value, selectedResultFormat);
        const failureProgress = formatFailureProgress(result.trace);
        const fullSections = [...result.logs];
        if (fullFormattedValue.text) fullSections.push(fullFormattedValue.text);
        if (result.error) fullSections.push(`Runtime error: ${result.error}`);
        if (failureProgress) fullSections.push(failureProgress);
        const fullRawOutput = fullSections.join("\n\n");
        const outputBudget = modelOutputBudget(
          state.config.execution.executor.maxOutputChars,
          result.success,
        );
        const outputWillTruncate = fullRawOutput.length > outputBudget;
        const formattedValue = outputWillTruncate
          ? formatRaftValue(result.value, selectedResultFormat, outputBudget)
          : fullFormattedValue;
        const sections = [...result.logs];
        const logPrefix = result.logs.join("\n\n");
        if (formattedValue.text) sections.push(formattedValue.text);
        if (result.error) sections.push(`Runtime error: ${result.error}`);
        if (failureProgress) sections.push(failureProgress);
        const rawOutput = sections.join("\n\n");
        const outputFormat =
          formattedValue.language &&
          formattedValue.text &&
          (result.logs.length === 0 || !outputWillTruncate)
            ? formattedValue.language
            : undefined;
        const outputFormatStartLine = result.logs.length > 0 ? countNewlines(logPrefix) + 2 : 0;
        // Evaluated lazily at each return so the main path persists audits after
        // their in-memory image payloads are stripped below.
        const persistedRenderDetails = () =>
          createRaftPersistedExecutionDetails({
            ...result,
            ...(outputFormat ? { outputFormat, outputFormatStartLine } : {}),
            ...(outputFormat
              ? {
                  outputFormatLines:
                    formattedValue.highlightedLineCount ?? countNewlines(formattedValue.text) + 1,
                }
              : {}),
          });

        if (result.typeErrors) {
          const text = result.typeErrors
            .map((error) =>
              error.line > 0
                ? `Line ${error.line}:${error.column} — ${error.message}`
                : error.message,
            )
            .join("\n");
          const recoveryHint = typeErrorRecoveryHint(code, result.typeErrors);
          const bounded = await boundModelOutput(
            `Type errors; code was not executed:\n${text}${recoveryHint ? `\n\n${recoveryHint}` : ""}`,
            outputBudget,
          );
          return {
            content: [{ type: "text", text: bounded.text }],
            details: persistedRenderDetails(),
            isError: true,
          };
        }

        const output = (
          await boundModelOutput(
            rawOutput || "(no output)",
            outputBudget,
            fullRawOutput || "(no output)",
          )
        ).text;
        const terminate =
          result.success &&
          typeof result.value === "object" &&
          result.value !== null &&
          "terminate" in result.value &&
          result.value.terminate === true;
        // A nested `pi.read` of an image returns image content blocks that
        // normalizeResult stripped (the sandbox holds text only). The provider
        // handed them out-of-band to each call audit; re-attach them here so
        // pi core's ToolExecutionComponent renders a kitty image preview — the
        // same path a native `read` takes — for single-call AND multitool
        // reads. pi-vision-handoff keeps the image in the nested tool_result
        // (its `context` hook swaps image→description on the LLM-bound
        // raft_exec clone), so every read audit carries its image here.
        const mediaBlocks: RaftMediaBlock[] = [];
        for (const audit of result.audits) {
          if (audit.media) mediaBlocks.push(...audit.media);
        }
        const singleAudit = result.audits.length === 1 ? result.audits[0] : undefined;
        // The read tool's own text note (e.g. "Read image file [image/png]"),
        // captured after the handoff stripped pi's non-vision note. Used as
        // the single-call body + content text so the preview shows the kitty
        // image + the clean note (like pi core) instead of the handoff's
        // verbose description. Multitool renders each read's note as its own
        // call body, so the joined program return suffices as the content text
        // there.
        const mediaNote = singleAudit?.mediaNote;
        // The base64 payload now lives in the result content; discard the
        // duplicate in-memory audit copies before returning.
        for (const audit of result.audits) {
          delete audit.media;
          delete audit.mediaNote;
        }
        const content: Array<{ type: "text"; text: string } | RaftMediaBlock> = [];
        if (mediaBlocks.length > 0) {
          // Mirror a native `read`: keep the image block(s) for pi core's kitty
          // render alongside the short note. The handoff's `context` hook
          // swaps each image for its description on the LLM-bound clone, so the
          // text-only model still receives the description while the terminal
          // shows the kitty image.
          const textOutput =
            singleAudit && mediaNote ? mediaNote : output === "(no output)" ? "" : output;
          if (textOutput) content.push({ type: "text", text: textOutput });
          for (const block of mediaBlocks) content.push(block);
          if (singleAudit && mediaNote) {
            singleAudit.result = mediaNote;
          }
        } else {
          content.push({ type: "text", text: output });
        }
        return {
          content,
          details: persistedRenderDetails(),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(terminate ? { terminate: true } : {}),
          ...(result.success ? {} : { isError: true }),
        };
      },
    }),
    {
      mode: codePreviewSettings.toolCallBackground,
      toolCallTiming: codePreviewSettings.toolCallTiming,
    },
  );
};
