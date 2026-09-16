import type {
  RaftActivityCall,
  RaftActivityItem,
  RaftActivityPhase,
  RaftActivityRun,
} from "../activity/types.js";
import type { RaftComponentInfo } from "../components/types.js";
import type { RaftDashboardSnapshot, RaftUiAgent, RaftUiMain } from "./types.js";
import { isActiveStatus, orderAgentsByCreation } from "./types.js";

export type Entity =
  | { id: string; kind: "main"; label: string; status: string; value: RaftUiMain }
  | { id: string; kind: "agent"; label: string; status: string; value: RaftUiAgent }
  | { id: string; kind: "call"; label: string; status: string; value: RaftActivityCall }
  | { id: string; kind: "item"; label: string; status: string; value: RaftActivityItem }
  | { id: string; kind: "component"; label: string; status: string; value: RaftComponentInfo };
type PanelKind = "phase" | "unphased" | "session";
export interface PhasePanel {
  id: string;
  name: string;
  status: string;
  completed: number;
  total: number;
  phase?: RaftActivityPhase;
  kind: PanelKind;
  agents?: number;
  tokens?: number;
  elapsedMs?: number;
}
export type Pane = "phases" | "entities";
type OverviewView = "activity";
type EntityGroupKind = "agent" | "tool" | "extension" | "mcp" | "task" | "custom" | "component";
export interface EntityGroup {
  kind: EntityGroupKind;
  label: string;
  entries: Array<{ entity: Entity; index: number }>;
}
const groupOrder: readonly EntityGroupKind[] = [
  "agent",
  "tool",
  "extension",
  "mcp",
  "task",
  "custom",
  "component",
];
const groupLabels: Record<EntityGroupKind, string> = {
  agent: "Agents",
  tool: "Tools",
  extension: "Extensions",
  mcp: "MCP",
  task: "Tasks",
  custom: "Custom items",
  component: "Components",
};
const entityGroupKind = (entity: Entity): EntityGroupKind => {
  if (entity.kind === "main" || entity.kind === "agent") return "agent";
  if (entity.kind === "component") return "component";
  const kind = entity.kind === "call" ? entity.value.entityKind : entity.value.kind;
  return groupOrder.includes(kind as EntityGroupKind) ? (kind as EntityGroupKind) : "custom";
};
const groupRanks = new Map(groupOrder.map((kind, index) => [kind, index] as const));
const orderEntities = (entities: Entity[]): Entity[] =>
  entities
    .map((entity, index) => ({ entity, index }))
    .sort(
      (a, b) =>
        (groupRanks.get(entityGroupKind(a.entity)) ?? 99) -
          (groupRanks.get(entityGroupKind(b.entity)) ?? 99) || a.index - b.index,
    )
    .map(({ entity }) => entity);
export const groupEntities = (entities: Entity[]): EntityGroup[] => {
  const indexed = entities.map((entity, index) => ({ entity, index }));
  return groupOrder.flatMap((kind) => {
    const entries = indexed.filter(({ entity }) => entityGroupKind(entity) === kind);
    return entries.length ? [{ kind, label: groupLabels[kind], entries }] : [];
  });
};
export type StatusFilter = "all" | "active" | "completed" | "failed";
export const filters: StatusFilter[] = ["all", "active", "completed", "failed"];
const linked = (call: RaftActivityCall, agent: RaftUiAgent): boolean =>
  Boolean(
    call.entityId && (agent.id.startsWith(call.entityId) || call.entityId.startsWith(agent.id)),
  );
const mainEntity = (snapshot: RaftDashboardSnapshot): Entity => ({
  id: `main:${snapshot.main.id}`,
  kind: "main",
  label: "Main",
  status: snapshot.main.status,
  value: snapshot.main,
});
const UNPHASED = "__raft_unphased";
const SESSION = "__raft_session";
const entitiesFor = (
  snapshot: RaftDashboardSnapshot,
  run: RaftActivityRun | undefined,
  panel: PhasePanel | undefined,
): Entity[] => {
  if (!panel || panel.kind === "session") {
    const agents = orderAgentsByCreation(snapshot.agents)
      .filter((agent) => agent.runId !== run?.id && isActiveStatus(agent.status))
      .map(
        (agent): Entity => ({
          id: `agent:${agent.id}`,
          kind: "agent",
          label: agent.name,
          status: agent.status,
          value: agent,
        }),
      );
    const components = snapshot.componentGraph.components.map(
      (component): Entity => ({
        id: `component:${component.id}`,
        kind: "component",
        label: component.id,
        status: component.state,
        value: component,
      }),
    );
    return orderEntities([mainEntity(snapshot), ...agents, ...components]);
  }
  const calls =
    run?.calls.filter((call) =>
      panel.kind === "unphased" ? !call.phaseId : call.phaseId === panel.id,
    ) ?? [];
  const items =
    run?.items.filter((item) =>
      panel.kind === "unphased" ? !item.phaseId : item.phaseId === panel.id,
    ) ?? [];
  const agents = orderAgentsByCreation(snapshot.agents).filter(
    (agent) =>
      agent.runId === run?.id &&
      (panel.kind === "unphased" ? !agent.phaseId : agent.phaseId === panel.id),
  );
  return orderEntities([
    mainEntity(snapshot),
    ...agents.map(
      (agent): Entity => ({
        id: `agent:${agent.id}`,
        kind: "agent",
        label: agent.name,
        status: agent.status,
        value: agent,
      }),
    ),
    ...calls
      .filter(
        (call) =>
          !(
            call.kind === "agent" &&
            (call.ref === "agents.run" ||
              call.ref === "agents.spawn" ||
              call.ref === "agents.wait") &&
            agents.some((agent) => linked(call, agent))
          ),
      )
      .map(
        (call): Entity => ({
          id: `call:${call.id}`,
          kind: "call",
          label: call.label,
          status: call.status,
          value: call,
        }),
      ),
    ...items.map(
      (item): Entity => ({
        id: `item:${item.id}`,
        kind: "item",
        label: item.label,
        status: item.status,
        value: item,
      }),
    ),
  ]);
};
export const entitiesForOverview = (
  snapshot: RaftDashboardSnapshot,
  run: RaftActivityRun | undefined,
  panel: PhasePanel | undefined,
): Entity[] => entitiesFor(snapshot, run, panel);
const panelStatus = (entities: Entity[], fallback: string): string =>
  entities.some((e) => ["failed", "timed_out", "error"].includes(e.status))
    ? "failed"
    : entities.some((e) => e.status === "blocked")
      ? "blocked"
      : entities.some((e) => isActiveStatus(e.status))
        ? "running"
        : entities.length &&
            entities.every((e) =>
              ["completed", "done", "stopped", "cancelled", "idle"].includes(e.status),
            )
          ? "completed"
          : fallback;
