import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.js";
import type { RaftActivityRun } from "../activity/types.js";
import type { RaftState } from "../raft-state.js";
import { createDashboardSnapshot, RaftDashboardSnapshotCache } from "./snapshot.js";
import { isActiveStatus, type RaftDashboardSnapshot, type RaftUiAgent } from "./types.js";
import { RaftWidget, shouldShowRaftWidget } from "./widget.js";
import { AgentTranscriptReader, type RaftTranscriptSource } from "./transcript.js";

const WIDGET_ID = "pi-raft";
const ACTIVITY_REFRESH_MS = 100;

const emptySnapshot = (): RaftDashboardSnapshot => {
  const now = Date.now();
  return {
    now,
    runs: [],
    main: {
      id: "main",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: process.cwd(),
      startedAt: now,
      updatedAt: now,
      pendingMessages: false,
      local: true,
    },
    agents: [],
    componentGraph: { components: [], edges: [], cycles: [] },
    state: [],
  };
};

export class RaftUiController {
  #context: ExtensionContext | undefined;
  #snapshot: RaftDashboardSnapshot = emptySnapshot();
  #timer: NodeJS.Timeout | undefined;
  #activityUnsubscribe: (() => void) | undefined;
  #agentUnsubscribe: (() => void) | undefined;
  #scheduledRefresh: NodeJS.Timeout | undefined;
  #widgetTui: TUI | undefined;
  #dashboardTui: TUI | undefined;
  #widgetMounted = false;
  #widget: RaftWidget | undefined;
  #lastRefreshErrorAt = 0;
  #lastRefreshAt = 0;
  #dashboardOpen = false;
  #epoch = 0;
  #activityRevision: number | undefined;
  // Tracks whether #activityRuns was last fetched with full payloads. The
  // dashboard needs args/result/preview to render call detail; the periodic
  // refresh instead pulls payload-free summaries so streaming runs stop
  // paying a deep clone of up to 1,000 bounded call payloads per tick.
  #activityRunsDetailed = true;
  #activityRuns: RaftActivityRun[] = [];
  #activityView: ((detailed?: boolean) => RaftActivityRun[]) | undefined;
  readonly #transcripts = new AgentTranscriptReader();
  readonly #snapshotCache = new RaftDashboardSnapshotCache();

  constructor(
    readonly state: RaftState,
    readonly codePreviewSettings?: CodePreviewSettings,
  ) {}

  start(context: ExtensionContext): void {
    this.stop();
    this.#context = context;
    if (!this.state.config.appearance.ui.enabled || context.mode !== "tui") return;
    this.#activityUnsubscribe = this.state.activity.subscribe(() => this.#scheduleRefresh());
    this.#agentUnsubscribe = this.state.agents.subscribeUi(() => this.#scheduleRefresh());
    this.#refresh();
    this.#schedulePoll();
  }

  stop(): void {
    this.#epoch++;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
    this.#timer = undefined;
    this.#scheduledRefresh = undefined;
    this.#widget = undefined;
    this.#activityUnsubscribe?.();
    this.#activityUnsubscribe = undefined;
    this.#agentUnsubscribe?.();
    this.#agentUnsubscribe = undefined;
    if (this.#context?.mode === "tui") {
      this.#context.ui.setWidget(WIDGET_ID, undefined);
    }
    this.#context = undefined;
    this.#widgetTui = undefined;
    this.#dashboardTui = undefined;
    this.#widgetMounted = false;
    this.#snapshot = emptySnapshot();
    this.#lastRefreshErrorAt = 0;
    this.#lastRefreshAt = 0;
    this.#dashboardOpen = false;
    this.#activityRevision = undefined;
    this.#activityRunsDetailed = true;
    this.#activityRuns = [];
    this.#activityView = undefined;
    this.#transcripts.clear();
    this.#snapshotCache.clear();
  }

  /** True while Raft owns keyboard input, including asynchronous view setup. */
  get ownsInput(): boolean {
    return this.#dashboardOpen;
  }

