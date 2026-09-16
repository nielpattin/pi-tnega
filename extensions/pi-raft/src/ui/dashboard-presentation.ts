import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens, safeText } from "./format.js";
import { spinnerFrame } from "./spinner.js";
import type { Entity } from "./dashboard-model.js";

export const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out" || status === "error") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  if (status === "global") return "◇";
  return spinnerFrame();
};

export const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out" || status === "error")
    return theme.fg("error", value);
  if (status === "blocked" || status === "warning") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress") return theme.fg("accent", value);
  if (status === "global") return theme.fg("muted", value);
  return theme.fg("dim", value);
};

export const entityTail = (entity: Entity, now: number): string => {
  if (entity.kind === "main") {
    const main = entity.value;
    return [
      "host Pi",
      main.model,
      main.thinking,
      main.pendingMessages ? "messages queued" : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "agent") {
    const agent = entity.value;
    const narrative = safeText(agent.error ?? agent.text).slice(0, 140);
    const summary =
      agent.status === "blocked" && narrative
        ? `needs input: ${narrative}`
        : (agent.status === "failed" || agent.status === "timed_out") && narrative
          ? `error: ${narrative}`
          : agent.status === "completed" && narrative
            ? `result: ${narrative}`
            : (agent.currentTool ?? (agent.status === "running" ? "thinking" : undefined));
    return [
      summary,
      agent.runner,
      agent.model,
      agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
      agent.toolCalls !== undefined ? `${agent.toolCalls} tools` : undefined,
      agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "call") {
    const call = entity.value;
    return [
      call.ref,
      call.progress,
      call.metrics?.tokens !== undefined ? `${formatTokens(call.metrics.tokens)} tok` : undefined,
      call.metrics?.toolCalls !== undefined ? `${call.metrics.toolCalls} tools` : undefined,
      formatDuration((call.finishedAt ?? now) - call.startedAt),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "item") {
    const item = entity.value;
    return [
      item.current ?? item.detail,
      item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "component") {
    return [
      entity.value.guarantee,
      entity.value.parentId ? `child of ${entity.value.parentId}` : undefined,
      (entity.value.effects?.length ?? 0) > 0
        ? `${entity.value.effects!.length} effects`
        : undefined,
      entity.value.requirements.length > 0
        ? `${entity.value.requirements.length} requirements`
        : undefined,
      entity.value.provisions.length > 0
        ? `${entity.value.provisions.length} provisions`
        : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  return "";
};