const progress = (
  snapshot: RaftDashboardSnapshot,
  run: RaftActivityRun | undefined,
  panel: PhasePanel,
  entities: Entity[],
): PhasePanel => {
  const progressEntities =
    panel.kind === "session" ? entities : entities.filter((e) => e.kind !== "main");
  const status =
    panel.kind === "session"
      ? progressEntities.some((e) => isActiveStatus(e.status))
        ? "running"
        : "idle"
      : panelStatus(progressEntities, panel.status);
  const agents = progressEntities.filter((e) => e.kind === "agent");
  const tokens = agents.reduce(
    (sum, e) =>
      sum + (e.kind === "agent" && e.value.usage ? e.value.usage.input + e.value.usage.output : 0),
    0,
  );
  const starts = progressEntities
    .flatMap((e) =>
      e.kind === "agent" || e.kind === "call"
        ? [e.value.startedAt ?? 0]
        : e.kind === "item"
          ? [e.value.createdAt]
          : [],
    )
    .filter(Boolean);
  const finishes = progressEntities
    .flatMap((e) =>
      e.kind === "agent" || e.kind === "call"
        ? [e.value.finishedAt ?? 0]
        : e.kind === "item"
          ? [e.value.finishedAt ?? 0]
          : [],
    )
    .filter(Boolean);
  const active = progressEntities.some((e) => isActiveStatus(e.status));
  const startedAt = starts.length ? Math.min(...starts) : undefined;
  const finishedAt = active ? snapshot.now : finishes.length ? Math.max(...finishes) : undefined;
  return {
    ...panel,
    status,
    completed: progressEntities.filter((e) => e.status === "completed" || e.status === "done")
      .length,
    total: Math.max(panel.total, progressEntities.length),
    ...(agents.length ? { agents: agents.length } : {}),
    ...(tokens ? { tokens } : {}),
    ...(startedAt && finishedAt ? { elapsedMs: Math.max(0, finishedAt - startedAt) } : {}),
  };
};
export const phasePanels = (
  snapshot: RaftDashboardSnapshot,
  run: RaftActivityRun | undefined,
): PhasePanel[] => {
  const panels: PhasePanel[] = [];
  if (run) {
    const activity: PhasePanel = {
      id: UNPHASED,
      name: "Run activity",
      status: run.status,
      completed: 0,
      total: 0,
      kind: "unphased",
    };
    const activityEntities = entitiesFor(snapshot, run, activity);
    if (activityEntities.length > 1)
      panels.push(progress(snapshot, run, activity, activityEntities));
    for (const phase of run.phases) {
      const panel: PhasePanel = {
        id: phase.id,
        name: phase.name,
        status: phase.status,
        completed: 0,
        total: phase.total ?? 0,
        phase,
        kind: "phase",
      };
      panels.push(progress(snapshot, run, panel, entitiesFor(snapshot, run, panel)));
    }
  }
  const session: PhasePanel = {
    id: SESSION,
    name: "Agents and components",
    status: "idle",
    completed: 0,
    total: 0,
    kind: "session",
  };
  const sessionEntities = entitiesFor(snapshot, run, session);
  if (sessionEntities.length > 0 || panels.length === 0)
    panels.push(progress(snapshot, run, session, sessionEntities));
  return panels;
};
export const matchesFilter = (status: string, filter: StatusFilter): boolean =>
  filter === "all" || filter === "active"
    ? filter === "all" || isActiveStatus(status)
    : filter === "completed"
      ? status === "completed" || status === "done"
      : ["failed", "timed_out", "blocked", "error"].includes(status);
export const tokensFor = (
  snapshot: RaftDashboardSnapshot,
  run: RaftActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => !run || agent.runId === run.id)
    .reduce((sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0), 0);
