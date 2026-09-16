export type RaftEffectConflictReason = "shared_resource" | "unknown_resource";

const reasonText = (reason: RaftEffectConflictReason): string =>
  reason === "unknown_resource"
    ? "unknown resource footprint; declare resources and ordering"
    : "shared noncommutative resource";

export const formatRaftEffectConflict = (
  target: string,
  resources: readonly string[],
  reason: RaftEffectConflictReason,
): string => `${target} [${resources.join(", ")}] (${reasonText(reason)})`;
