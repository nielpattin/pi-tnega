export interface TargetCandidate {
   id: string;
   name?: string;
}

export type TargetResolution<T extends TargetCandidate> =
   | { kind: "found"; session: T }
   | { kind: "ambiguous"; candidates: T[] }
   | { kind: "not_found" };

const ID_PREFIX_PATTERN = /^[0-9a-fA-F][0-9a-fA-F-]{3,}$/;
const PUBLIC_HANDLE_PREFIX = "chat-";

export function publicSessionTarget(sessionOrId: TargetCandidate | string): string {
   const id = typeof sessionOrId === "string" ? sessionOrId : sessionOrId.id;
   if (!ID_PREFIX_PATTERN.test(id)) {
      return typeof sessionOrId === "string" ? sessionOrId : (sessionOrId.name ?? sessionOrId.id);
   }
   return `${PUBLIC_HANDLE_PREFIX}${id.slice(0, 8)}`;
}

function normalizeTarget(target: string): string {
   let normalized = target.trim();
   if (normalized.toLowerCase().startsWith("session:")) {
      normalized = normalized.slice("session:".length).trim();
   }
   if (normalized.startsWith("@")) {
      normalized = normalized.slice(1).trim();
   }
   return normalized;
}

function parseRenderedTarget(target: string): { name?: string; idPrefix: string } | null {
   const hashMatch = target.match(/^(.+)#([0-9a-fA-F-]{4,})$/);
   if (hashMatch) {
      return { name: hashMatch[1]!.trim(), idPrefix: hashMatch[2]! };
   }

   const parenthesizedMatch = target.match(/^(.+)\s+\(([0-9a-fA-F-]{4,})\)$/);
   if (parenthesizedMatch) {
      return { name: parenthesizedMatch[1]!.trim(), idPrefix: parenthesizedMatch[2]! };
   }

   return null;
}

function resolveMatches<T extends TargetCandidate>(matches: T[]): TargetResolution<T> {
   if (matches.length === 1) {
      return { kind: "found", session: matches[0]! };
   }
   if (matches.length > 1) {
      return { kind: "ambiguous", candidates: matches };
   }
   return { kind: "not_found" };
}

function matchesIdPrefix(session: TargetCandidate, idPrefix: string): boolean {
   return session.id.toLowerCase().startsWith(idPrefix.toLowerCase());
}

export function resolveTarget<T extends TargetCandidate>(sessions: Iterable<T>, target: string): TargetResolution<T> {
   const candidates = Array.from(sessions);
   const normalized = normalizeTarget(target);
   if (!normalized) {
      return { kind: "not_found" };
   }

   const renderedTarget = parseRenderedTarget(normalized);
   if (renderedTarget) {
      const name = renderedTarget.name?.toLowerCase();
      const matches = candidates.filter(
         (session) =>
            matchesIdPrefix(session, renderedTarget.idPrefix) && (!name || session.name?.toLowerCase() === name)
      );
      return resolveMatches(matches);
   }

   const lowerTarget = normalized.toLowerCase();
   if (lowerTarget.startsWith(PUBLIC_HANDLE_PREFIX)) {
      const handlePrefix = normalized.slice(PUBLIC_HANDLE_PREFIX.length);
      return resolveMatches(candidates.filter((session) => matchesIdPrefix(session, handlePrefix)));
   }

   const exactIdMatches = candidates.filter((session) => session.id.toLowerCase() === normalized.toLowerCase());
   const exactIdResolution = resolveMatches(exactIdMatches);
   if (exactIdResolution.kind !== "not_found") {
      return exactIdResolution;
   }

   if (ID_PREFIX_PATTERN.test(normalized)) {
      const prefixResolution = resolveMatches(candidates.filter((session) => matchesIdPrefix(session, normalized)));
      if (prefixResolution.kind !== "not_found") {
         return prefixResolution;
      }
   }

   const lowerName = normalized.toLowerCase();
   return resolveMatches(candidates.filter((session) => session.name?.toLowerCase() === lowerName));
}

export function formatTargetCandidates(candidates: TargetCandidate[]): string {
   return candidates.map(publicSessionTarget).join(", ");
}
