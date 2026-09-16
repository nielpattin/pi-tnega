import type { ResolvedRaftAction } from "../core/action-registry.js";
import type {
  RaftComponentEffectConflict,
  RaftComponentEffectInfo,
  RaftComponentEffectOptions,
  RaftComponentEffectRegistration,
} from "./types.js";

export class RaftComponentIndependenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaftComponentIndependenceError";
  }
}

const normalizeResources = (resources: readonly string[] | undefined): string[] => {
  const normalized = [
    ...new Set(
      (resources ?? [])
        .filter(
          (resource): resource is string => typeof resource === "string" && resource.length > 0,
        )
        .map((resource) => resource.slice(0, 256)),
    ),
  ].slice(0, 64);
  return normalized.length > 0 ? normalized : ["*"];
};

export const trackedRegistration = (
  registration: RaftComponentEffectRegistration | undefined,
  fallbackLabel: string,
): RaftComponentEffectOptions => {
  if (typeof registration === "string") return { label: registration };
  return { label: fallbackLabel, ...registration };
};

export const registrationEffect = (
  registration: RaftComponentEffectOptions,
): RaftComponentEffectInfo => ({
  label: registration.label?.trim().slice(0, 256) || "anonymous",
  kind: registration.kind ?? "transactional",
  resources: normalizeResources(registration.resources),
  ordering: registration.ordering ?? "unknown",
});

export const actionEffect = (action: ResolvedRaftAction): RaftComponentEffectInfo | undefined => {
  if (!action.effect || action.effect.kind === "none") return undefined;
  return {
    label: action.ref,
    kind: action.effect.kind,
    resources: normalizeResources(action.effect.resources),
    ordering: action.effect.ordering ?? "unknown",
  };
};

interface RaftComponentEffectSummary {
  hasEffects: boolean;
  hasNoncommutative: boolean;
  hasUnknown: boolean;
  hasUnknownNoncommutative: boolean;
  resourceNoncommutative: Map<string, boolean>;
}

type RaftComponentConflictBasis = Omit<RaftComponentEffectConflict, "withComponent">;

export const summarizeEffects = (
  effects: readonly RaftComponentEffectInfo[],
): RaftComponentEffectSummary => {
  const resourceNoncommutative = new Map<string, boolean>();
  let hasNoncommutative = false;
  let hasUnknown = false;
  let hasUnknownNoncommutative = false;
  let effectful = 0;
  for (const effect of effects) {
    if (effect.kind === "none") continue;
    effectful++;
    const noncommutative = effect.ordering !== "commutative";
    hasNoncommutative ||= noncommutative;
    for (const resource of effect.resources) {
      if (resource === "*") {
        hasUnknown = true;
        hasUnknownNoncommutative ||= noncommutative;
      } else {
        resourceNoncommutative.set(
          resource,
          (resourceNoncommutative.get(resource) ?? false) || noncommutative,
        );
      }
    }
  }
  return {
    hasEffects: effectful > 0,
    hasNoncommutative,
    hasUnknown,
    hasUnknownNoncommutative,
    resourceNoncommutative,
  };
};

export const effectConflictsBetween = (
  left: RaftComponentEffectSummary,
  right: RaftComponentEffectSummary,
): RaftComponentConflictBasis[] => {
  if (!left.hasEffects || !right.hasEffects) return [];
  const conflicts: RaftComponentConflictBasis[] = [];
  if (
    (left.hasUnknown && (left.hasUnknownNoncommutative || right.hasNoncommutative)) ||
    (right.hasUnknown && (right.hasUnknownNoncommutative || left.hasNoncommutative))
  ) {
    conflicts.push({ resources: ["*"], reason: "unknown_resource" });
  }
  const overlap = [...left.resourceNoncommutative.keys()]
    .filter(
      (resource) =>
        right.resourceNoncommutative.has(resource) &&
        ((left.resourceNoncommutative.get(resource) ?? false) ||
          (right.resourceNoncommutative.get(resource) ?? false)),
    )
    .sort();
  if (overlap.length > 0) {
    conflicts.push({ resources: overlap, reason: "shared_resource" });
  }
  return conflicts;
};

export const compareEffectInfo = (
  left: RaftComponentEffectInfo,
  right: RaftComponentEffectInfo,
): number =>
  left.label.localeCompare(right.label) ||
  left.kind.localeCompare(right.kind) ||
  left.ordering.localeCompare(right.ordering) ||
  left.resources.join("\0").localeCompare(right.resources.join("\0"));
