import { getWebAccessConfig } from "../config.ts";
import type { SearchItem, SearchOptions, SearchResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet, formatCost } from "../utils/text.ts";

function getPublishedDateCutoff(freshness?: "day" | "week" | "month" | "year"): string | undefined {
   if (!freshness) return undefined;
   const now = new Date();
   switch (freshness) {
      case "day":
         now.setDate(now.getDate() - 1);
         break;
      case "week":
         now.setDate(now.getDate() - 7);
         break;
      case "month":
         now.setMonth(now.getMonth() - 1);
         break;
      case "year":
         now.setFullYear(now.getFullYear() - 1);
         break;
   }
   return now.toISOString();
}

interface ExaCitationItem {
   id?: string;
   url?: string;
   title?: string;
   text?: string;
   author?: string;
   publishedDate?: string;
}

interface ExaAnswerApiResponse {
   answer?: string;
   citations?: ExaCitationItem[];
   costDollars?: number | { total?: number; [key: string]: unknown };
   requestId?: string;
   error?: string;
}

interface ExaSearchResultItem {
   title?: string;
   url?: string;
   text?: string;
   summary?: string;
   highlights?: string[];
   publishedDate?: string;
   author?: string;
}

interface ExaSearchApiResponse {
   requestId?: string;
   searchTime?: number;
   costDollars?: number | { total?: number; [key: string]: unknown };
   results?: ExaSearchResultItem[];
   output?: string;
   error?: string;
}

export async function searchExa(options: SearchOptions): Promise<SearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.exaApiKey;
   const query = options.query.trim();

   if (!apiKey) {
      return {
         query,
         provider: "exa",
         results: [],
         error: "EXA_API_KEY is not configured"
      };
   }

   const limit = options.limit ?? 5;
   const isRestrictedCategory = options.category === "company" || options.category === "people";
   const startPublishedDate = isRestrictedCategory ? undefined : getPublishedDateCutoff(options.freshness);
   const userLocation = options.userLocation || config.userLocation;
   const includeDomains =
      options.includeDomains && options.includeDomains.length > 0 ? options.includeDomains : undefined;
   const excludeDomains =
      !isRestrictedCategory && options.excludeDomains && options.excludeDomains.length > 0
         ? options.excludeDomains
         : undefined;

   const isAnswerMode =
      options.mode === "answer" && !isRestrictedCategory && !startPublishedDate && !includeDomains && !excludeDomains;

   try {
      if (isAnswerMode) {
         const answerRes = await fetchWithTimeout("https://api.exa.ai/answer", {
            method: "POST",
            headers: {
               "x-api-key": apiKey,
               "Content-Type": "application/json"
            },
            body: JSON.stringify({
               query,
               model: "exa",
               text: true,
               userLocation,
               systemPrompt: options.systemPrompt
            }),
            signal: options.signal
         });

         if (answerRes.ok) {
            const data = (await answerRes.json()) as ExaAnswerApiResponse;
            const citations = data.citations ?? [];

            const results: SearchItem[] = citations.slice(0, limit).map((c) => ({
               title: cleanSnippet(c.title || c.url || "Untitled"),
               url: c.url || c.id || "",
               snippet: cleanSnippet(c.text || ""),
               author: c.author,
               publishedDate: c.publishedDate
            }));

            return {
               query,
               provider: "exa",
               mode: "answer",
               results,
               answer: typeof data.answer === "string" ? data.answer.trim() : undefined,
               requestId: data.requestId,
               cost: formatCost(data.costDollars)
            };
         }
      }

      const response = await fetchWithTimeout("https://api.exa.ai/search", {
         method: "POST",
         headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            query,
            type: "auto",
            category: options.category,
            numResults: limit,
            startPublishedDate,
            includeDomains,
            excludeDomains,
            userLocation,
            systemPrompt: options.systemPrompt,
            contents: {
               text: {
                  maxCharacters: 1500
               },
               summary: true,
               highlights: true
            }
         }),
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            query,
            provider: "exa",
            results: [],
            error: `Exa API error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as ExaSearchApiResponse;
      const results: SearchItem[] = (data.results ?? []).map((item) => {
         const snippet = item.summary || item.highlights?.join(" ") || item.text || "";
         return {
            title: cleanSnippet(item.title || item.url || "Untitled"),
            url: item.url || "",
            snippet: cleanSnippet(snippet),
            publishedDate: item.publishedDate,
            author: item.author
         };
      });

      return {
         query,
         provider: "exa",
         mode: "search",
         results,
         answer: data.output,
         requestId: data.requestId,
         serverTimeMs: data.searchTime,
         cost: formatCost(data.costDollars)
      };
   } catch (error) {
      return {
         query,
         provider: "exa",
         results: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
