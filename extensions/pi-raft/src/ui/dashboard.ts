import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.js";
import type { RaftActivityRun } from "../activity/types.js";
import {
  entitiesForOverview,
  filters,
  groupEntities,
  matchesFilter,
  phasePanels,
  tokensFor,
  type Entity,
  type Pane,
  type PhasePanel,
  type StatusFilter,
} from "./dashboard-model.js";
import { colorStatus, entityTail, statusGlyph } from "./dashboard-presentation.js";
import { DashboardDetailRenderer } from "./dashboard-detail.js";
import {
  formatClock,
  formatDuration,
  formatTokens,
  padToWidth,
  safeText,
  wrapPlainText,
} from "./format.js";
import type { RaftAgentTranscript } from "./transcript.js";
import type { RaftDashboardSnapshot, RaftUiAgent } from "./types.js";
import { isActiveStatus } from "./types.js";

const OVERLAY_HEIGHT_PERCENT = 90;
const VERTICAL_MARGIN = 1;
const overlayRows = (rows: number): number =>
  Math.max(
    1,
    Math.min(Math.floor((rows * OVERLAY_HEIGHT_PERCENT) / 100), rows - VERTICAL_MARGIN * 2),
  );

interface DashboardKeybindings {
  matches(data: string, keybinding: "app.tools.expand"): boolean;
  getKeys(keybinding: "app.tools.expand"): string[];
}

export class RaftDashboard implements Component, Focusable {
  focused = false;
  private pane: Pane = "phases";
  private phaseIndex = 0;
  private entityIndex = 0;
  private runIndex = 0;
  private selectedRunId: string | undefined;
  private selectedEntityId: string | undefined;
  private selectedPhaseId: string | undefined;
  private filter: StatusFilter = "all";
  private detailId: string | undefined;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private detailView: "summary" | "transcript" = "summary";
  private transcriptPageAnchor: "start" | "end" | undefined;
  private transcriptToolsExpanded = false;
  private transcriptFollowing = true;
  private mode: "overview" | "detail" | "help" = "overview";
  private pendingStop: { id: string; expiresAt: number } | undefined;
  private readonly detailRenderer: DashboardDetailRenderer;
  private readonly agentTranscript:
    | ((agent: RaftUiAgent, followLatest: boolean) => RaftAgentTranscript)
    | undefined;
  private readonly onAgentStop: ((agentId: string) => void) | undefined;
  private readonly keybindings: DashboardKeybindings | undefined;

  constructor(
    readonly tui: TUI,
    readonly theme: Theme,
    readonly snapshot: () => RaftDashboardSnapshot,
    readonly done: () => void,
    options: {
      codePreviewSettings?: CodePreviewSettings;
      keybindings?: DashboardKeybindings;
      onAgentStop?: (agentId: string) => void;
      agentTranscript?: (agent: RaftUiAgent, followLatest: boolean) => RaftAgentTranscript;
    } = {},
  ) {
    this.keybindings = options.keybindings;
    this.onAgentStop = options.onAgentStop;
    this.agentTranscript = options.agentTranscript;
    this.detailRenderer = new DashboardDetailRenderer(tui, theme, snapshot, {
      agentTranscript: options.agentTranscript,
      codePreviewSettings: options.codePreviewSettings,
    });
    this.focused = true;
  }

  handleInput(data: string): void {
    if (this.mode === "help") {
      if (data === "?" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))
        this.mode = this.detailId ? "detail" : "overview";
      this.tui.requestRender();
      return;
    }
    const snapshot = this.snapshot();
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const allEntities = entitiesForOverview(snapshot, run, panel);
    const entities = allEntities.filter(
      (entity) => entity.kind === "main" || matchesFilter(entity.status, this.filter),
    );
    this.syncEntitySelection(entities, this.pane === "entities");

