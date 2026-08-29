import { getWebAccessConfig } from "../config.ts";
import type { ResearchOptions, ResearchProviderId, ResearchResponse } from "../domain.ts";
import { researchExa } from "./exa.ts";
import { researchFirecrawl } from "./firecrawl.ts";

export function resolveResearchProvider(requested?: ResearchProviderId | "auto"): ResearchProviderId | undefined {
   if (requested && requested !== "auto") {
      return requested;
   }

   const config = getWebAccessConfig();

   if (config.defaultProvider === "firecrawl" && config.firecrawlApiKey) {
      return "firecrawl";
   }
   if (config.defaultProvider === "exa" && config.exaApiKey) {
      return "exa";
   }

   if (config.firecrawlApiKey) {
      return "firecrawl";
   }
   if (config.exaApiKey) {
      return "exa";
   }

   return undefined;
}

export async function executeResearch(options: ResearchOptions): Promise<ResearchResponse> {
   const startTime = Date.now();
   const query = options.query.trim();
   const provider = resolveResearchProvider(options.provider);

   if (!provider) {
      return {
         query,
         provider: "research",
         synthesis: "",
         sources: [],
         durationMs: Date.now() - startTime,
         error: "No research provider configured. Please configure FIRECRAWL_API_KEY or EXA_API_KEY."
      };
   }

   let result: ResearchResponse;

   switch (provider) {
      case "firecrawl":
         result = await researchFirecrawl(options);
         break;
      case "exa":
         result = await researchExa(options);
         break;
      default:
         result = {
            query,
            provider: "research",
            synthesis: "",
            sources: [],
            error: `Unsupported research provider: "${String(provider)}"`
         };
         break;
   }

   return {
      ...result,
      durationMs: Date.now() - startTime
   };
}
