import { getWebAccessConfig } from "../config.ts";
import type {
   SearchMode,
   SearchOptions,
   SearchProviderDefinition,
   SearchProviderId,
   SearchResponse
} from "../domain.ts";
import { MemoryCache } from "../utils/cache.ts";
import { searchBrave } from "./brave.ts";
import { searchDuckDuckGo } from "./duckduckgo.ts";
import { searchExa } from "./exa.ts";
import { searchFirecrawl } from "./firecrawl.ts";
import { searchGemini } from "./gemini.ts";
import { searchTavily } from "./tavily.ts";

const searchCache = new MemoryCache<SearchResponse>(100, 5 * 60 * 1000);

export const PROVIDERS: Record<SearchProviderId, SearchProviderDefinition> = {
   duckduckgo: {
      id: "duckduckgo",
      name: "DuckDuckGo",
      isAvailable: () => true,
      search: searchDuckDuckGo
   },
   exa: {
      id: "exa",
      name: "Exa",
      isAvailable: () => Boolean(getWebAccessConfig().exaApiKey),
      search: searchExa
   },
   brave: {
      id: "brave",
      name: "Brave Search",
      isAvailable: () => Boolean(getWebAccessConfig().braveApiKey),
      search: searchBrave
   },
   tavily: {
      id: "tavily",
      name: "Tavily",
      isAvailable: () => Boolean(getWebAccessConfig().tavilyApiKey),
      search: searchTavily
   },
   firecrawl: {
      id: "firecrawl",
      name: "Firecrawl",
      isAvailable: () => Boolean(getWebAccessConfig().firecrawlApiKey),
      search: searchFirecrawl
   },
   gemini: {
      id: "gemini",
      name: "Google Gemini Grounded Search",
      isAvailable: () => Boolean(getWebAccessConfig().geminiApiKey),
      search: searchGemini
   }
};

const PROVIDER_PRIORITY_ORDER: ReadonlyArray<SearchProviderId> = [
   "exa",
   "brave",
   "firecrawl",
   "tavily",
   "gemini",
   "duckduckgo"
];

export function isProviderAvailable(providerId: SearchProviderId): boolean {
   const def = PROVIDERS[providerId];
   return def ? def.isAvailable() : false;
}

export function getAvailableProviders(): SearchProviderId[] {
   return Object.keys(PROVIDERS).filter((id) => isProviderAvailable(id as SearchProviderId)) as SearchProviderId[];
}

export function resolveProvider(requested?: SearchProviderId | "auto", mode?: SearchMode): SearchProviderId {
   if (requested && requested !== "auto") {
      if (PROVIDERS[requested]) {
         return requested;
      }
   }

   const config = getWebAccessConfig();

   // If mode="answer", prioritize providers with dedicated answer synthesis engines
   if (mode === "answer") {
      const answerCapableProviders: SearchProviderId[] = ["exa", "gemini"];
      for (const providerId of answerCapableProviders) {
         if (isProviderAvailable(providerId)) {
            return providerId;
         }
      }
   }

   if (config.defaultProvider && isProviderAvailable(config.defaultProvider)) {
      return config.defaultProvider;
   }

   for (const providerId of PROVIDER_PRIORITY_ORDER) {
      if (isProviderAvailable(providerId)) {
         return providerId;
      }
   }

   return "duckduckgo";
}

export async function executeSearch(options: SearchOptions): Promise<SearchResponse> {
   const startTime = Date.now();
   const providerId = resolveProvider(options.provider, options.mode);
   const provider = PROVIDERS[providerId];

   if (!provider) {
      return {
         query: options.query,
         provider: providerId,
         results: [],
         durationMs: Date.now() - startTime,
         error: `Unsupported search provider: "${providerId}"`
      };
   }

   const cacheKey = `${providerId}:${options.query}:${options.limit ?? 5}:${options.freshness ?? ""}`;
   const cached = searchCache.get(cacheKey);
   if (cached) {
      return {
         ...cached,
         durationMs: Date.now() - startTime
      };
   }

   const response = await provider.search(options);
   const finalResponse: SearchResponse = {
      ...response,
      durationMs: Date.now() - startTime
   };

   if (!finalResponse.error) {
      searchCache.set(cacheKey, finalResponse);
   }

   return finalResponse;
}
