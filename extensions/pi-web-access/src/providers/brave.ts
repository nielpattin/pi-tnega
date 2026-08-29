import { getWebAccessConfig } from "../config.ts";
import type { SearchItem, SearchOptions, SearchResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet, stripHtmlTags } from "../utils/text.ts";

export async function searchBrave(options: SearchOptions): Promise<SearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.braveApiKey;
   let query = options.query.trim();

   if (!apiKey) {
      return {
         query,
         provider: "brave",
         results: [],
         error: "BRAVE_API_KEY is not configured"
      };
   }

   if (options.includeDomains && options.includeDomains.length > 0) {
      const siteClauses = options.includeDomains.map((d) => `site:${d}`).join(" OR ");
      query = `${query} (${siteClauses})`;
   }
   if (options.excludeDomains && options.excludeDomains.length > 0) {
      const excludeClauses = options.excludeDomains.map((d) => `-site:${d}`).join(" ");
      query = `${query} ${excludeClauses}`;
   }

   const limit = options.limit ?? 5;
   const searchUrl = new URL("https://api.search.brave.com/res/v1/web/search");
   searchUrl.searchParams.set("q", query);
   searchUrl.searchParams.set("count", String(Math.min(limit, 20)));

   if (options.freshness) {
      const freshnessMap: Record<string, string> = {
         day: "pd",
         week: "pw",
         month: "pm",
         year: "py"
      };
      const braveFreshness = freshnessMap[options.freshness];
      if (braveFreshness) {
         searchUrl.searchParams.set("freshness", braveFreshness);
      }
   }

   if (options.userLocation) {
      searchUrl.searchParams.set("country", options.userLocation.toLowerCase());
   }

   try {
      const response = await fetchWithTimeout(searchUrl.toString(), {
         headers: {
            "X-Subscription-Token": apiKey,
            Accept: "application/json"
         },
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            query,
            provider: "brave",
            results: [],
            error: `Brave Search API error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as {
         web?: {
            results?: Array<{
               title?: string;
               url?: string;
               description?: string;
               page_age?: string;
            }>;
         };
      };

      const results: SearchItem[] = (data.web?.results ?? []).map((item) => ({
         title: cleanSnippet(stripHtmlTags(item.title || item.url || "Untitled")),
         url: item.url || "",
         snippet: cleanSnippet(stripHtmlTags(item.description || "")),
         publishedDate: item.page_age
      }));

      return {
         query,
         provider: "brave",
         results
      };
   } catch (error) {
      return {
         query,
         provider: "brave",
         results: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
