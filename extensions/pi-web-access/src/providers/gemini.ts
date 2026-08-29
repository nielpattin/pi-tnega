import { getWebAccessConfig } from "../config.ts";
import type { SearchItem, SearchOptions, SearchResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet } from "../utils/text.ts";

export async function searchGemini(options: SearchOptions): Promise<SearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.geminiApiKey;
   const query = options.query.trim();

   if (!apiKey) {
      return {
         query,
         provider: "gemini",
         results: [],
         error: "GEMINI_API_KEY is not configured"
      };
   }

   const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

   try {
      const response = await fetchWithTimeout(url, {
         method: "POST",
         headers: {
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            contents: [{ parts: [{ text: query }] }],
            tools: [{ googleSearch: {} }]
         }),
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            query,
            provider: "gemini",
            results: [],
            error: `Gemini API error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as {
         candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            groundingMetadata?: {
               groundingChunks?: Array<{
                  web?: { uri?: string; title?: string };
               }>;
               searchEntryPoint?: { renderedContent?: string };
            };
         }>;
      };

      const candidate = data.candidates?.[0];
      const answer = candidate?.content?.parts?.[0]?.text;
      const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];

      const results: SearchItem[] = chunks
         .filter((chunk) => chunk.web?.uri)
         .map((chunk) => ({
            title: chunk.web?.title?.trim() || chunk.web?.uri || "Untitled",
            url: chunk.web?.uri || "",
            snippet: ""
         }));

      return {
         query,
         provider: "gemini",
         results,
         answer: answer ? cleanSnippet(answer) : undefined
      };
   } catch (error) {
      return {
         query,
         provider: "gemini",
         results: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