    if (data === "?") {
      this.mode = "help";
      this.tui.requestRender();
      return;
    }
    if (this.detailId) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        matchesKey(data, Key.left) ||
        data === "h"
      ) {
        this.closeDetail();
      } else if (data === "t") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail?.kind === "agent" && this.agentTranscript) {
          this.detailView = this.detailView === "summary" ? "transcript" : "summary";
          this.detailScroll = 0;
          this.transcriptPageAnchor = undefined;
          this.transcriptFollowing = true;
        }
      } else if (this.detailView === "transcript" && this.matchesTranscriptToolToggle(data)) {
        this.transcriptToolsExpanded = !this.transcriptToolsExpanded;
      } else if (matchesKey(data, Key.up) || data === "k") {
        if (this.detailScroll > 0) {
          this.detailScroll--;
          this.transcriptFollowing = false;
        }
      } else if (matchesKey(data, Key.down) || data === "j") {
        if (this.detailScroll < this.detailMaxScroll) {
          this.detailScroll++;
          this.transcriptFollowing = false;
        }
      } else if (data === "G" && this.detailView === "transcript") {
        this.transcriptFollowing = true;
        this.detailScroll = this.detailMaxScroll;
      } else if (matchesKey(data, Key.home) || data === "g") {
        this.transcriptFollowing = false;
        this.detailScroll = 0;
      } else if (data === "x") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail?.kind === "agent") this.requestAgentStop(detail);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "phases" ? "entities" : "phases";
    } else if (matchesKey(data, Key.left) || data === "h") {
      this.pane = "phases";
    } else if (matchesKey(data, Key.right) || data === "l") {
      this.pane = "entities";
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.max(0, this.phaseIndex - 1);
        this.selectedPhaseId = panels[this.phaseIndex]?.id;
      } else {
        this.entityIndex = Math.max(0, this.entityIndex - 1);
        this.selectedEntityId = entities[this.entityIndex]?.id;
      }
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.min(Math.max(0, panels.length - 1), this.phaseIndex + 1);
        this.selectedPhaseId = panels[this.phaseIndex]?.id;
      } else {
        this.entityIndex = Math.min(Math.max(0, entities.length - 1), this.entityIndex + 1);
        this.selectedEntityId = entities[this.entityIndex]?.id;
      }
    } else if (data === "f") {
      this.filter = filters[(filters.indexOf(this.filter) + 1) % filters.length] ?? "all";
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
    } else if (data === "[") {
      this.runIndex = Math.min(Math.max(0, snapshot.runs.length - 1), this.runIndex + 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
    } else if (data === "]") {
      this.runIndex = Math.max(0, this.runIndex - 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
    } else if (matchesKey(data, Key.enter)) {
      if (this.pane === "phases") this.pane = "entities";
      else {
        const entity = entities[this.entityIndex];
        if (entity) {
          this.detailId = entity.id;
          this.detailView = "summary";
          this.detailScroll = 0;
        }
      }
    } else if (data === "x") {
      const entity = entities[this.entityIndex];
      if (entity?.kind === "agent") this.requestAgentStop(entity);
    }
    this.syncPhase(run, panels);
    this.syncEntitySelection(entities, false);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.mode === "help") return this.renderHelp(width);
    const snapshot = this.snapshot();
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const allEntities = entitiesForOverview(snapshot, run, panel);
    const entities = allEntities.filter(
      (entity) => entity.kind === "main" || matchesFilter(entity.status, this.filter),
    );
    this.syncEntitySelection(entities, this.pane === "entities");
    if (this.detailId) {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail) return this.renderDetail(width, snapshot, detail);
      this.closeDetail();
    }
    return this.renderOverview(width, snapshot, run, panels, entities);
  }

  invalidate(): void {
    this.detailRenderer.invalidate();
  }

  dispose(): void {
    this.pendingStop = undefined;
    this.detailRenderer.invalidate();
    this.mode = "overview";
  }

  private requestAgentStop(entity: Extract<Entity, { kind: "agent" }>): void {
    if (!this.onAgentStop || !isActiveStatus(entity.status)) return;
    const now = Date.now();
    if (this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > now) {
      this.pendingStop = undefined;
      this.onAgentStop(entity.value.id);
      return;
    }
    this.pendingStop = { id: entity.value.id, expiresAt: now + 2_000 };
  }

  private matchesTranscriptToolToggle(data: string): boolean {
    const keybindings = this.keybindings ?? getKeybindings();
    const keys = keybindings.getKeys("app.tools.expand");
    return keys.length > 0
      ? keybindings.matches(data, "app.tools.expand")
      : matchesKey(data, Key.ctrl("o"));
  }

  private transcriptToolToggleHint(): string {
    const keys = (this.keybindings ?? getKeybindings()).getKeys("app.tools.expand");
    return `${keys.length > 0 ? keys.join("/") : "ctrl+o"} ${this.transcriptToolsExpanded ? "collapse" : "expand"} tools`;
  }

  private renderOverview(
    width: number,
    snapshot: RaftDashboardSnapshot,
    run: RaftActivityRun | undefined,
    panels: PhasePanel[],
    entities: Entity[],
  ): string[] {
    if (width < 24) return [truncateToWidth("too narrow · need 24 cols", width, "")];
    const rows = overlayRows(this.tui.terminal?.rows ?? process.stdout.rows ?? 28);
    const title = `Raft · ${run?.name ?? "session"} · Activity`;
    const agents = run
      ? snapshot.agents.filter((agent) => agent.runId === run.id)
      : snapshot.agents;
    const active = agents.filter((agent) => isActiveStatus(agent.status)).length;
    const tokens = tokensFor(snapshot, run);
    const summary = [
      run?.status,
      `${active}/${agents.length} agents active`,
      tokens > 0 ? `${formatTokens(tokens)} tok` : undefined,
      run ? formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt) : undefined,
      snapshot.runs.length > 1 ? `run ${this.runIndex + 1}/${snapshot.runs.length}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const lines = [
      this.topBorder(width, title),
      this.row(width, summary || "No Raft activity yet"),
      this.middleBorder(width),
    ];
    const bodyHeight = Math.max(1, rows - 8);
    const phaseHeight = Math.max(2, Math.min(panels.length + 1, Math.floor(bodyHeight * 0.45)));
    for (const line of this.renderPhasePanel(panels, width - 2, phaseHeight))
      lines.push(this.row(width, line));
    lines.push(this.row(width, this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 2)))));
    for (const line of this.renderEntityPanel(
      entities,
      width - 2,
      Math.max(1, bodyHeight - phaseHeight - 1),
      snapshot.now,
    ))
      lines.push(this.row(width, line));
    const events = run?.events.slice(-2) ?? [];
    if (events.length > 0) {
      lines.push(this.middleBorder(width));
      for (const event of events)
        lines.push(
          this.row(
            width,
            colorStatus(
              this.theme,
              event.level === "success" ? "completed" : event.level,
              `[${formatClock(event.createdAt)}] ${safeText(event.message)}`,
            ),
          ),
        );
    }
    lines.push(this.middleBorder(width));
    lines.push(
      this.row(
        width,
        this.theme.fg(
          "dim",
          "↑↓/jk select · ←→/tab pane · enter inspect · f filter · [ ] runs · ? help · esc close",
        ),
      ),
    );
    const selected = this.pane === "entities" ? entities[this.entityIndex] : undefined;
    lines.push(
      this.row(
        width,
        selected ? this.theme.fg("muted", `  ${this.overviewActionHint(selected)}`) : "",
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.slice(0, rows).map((line) => truncateToWidth(line, width, ""));
  }

  private renderPhasePanel(panels: PhasePanel[], width: number, height: number): string[] {
    const lines = panels.map((panel, index) => {
      const selected = index === this.phaseIndex && this.pane === "phases";
      const progress = panel.total > 0 ? ` ${panel.completed}/${panel.total}` : "";
      const text = `${selected ? "›" : " "} ${colorStatus(this.theme, panel.status, statusGlyph(panel.status))} ${safeText(panel.name)}${progress}`;
      return truncateToWidth(
        selected ? this.theme.bg("selectedBg", padToWidth(text, width)) : text,
        width,
        "",
      );
    });
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderEntityPanel(
    entities: Entity[],
    width: number,
    height: number,
    now: number,
  ): string[] {
    const rows: string[] = [];
    for (const group of groupEntities(entities)) {
      rows.push(
        this.theme.fg("muted", `  ${this.theme.bold(group.label)} (${group.entries.length})`),
      );
      for (const entry of group.entries) {
        const selected = entry.index === this.entityIndex && this.pane === "entities";
        const lead = `${selected ? "›" : " "} ${colorStatus(this.theme, entry.entity.status, statusGlyph(entry.entity.status))} ${safeText(entry.entity.label)}`;
        const tail = safeText(entityTail(entry.entity, now));
        const text = tail ? `${lead}  ${this.theme.fg("dim", tail)}` : lead;
        rows.push(
          truncateToWidth(
            selected ? this.theme.bg("selectedBg", padToWidth(text, width)) : text,
            width,
            "",
          ),
        );
      }
    }
    if (entities.length === 0) rows.push(this.theme.fg("dim", `  (no ${this.filter} activity)`));
    while (rows.length < height) rows.push("");
    return rows.slice(0, height);
  }

  private renderDetail(width: number, snapshot: RaftDashboardSnapshot, entity: Entity): string[] {
    const result = this.detailRenderer.render(
      width,
      snapshot,
      entity,
      {
        view: this.detailView,
        scroll: this.detailScroll,
        pageAnchor: this.transcriptPageAnchor,
        transcriptFollowing: this.transcriptFollowing,
        transcriptToolsExpanded: this.transcriptToolsExpanded,
      },
      this.detailActionHint(entity),
      this.transcriptToolToggleHint(),
    );
    this.detailScroll = result.scroll;
    this.detailMaxScroll = result.maxScroll;
    this.transcriptPageAnchor = result.pageAnchor;
    return result.lines;
  }

  private overviewActionHint(entity: Entity): string {
    if (entity.kind === "agent")
      return `${this.agentTranscript ? "space transcript · " : ""}${this.onAgentStop ? "x twice stop · " : ""}enter details`;
    return "enter details";
  }

  private detailActionHint(entity: Entity): string {
    if (entity.kind !== "agent") return "Read-only detail.";
    const actions = [
      this.agentTranscript ? "t transcript" : undefined,
      this.onAgentStop && isActiveStatus(entity.status)
        ? this.pendingStop?.id === entity.value.id
          ? "x again to confirm stop"
          : "x stop"
        : undefined,
    ].filter((value): value is string => Boolean(value));
    return actions.length > 0
      ? `One-shot agent actions: ${actions.join(" · ")}`
      : "One-shot agent controls are unavailable.";
  }

  private renderHelp(width: number): string[] {
    if (width < 24) return [truncateToWidth("dashboard help · ? or esc close", width, "")];
    const lines = [this.topBorder(width, "Raft dashboard help")];
    const help: Array<[string, string]> = [
      ["Navigate", "↑↓/jk select · ←→/tab switch pane · enter inspect · esc close"],
      ["Activity", "[ ] older/newer run · f cycle status filter"],
      ["Agents", "space preview transcript · x twice stop a running one-shot agent"],
      ["Details", "↑↓/jk scroll · g top · G follow latest · t transcript/summary · ? close help"],
    ];
    for (const [label, text] of help) {
      const prefix = `${this.theme.fg("accent", `${label}:`)} `;
      for (const line of wrapPlainText(text, Math.max(1, width - 2 - visibleWidth(prefix)), 3))
        lines.push(this.row(width, prefix + line));
    }
    lines.push(
      this.middleBorder(width),
      this.row(width, this.theme.fg("dim", "  ? or esc close")),
      this.bottomBorder(width),
    );
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private syncEntitySelection(entities: Entity[], preferAttention: boolean): void {
    if (entities.length === 0) {
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
      return;
    }
    const retained = this.selectedEntityId
      ? entities.findIndex((entity) => entity.id === this.selectedEntityId)
      : -1;
    const attention = preferAttention
      ? entities.findIndex(
          (entity) =>
            entity.kind !== "main" &&
            (entity.status === "blocked" || isActiveStatus(entity.status)),
        )
      : -1;
    this.entityIndex =
      retained >= 0
        ? retained
        : attention >= 0
          ? attention
          : Math.max(0, Math.min(this.entityIndex, entities.length - 1));
    this.selectedEntityId = entities[this.entityIndex]?.id;
  }

  private selectRun(snapshot: RaftDashboardSnapshot): RaftActivityRun | undefined {
    if (snapshot.runs.length === 0) {
      this.runIndex = 0;
      this.selectedRunId = undefined;
      return undefined;
    }
    const retained = this.selectedRunId
      ? snapshot.runs.findIndex((run) => run.id === this.selectedRunId)
      : -1;
    this.runIndex =
      retained >= 0 ? retained : Math.max(0, Math.min(this.runIndex, snapshot.runs.length - 1));
    this.selectedRunId = snapshot.runs[this.runIndex]?.id;
    return snapshot.runs[this.runIndex];
  }

  private syncPhase(run: RaftActivityRun | undefined, panels: PhasePanel[]): void {
    if (panels.length === 0) {
      this.phaseIndex = 0;
      this.selectedPhaseId = undefined;
      return;
    }
    const retained = this.selectedPhaseId
      ? panels.findIndex((panel) => panel.id === this.selectedPhaseId)
      : -1;
    this.phaseIndex =
      retained >= 0 ? retained : Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    this.selectedPhaseId = panels[this.phaseIndex]?.id;
    if (run?.currentPhaseId && retained < 0) {
      const current = panels.findIndex((panel) => panel.id === run.currentPhaseId);
      if (current >= 0) {
        this.phaseIndex = current;
        this.selectedPhaseId = panels[current]?.id;
      }
    }
  }

  private closeDetail(): void {
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.detailView = "summary";
    this.transcriptPageAnchor = undefined;
    this.transcriptFollowing = true;
  }

  private topBorder(width: number, title: string): string {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const styled = ` ${this.theme.fg("accent", truncateToWidth(safeText(title), Math.max(0, width - 6)))} `;
    const remaining = Math.max(0, width - 2 - visibleWidth(styled));
    const left = Math.floor(remaining / 2);
    return `${border(`╭${"─".repeat(left)}`)}${styled}${border(`${"─".repeat(remaining - left)}╮`)}`;
  }
  private middleBorder(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }
  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }
  private row(width: number, content: string): string {
    return `${this.theme.fg("borderMuted", "│")}${padToWidth(content, Math.max(0, width - 2))}${this.theme.fg("borderMuted", "│")}`;
  }
}
