import { stableJsonHash } from "../core/stable-hash.js";
import type {
  RaftModelGuidance,
  RaftModelGuidanceInfo,
  RaftModelGuidancePlacement,
  RaftModelGuidanceTarget,
} from "./types.js";

export const RAFT_EXECUTION_GUIDANCE_SLOT = "raft.execution";
export const MAX_RAFT_MODEL_GUIDANCE_PER_COMPONENT = 64;
export const MAX_RAFT_MODEL_GUIDANCE_CONTENT_CHARS = 32_000;
export const MAX_RAFT_MODEL_GUIDANCE_TOTAL_CHARS = 64_000;
export const MAX_RAFT_MODEL_GUIDANCE_REGISTRATIONS = 1_024;
export const MAX_RAFT_MODEL_GUIDANCE_SNAPSHOT_CHARS = 1_000_000;

const MAX_LABEL_CHARS = 128;
const MAX_SLOT_CHARS = 128;
const MAX_MODEL_PATTERNS = 32;
const MAX_MODEL_PATTERN_CHARS = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const REGEX_CHARACTER = /[\\^$+.[\]{}()|]/;

export interface NormalizedRaftModelGuidance {
  label: string;
  models: string[];
  content: string;
  targets: RaftModelGuidanceTarget[];
  placement: RaftModelGuidancePlacement;
  slot?: string;
}

export interface RaftOwnedModelGuidance extends NormalizedRaftModelGuidance {
  componentId: string;
  component: string;
  revision: number;
}

const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareRaftOwnedModelGuidance = (
  left: RaftOwnedModelGuidance,
  right: RaftOwnedModelGuidance,
): number =>
  compareStableText(left.componentId, right.componentId) ||
  compareStableText(left.label, right.label);

export interface RaftGuidanceDefaultSlot {
  slot: string;
  content: string;
}

export interface RaftResolvedModelGuidance {
  slotText: string;
  appendText: string;
  digest: string;
  sources: Array<{
    componentId: string;
    component: string;
    label: string;
    placement: RaftModelGuidancePlacement;
    slot?: string;
    contentHash: string;
  }>;
}

const guidanceError = (message: string): Error =>
  new Error(`Invalid Raft model guidance: ${message}`);

const normalizedIdentifier = (value: unknown, field: "label" | "slot", max: number): string => {
  if (typeof value !== "string") throw guidanceError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw guidanceError(`${field} must not be empty`);
  if (normalized.length > max) throw guidanceError(`${field} exceeds ${max} characters`);
  if (CONTROL_CHARACTER.test(normalized)) {
    throw guidanceError(`${field} must not contain control characters`);
  }
  return normalized;
};

const normalizeTargets = (
  targets: readonly RaftModelGuidanceTarget[] | undefined,
): RaftModelGuidanceTarget[] => {
  if (targets === undefined) return ["main", "participant"];
  if (!Array.isArray(targets) || targets.length === 0) {
    throw guidanceError("targets must contain main and/or participant");
  }
  const normalized: RaftModelGuidanceTarget[] = [];
  for (const target of targets) {
    if (target !== "main" && target !== "participant") {
      throw guidanceError(`unsupported target ${String(target)}`);
    }
    if (!normalized.includes(target)) normalized.push(target);
  }
  return normalized;
};

export const normalizeRaftModelGuidance = (
  guidance: RaftModelGuidance,
): NormalizedRaftModelGuidance => {
  if (!guidance || typeof guidance !== "object" || Array.isArray(guidance)) {
    throw guidanceError("registration must be an object");
  }
  const label = normalizedIdentifier(guidance.label, "label", MAX_LABEL_CHARS);
  if (!Array.isArray(guidance.models) || guidance.models.length === 0) {
    throw guidanceError(`${label} must select at least one provider/model pattern`);
  }
  if (guidance.models.length > MAX_MODEL_PATTERNS) {
    throw guidanceError(`${label} selects more than ${MAX_MODEL_PATTERNS} model patterns`);
  }
  const models: string[] = [];
  for (const candidate of guidance.models) {
    if (typeof candidate !== "string") {
      throw guidanceError(`${label} model patterns must be strings`);
    }
    const pattern = candidate.trim();
    if (!pattern || pattern.length > MAX_MODEL_PATTERN_CHARS || !pattern.includes("/")) {
      throw guidanceError(
        `${label} model pattern ${JSON.stringify(candidate)} must be a provider/model glob of at most ${MAX_MODEL_PATTERN_CHARS} characters`,
      );
    }
    if (CONTROL_CHARACTER.test(pattern)) {
      throw guidanceError(`${label} model patterns must not contain control characters`);
    }
    if (!models.includes(pattern)) models.push(pattern);
  }
  if (typeof guidance.content !== "string" || !guidance.content.trim()) {
    throw guidanceError(`${label} content must be a non-empty string`);
  }
  const content = guidance.content.trim();
  if (content.length > MAX_RAFT_MODEL_GUIDANCE_CONTENT_CHARS) {
    throw guidanceError(
      `${label} content exceeds ${MAX_RAFT_MODEL_GUIDANCE_CONTENT_CHARS} characters`,
    );
  }
  const placement = guidance.placement ?? "append";
  if (placement !== "append" && placement !== "replace") {
    throw guidanceError(`${label} placement must be append or replace`);
  }
  const slot =
    guidance.slot === undefined
      ? undefined
      : normalizedIdentifier(guidance.slot, "slot", MAX_SLOT_CHARS);
  if (placement === "replace" && !slot) {
    throw guidanceError(`${label} replacement guidance requires a slot`);
  }
  if (placement === "append" && slot) {
    throw guidanceError(`${label} append guidance must not declare a slot`);
  }
  return {
    label,
    models,
    content,
    targets: normalizeTargets(guidance.targets),
    placement,
    ...(slot ? { slot } : {}),
  };
};