  async openDashboard(context: ExtensionContext): Promise<void> {
    if (this.ownsInput) return;
    if (context.mode !== "tui") {
      context.ui.notify("The Raft dashboard is available in TUI mode", "warning");
      return;
    }
    if (!this.state.config.appearance.ui.enabled) {
      context.ui.notify("The Raft UI is disabled by ui.enabled", "warning");
      return;
    }
    if (!this.#context) this.start(context);
    // Set after start(): it calls stop(), which clears this flag. The flag
    // must be true before this refresh so the first dashboard frame renders
    // from full activity runs rather than stripped summaries.
    this.#dashboardOpen = true;
    this.#refresh();
    const { RaftDashboard } = await import("./dashboard.js");
    const reportUpdate = (message: string, update: Promise<unknown>): void => {
      void update
        .then(() => {
          context.ui.notify(message, "info");
          this.#refresh();
        })
        .catch((error) =>
          context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        );
    };
    const onAgentStop = (agentId: string): void => {
      reportUpdate("Agent stopped", this.state.agents.stop(agentId));
    };
    this.#schedulePoll(true);
    const epoch = this.#epoch;
    try {
      await context.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          this.#dashboardTui = tui;
          return new RaftDashboard(
            tui,
            theme,
            () => this.#snapshot,
            () => done(undefined),
            {
              keybindings,
              onAgentStop,
              agentTranscript: (agent, followLatest) =>
                this.#transcripts.read(this.#agentTranscriptSource(agent), followLatest),
            },
          );
        },
        {
          overlay: true,
          overlayOptions: {
            width: "94%",
            minWidth: 40,
            maxHeight: "90%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } finally {
      if (epoch === this.#epoch) {
        this.#dashboardOpen = false;
        this.#dashboardTui = undefined;
        this.#refresh();
        this.#schedulePoll(true);
      }
    }
  }

  snapshot(): RaftDashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  #schedulePoll(reset = false): void {
    if (reset && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#timer || !this.#context) return;
    const active =
      this.#snapshot.runs.some((run) => run.status === "running") ||
      this.#snapshot.agents.some((agent) => isActiveStatus(agent.status));
    if (!this.ownsInput && !active) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#refresh(false);
      this.#schedulePoll();
    }, this.state.config.appearance.ui.refreshMs);
    this.#timer.unref();
  }

  #scheduleRefresh(): void {
    if (this.#scheduledRefresh || !this.#context) return;
    const elapsed = performance.now() - this.#lastRefreshAt;
    const delay = Math.max(
      0,
      Math.min(ACTIVITY_REFRESH_MS, this.state.config.appearance.ui.refreshMs) - elapsed,
    );
    this.#scheduledRefresh = setTimeout(() => {
      this.#scheduledRefresh = undefined;
      this.#refresh();
      this.#schedulePoll(true);
    }, delay);
    this.#scheduledRefresh.unref();
  }

  #agentTranscriptSource(agent: RaftUiAgent): RaftTranscriptSource {
    return {
      id: agent.id,
      status: agent.status,
      ...(agent.logFile ? { logFile: agent.logFile } : {}),
    };
  }

  #refresh(force = true): void {
    this.#lastRefreshAt = performance.now();
    const context = this.#context;
    if (!context || !this.state.initialized) return;
    try {
      const revision =
        typeof this.state.activity.revision === "function"
          ? this.state.activity.revision()
          : undefined;
      const detailed = this.#dashboardOpen;
      if (
        revision === undefined ||
        revision !== this.#activityRevision ||
        detailed !== this.#activityRunsDetailed
      ) {
        if (!this.#activityView && typeof this.state.activity.createRunView === "function") {
          this.#activityView = this.state.activity.createRunView();
        }
        this.#activityRuns = this.#activityView
          ? this.#activityView(detailed)
          : detailed || typeof this.state.activity.runSummaries !== "function"
            ? this.state.activity.runs()
            : this.state.activity.runSummaries();
        this.#activityRevision = revision;
        this.#activityRunsDetailed = detailed;
      }
      if (force || this.#dashboardOpen) this.#snapshotCache.clear();
      this.#snapshot = createDashboardSnapshot(
        this.state,
        context,
        this.#activityRuns,
        this.#dashboardOpen ? undefined : this.#snapshotCache,
        this.#activityView !== undefined,
      );
      this.#renderWidget(context);
      if (this.#dashboardTui) this.#dashboardTui.requestRender();
      else if (this.#widgetTui && this.#widget?.hasChanged()) this.#widgetTui.requestRender();
    } catch (error) {
      const now = Date.now();
      if (now - this.#lastRefreshErrorAt >= 10_000) {
        this.#lastRefreshErrorAt = now;
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(`Raft dashboard refresh failed: ${message}`, "warning");
      }
    }
  }

  #renderWidget(context: ExtensionContext): void {
    const config = this.state.config.appearance.ui;
    const shouldShow =
      context.mode === "tui" && shouldShowRaftWidget(this.#snapshot, config.widget);
    if (shouldShow) {
      if (this.#widgetMounted) return;
      this.#widgetMounted = true;
      context.ui.setWidget(
        WIDGET_ID,
        (tui, theme) => {
          this.#widgetTui = tui;
          this.#widget = new RaftWidget(theme, () => this.#snapshot, config.maxRows);
          return this.#widget;
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    if (!this.#widgetMounted) return;
    context.ui.setWidget(WIDGET_ID, undefined);
    this.#widgetMounted = false;
    this.#widgetTui = undefined;
    this.#widget = undefined;
  }
}
