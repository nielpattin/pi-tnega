import { resolveAgyCliModel } from "../backends/agy.ts";
import type { BackendName, ReasoningEffort } from "../domain.ts";
import type { AgentProfile } from "./types.ts";

export interface ResolvedSpawnParams {
   harness: BackendName;
   model?: string;
   reasoningEffort?: ReasoningEffort;
   tools?: string[];
   body?: string;
}

export function resolveProfileSpawnParams(profile: AgentProfile): ResolvedSpawnParams {
   if (profile.harness === "pi") {
      const model = profile.pi.model || undefined;
      const reasoningEffort = profile.pi.reasoning_effort || undefined;
      const tools = profile.pi.tools ?? profile.tools;
      const body = profile.pi.body ?? profile.body;
      return {
         harness: "pi",
         model,
         reasoningEffort,
         tools,
         body
      };
   } else {
      const model = resolveAgyCliModel(profile.agy.model, profile.agy.reasoning_effort);
      const body = profile.agy.body ?? profile.body;
      return {
         harness: "agy",
         model,
         reasoningEffort: profile.agy.reasoning_effort,
         body
      };
   }
}
