import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWebAccessConfig } from "../config.ts";
import type { ResearchOptions, ResearchProviderId, ResearchResponse } from "../domain.ts";
import { researchExa } from "./exa.ts";
import { researchLLM } from "./llm.ts";

export type ResearchProgressCallback = (partial: Partial<ResearchResponse>) => void;

export function resolveResearchProvider(requested?: ResearchProviderId): ResearchProviderId {
   if (requested) {
      return requested;
   }

   const config = getWebAccessConfig();

   if (config.researchProvider === "exa" && config.exaApiKey) {
      return "exa";
   }

   return "llm";
}

export async function executeResearch(
   options: ResearchOptions,
   ctx?: ExtensionContext,
   onProgress?: ResearchProgressCallback
): Promise<ResearchResponse> {
   const startTime = Date.now();
   const provider = resolveResearchProvider(options.provider);

   let result: ResearchResponse;

   switch (provider) {
      case "exa":
         result = await researchExa(options);
         break;

      case "llm":
      default: {
         result = await researchLLM(options, ctx, onProgress);

         // If in-harness search produced no results and Exa is configured, fallback to Exa Agent
         if ((result.error || result.sources.length === 0) && getWebAccessConfig().exaApiKey) {
            const exaResult = await researchExa(options);
            if (!exaResult.error && exaResult.sources.length > 0) {
               result = exaResult;
            }
         }
         break;
      }
   }

   return {
      ...result,
      durationMs: Date.now() - startTime
   };
}

export { researchLLM } from "./llm.ts";
export { researchExa } from "./exa.ts";
