import type { AgentProfile } from "./worker-profiles.ts";

/** Minimal model registry capability needed by profile resolution. */
export interface ProfileModelRegistry<Model> {
   /** Resolve one provider and model identifier. */
   readonly find: (provider: string, id: string) => Model | undefined;
   /** List registered provider/model identifiers. */
   readonly getAll: () => ReadonlyArray<{ readonly provider: string; readonly id: string }>;
}

/** Parent model identity used when a profile does not override the model. */
export interface InheritedModelIdentity {
   /** Parent provider identifier. */
   readonly provider: string;
   /** Parent model identifier. */
   readonly id: string;
}

/**
 * Resolve a profile model without exposing model selection to workflow scripts.
 *
 * @param registry - Model registry used by the active Pi session.
 * @param profile - Profile containing an optional provider/model selector.
 * @param inherited - Parent model identity used as the default.
 * @returns The selected model or `undefined` when no model is available.
 */
export function resolveProfileModel<Model>(
   registry: ProfileModelRegistry<Model>,
   profile: Pick<AgentProfile, "model">,
   inherited?: InheritedModelIdentity
): Model | undefined {
   const hint = profile.model;
   if (!hint) {
      return inherited ? registry.find(inherited.provider, inherited.id) : undefined;
   }

   const slash = hint.indexOf("/");
   if (slash > 0) {
      const provider = hint.slice(0, slash);
      const id = hint.slice(slash + 1);
      const found = registry.find(provider, id);
      if (found) return found;
      throw new Error(`Unknown profile model "${hint}".`);
   }

   if (inherited) {
      const inheritedMatch = registry.find(inherited.provider, hint);
      if (inheritedMatch) return inheritedMatch;
   }

   const matches = registry.getAll().filter((model) => model.id === hint);
   if (matches.length === 1) {
      return registry.find(matches[0].provider, matches[0].id);
   }
   if (matches.length > 1) {
      throw new Error(
         `Profile model "${hint}" exists in multiple providers (${matches.map((model) => model.provider).join(", ")}).`
      );
   }
   throw new Error(`Unknown profile model "${hint}".`);
}
