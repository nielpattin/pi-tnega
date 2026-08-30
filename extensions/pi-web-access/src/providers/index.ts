import { getWebAccessConfig } from "../config.ts";
import type {
   SearchMode,
   SearchOptions,
   SearchProviderDefinition,
   SearchProviderId,
   SearchResponse
} from "../domain.ts";
import { MemoryCache } from "../utils/cache.ts";
import { searchExa } from "./exa.ts";
import { searchFirecrawl } from "./firecrawl.ts";
import { searchTavily } from "./tavily.ts";

const searchCache = new MemoryCache<SearchResponse>(100, 5 * 60 * 1000);

export const PROVIDERS: Record<SearchProviderId, SearchProviderDefinition> = {
   firecrawl: {
      id: "firecrawl",
      name: "Firecrawl",
      isAvailable: () => Boolean(getWebAccessConfig().firecrawlApiKey),
      search: searchFirecrawl
   },
   exa: {
      id: "exa",
      name: "Exa",
      isAvailable: () => Boolean(getWebAccessConfig().exaApiKey),
      search: searchExa
   },
   tavily: {
      id: "tavily",
      name: "Tavily",
      isAvailable: () => Boolean(getWebAccessConfig().tavilyApiKey),
      search: searchTavily
   }
};

export const PROVIDER_PRIORITY_ORDER: ReadonlyArray<SearchProviderId> = ["firecrawl", "exa", "tavily"];

export function isProviderAvailable(providerId: SearchProviderId): boolean {
   const def = PROVIDERS[providerId];
   return def ? def.isAvailable() : false;
}

export function getAvailableProviders(): SearchProviderId[] {
   return Object.keys(PROVIDERS).filter((id) => isProviderAvailable(id as SearchProviderId)) as SearchProviderId[];
}

export function resolveProviderCandidates(
   requested?: SearchProviderId | "auto",
   mode?: SearchMode
): SearchProviderId[] {
   const config = getWebAccessConfig();
   const candidates: SearchProviderId[] = [];
   const seen = new Set<SearchProviderId>();

   const add = (id: SearchProviderId | undefined) => {
      if (id && isProviderAvailable(id) && !seen.has(id)) {
         seen.add(id);
         candidates.push(id);
      }
   };

   // 1. Explicitly requested provider
   if (requested && requested !== "auto" && PROVIDERS[requested]) {
      candidates.push(requested);
      seen.add(requested);
   }

   // 2. If mode="answer", prioritize providers with dedicated answer engines
   if (mode === "answer") {
      add("exa");
      add("tavily");
   }

   // 3. Configured search defaultProvider
   const defaultProvider = config.search.defaultProvider || config.defaultProvider;
   if (defaultProvider) {
      add(defaultProvider);
   }

   // 4. Priority fallback order across remaining available providers
   for (const providerId of PROVIDER_PRIORITY_ORDER) {
      add(providerId);
   }

   return candidates.length > 0 ? candidates : ["firecrawl"];
}

export function resolveProvider(requested?: SearchProviderId | "auto", mode?: SearchMode): SearchProviderId {
   const candidates = resolveProviderCandidates(requested, mode);
   return candidates[0] ?? "firecrawl";
}

export async function executeSearch(options: SearchOptions): Promise<SearchResponse> {
   const startTime = Date.now();
   const candidates = resolveProviderCandidates(options.provider, options.mode);
   const errors: Array<{ provider: string; error: string }> = [];

   for (const providerId of candidates) {
      if (options.signal?.aborted) {
         throw new Error("Search operation aborted");
      }

      const provider = PROVIDERS[providerId];
      if (!provider) continue;

      const cacheKey = `${providerId}:${options.query}:${options.limit ?? 5}:${options.freshness ?? ""}`;
      const cached = searchCache.get(cacheKey);
      if (cached && (!cached.error || cached.results.length > 0)) {
         return {
            ...cached,
            durationMs: Date.now() - startTime
         };
      }

      try {
         const response = await provider.search(options);

         if (!response.error || response.results.length > 0) {
            const finalResponse: SearchResponse = {
               ...response,
               provider: providerId,
               durationMs: Date.now() - startTime
            };
            searchCache.set(cacheKey, finalResponse);
            return finalResponse;
         }

         errors.push({ provider: providerId, error: response.error || "Zero search results returned" });
      } catch (err) {
         if (options.signal?.aborted) throw err;
         const msg = err instanceof Error ? err.message : String(err);
         errors.push({ provider: providerId, error: msg });
      }
   }

   // All candidate providers failed
   const errorSummary = errors.map((e) => `${e.provider} (${e.error})`).join(" -> ");
   return {
      query: options.query,
      provider: candidates[0] ?? "firecrawl",
      results: [],
      durationMs: Date.now() - startTime,
      error: `All search providers failed: ${errorSummary || "No available search engine"}`
   };
}
