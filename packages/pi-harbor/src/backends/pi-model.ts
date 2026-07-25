import { mapThinkingLevel } from "../domain.js";

export { mapThinkingLevel };

export interface ModelRegistryLike {
   find(provider: string, id: string): any;
   getAll(): ReadonlyArray<{ provider: string; id: string }>;
}

export interface InheritedModelInfo {
   provider: string;
   id: string;
}

export function resolvePiModel(registry: ModelRegistryLike, hint?: string, inherited?: InheritedModelInfo): any {
   if (!hint) {
      if (!inherited) return undefined;
      return registry.find(inherited.provider, inherited.id) ?? undefined;
   }
   const slash = hint.indexOf("/");
   if (slash > 0) {
      const provider = hint.slice(0, slash);
      const id = hint.slice(slash + 1);
      const found = registry.find(provider, id);
      if (found) return found;
      throw new Error(`Unknown model "${hint}".`);
   }
   if (inherited) {
      const found = registry.find(inherited.provider, hint);
      if (found) return found;
   }
   const matches = registry.getAll().filter((m) => m.id === hint);
   if (matches.length === 1) return matches[0];
   if (matches.length > 1) {
      throw new Error(
         `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Use "provider/${hint}".`
      );
   }
   throw new Error(`Unknown model "${hint}".`);
}
