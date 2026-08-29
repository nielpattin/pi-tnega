import { getWebAccessConfig } from "../config.ts";
import type { SearchItem, SearchOptions, SearchResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet } from "../utils/text.ts";

export async function searchTavily(options: SearchOptions): Promise<SearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.tavilyApiKey;
   const query = options.query.trim();

   if (!apiKey) {
      return {
         query,
         provider: "tavily",
         results: [],
         error: "TAVILY_API_KEY is not configured"
      };
   }

   const limit = options.limit ?? 5;

   try {
      const response = await fetchWithTimeout("https://api.tavily.com/search", {
         method: "POST",
         headers: {
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: limit,
            include_answer: true
         }),
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            query,
            provider: "tavily",
            results: [],
            error: `Tavily API error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as {
         answer?: string;
         results?: Array<{
            title?: string;
            url?: string;
            content?: string;
            published_date?: string;
         }>;
      };

      const results: SearchItem[] = (data.results ?? []).map((item) => ({
         title: item.title?.trim() || "Untitled",
         url: item.url || "",
         snippet: cleanSnippet(item.content || ""),
         publishedDate: item.published_date
      }));

      return {
         query,
         provider: "tavily",
         results,
         answer: data.answer
      };
   } catch (error) {
      return {
         query,
         provider: "tavily",
         results: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