export const parseRaftOwnedModelGuidance = (value: unknown): RaftOwnedModelGuidance[] => {
  if (!Array.isArray(value) || value.length > MAX_RAFT_MODEL_GUIDANCE_REGISTRATIONS) return [];
  try {
    const parsed = value.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw guidanceError("serialized owner must be an object");
      }
      const record = candidate as Partial<RaftOwnedModelGuidance>;
      const normalized = normalizeRaftModelGuidance(record as RaftModelGuidance);
      if (
        typeof record.componentId !== "string" ||
        !record.componentId.trim() ||
        typeof record.component !== "string" ||
        !record.component.trim() ||
        !Number.isSafeInteger(record.revision) ||
        (record.revision ?? 0) < 1
      ) {
        throw guidanceError("serialized owner metadata is incomplete");
      }
      return {
        ...normalized,
        componentId: record.componentId.trim(),
        component: record.component.trim(),
        revision: record.revision!,
      };
    });
    if (
      parsed.reduce((sum, entry) => sum + entry.content.length, 0) >
      MAX_RAFT_MODEL_GUIDANCE_SNAPSHOT_CHARS
    )
      return [];
    return parsed;
  } catch {
    return [];
  }
};

export const raftModelGuidanceInfo = (
  guidance: NormalizedRaftModelGuidance,
): RaftModelGuidanceInfo => ({
  label: guidance.label,
  models: [...guidance.models],
  targets: [...guidance.targets],
  placement: guidance.placement,
  ...(guidance.slot ? { slot: guidance.slot } : {}),
  contentChars: guidance.content.length,
  contentHash: stableJsonHash(guidance.content),
});

const wildcardMatch = (pattern: string, value: string): boolean => {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += REGEX_CHARACTER.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u").test(value);
};

const raftModelGuidanceMatches = (
  guidance: NormalizedRaftModelGuidance,
  model: string,
  target: RaftModelGuidanceTarget,
): boolean =>
  guidance.targets.includes(target) &&
  guidance.models.some((pattern) => wildcardMatch(pattern, model));

const sourceInfo = (guidance: RaftOwnedModelGuidance) => ({
  componentId: guidance.componentId,
  component: guidance.component,
  label: guidance.label,
  placement: guidance.placement,
  ...(guidance.slot ? { slot: guidance.slot } : {}),
  contentHash: stableJsonHash(guidance.content),
});

export const resolveRaftModelGuidance = (
  guidance: readonly RaftOwnedModelGuidance[],
  options: {
    model?: string;
    target: RaftModelGuidanceTarget;
    defaults?: readonly RaftGuidanceDefaultSlot[];
    includeSlots?: boolean;
  },
): RaftResolvedModelGuidance => {
  const includeSlots = options.includeSlots !== false;
  const matching = options.model
    ? guidance.filter((entry) => raftModelGuidanceMatches(entry, options.model!, options.target))
    : [];
  const replacements = new Map<string, RaftOwnedModelGuidance[]>();
  const additions: RaftOwnedModelGuidance[] = [];
  for (const entry of matching) {
    if (entry.placement === "append") {
      additions.push(entry);
      continue;
    }
    if (!includeSlots || !entry.slot) continue;
    const existing = replacements.get(entry.slot) ?? [];
    existing.push(entry);
    replacements.set(entry.slot, existing);
  }

  const defaultSlots = options.defaults ?? [];
  const slotOrder = [
    ...defaultSlots.map((entry) => entry.slot),
    ...[...replacements.keys()]
      .filter((slot) => !defaultSlots.some((entry) => entry.slot === slot))
      .sort(compareStableText),
  ];
  const slotSections: string[] = [];
  const sources: RaftResolvedModelGuidance["sources"] = [];
  if (includeSlots) {
    for (const slot of slotOrder) {
      const candidates = replacements.get(slot) ?? [];
      if (candidates.length > 1) {
        const owners = candidates
          .map((entry) => `${entry.componentId}:${entry.label}`)
          .sort(compareStableText)
          .join(", ");
        throw new Error(
          `Raft guidance slot ${slot} has multiple replacements for ${options.model ?? "the current model"}: ${owners}`,
        );
      }
      const replacement = candidates[0];
      if (replacement) {
        slotSections.push(replacement.content);
        sources.push(sourceInfo(replacement));
        continue;
      }
      const fallback = defaultSlots.find((entry) => entry.slot === slot)?.content.trim();
      if (fallback) slotSections.push(fallback);
    }
  }

  additions.sort(compareRaftOwnedModelGuidance);
  for (const addition of additions) sources.push(sourceInfo(addition));
  const appendSections = additions.map((entry) => entry.content);
  const slotText = slotSections.join("\n\n");
  const appendText = appendSections.join("\n\n");
  const resolvedChars = slotText.length + appendText.length + (slotText && appendText ? 2 : 0);
  if (resolvedChars > MAX_RAFT_MODEL_GUIDANCE_TOTAL_CHARS) {
    throw new Error(
      `Resolved Raft model guidance exceeds ${MAX_RAFT_MODEL_GUIDANCE_TOTAL_CHARS} characters for ${options.model ?? "the current model"}`,
    );
  }
  return {
    slotText,
    appendText,
    sources,
    digest: stableJsonHash({
      model: options.model,
      target: options.target,
      slots: slotSections,
      additions: sources,
    }),
  };
};
