import { getWebAccessConfig } from "../config.ts";
import type { SearchItem, SearchOptions, SearchResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet } from "../utils/text.ts";

function mapFreshnessToTbs(freshness?: "day" | "week" | "month" | "year"): string | undefined {
   if (!freshness) return undefined;
   switch (freshness) {
      case "day":
         return "qdr:d";
      case "week":
         return "qdr:w";
      case "month":
         return "qdr:m";
      case "year":
         return "qdr:y";
      default:
         return undefined;
   }
}

interface FirecrawlSearchItem {
   url?: string;
   title?: string;
   description?: string;
   markdown?: string;
   category?: string;
   metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
   };
}

interface FirecrawlSearchApiResponse {
   success?: boolean;
   creditsUsed?: number;
   id?: string;
   warning?: string;
   data?:
      | FirecrawlSearchItem[]
      | {
           web?: FirecrawlSearchItem[];
           news?: FirecrawlSearchItem[];
           images?: Array<{ title?: string; url?: string }>;
        };
   error?: string;
}

export async function searchFirecrawl(options: SearchOptions): Promise<SearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;
   const query = options.query.trim();

   if (!apiKey) {
      return {
         query,
         provider: "firecrawl",
         results: [],
         error: "FIRECRAWL_API_KEY is not configured"
      };
   }

   const limit = options.limit ?? 5;
   const searchUrl = "https://api.firecrawl.dev/v2/search";

   const requestBody: Record<string, unknown> = {
      query,
      limit,
      scrapeOptions: {
         formats: [{ type: "markdown" }],
         onlyMainContent: true
      }
   };

   // Time-based search
   const tbs = mapFreshnessToTbs(options.freshness);
   if (tbs) {
      requestBody.tbs = tbs;
   }

   // Categories filter (developer, research, pdf)
   if (options.category === "developer" || options.category === "research" || options.category === "pdf") {
      requestBody.categories = [{ type: options.category }];
   }

   // Domain filtering
   if (options.includeDomains && options.includeDomains.length > 0) {
      requestBody.includeDomains = options.includeDomains;
   } else if (options.excludeDomains && options.excludeDomains.length > 0) {
      requestBody.excludeDomains = options.excludeDomains;
   }

   // Geo-location / Country
   const country = options.userLocation || config.userLocation;
   if (country) {
      requestBody.country = country.toUpperCase();
   }

   try {
      const response = await fetchWithTimeout(searchUrl, {
         method: "POST",
         headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
         },
         body: JSON.stringify(requestBody),
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            query,
            provider: "firecrawl",
            results: [],
            error: `Firecrawl API error (${response.status}): ${errorText}`
         };
      }

      const responseJson = (await response.json()) as FirecrawlSearchApiResponse;

      let rawItems: FirecrawlSearchItem[] = [];
      if (Array.isArray(responseJson.data)) {
         rawItems = responseJson.data;
      } else if (responseJson.data?.web && Array.isArray(responseJson.data.web)) {
         rawItems = responseJson.data.web;
      }

      const results: SearchItem[] = rawItems.map((item) => {
         const itemUrl = item.url || item.metadata?.sourceURL || item.metadata?.url || "";
         const itemTitle = item.title || item.metadata?.title || itemUrl || "Untitled";
         const itemSnippet = item.description || item.metadata?.description || item.markdown?.slice(0, 300) || "";

         return {
            title: cleanSnippet(itemTitle),
            url: itemUrl,
            snippet: cleanSnippet(itemSnippet),
            category: item.category
         };
      });

      const cost =
         responseJson.creditsUsed !== undefined
            ? `${responseJson.creditsUsed} credit${responseJson.creditsUsed === 1 ? "" : "s"}`
            : undefined;

      return {
         query,
         provider: "firecrawl",
         results,
         cost,
         requestId: responseJson.id
      };
   } catch (error) {
      return {
         query,
         provider: "firecrawl",
         results: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
