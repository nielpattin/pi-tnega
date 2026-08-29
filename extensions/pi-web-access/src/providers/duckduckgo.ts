import type { SearchItem, SearchOptions, SearchResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet, stripHtmlTags } from "../utils/text.ts";

export async function searchDuckDuckGo(options: SearchOptions): Promise<SearchResponse> {
   let query = options.query.trim();

   if (options.includeDomains && options.includeDomains.length > 0) {
      const siteClauses = options.includeDomains.map((d) => `site:${d}`).join(" OR ");
      query = `${query} (${siteClauses})`;
   }
   if (options.excludeDomains && options.excludeDomains.length > 0) {
      const excludeClauses = options.excludeDomains.map((d) => `-site:${d}`).join(" ");
      query = `${query} ${excludeClauses}`;
   }

   const limit = options.limit ?? 5;
   const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

   try {
      const response = await fetchWithTimeout(searchUrl, {
         signal: options.signal,
         headers: {
            "User-Agent":
               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
         }
      });

      if (!response.ok) {
         return {
            query,
            provider: "duckduckgo",
            results: [],
            error: `DuckDuckGo search error: ${response.status} ${response.statusText}`
         };
      }

      const html = await response.text();
      const results: SearchItem[] = [];

      const resultBlockRegex = /<div class="result__body">([\s\S]*?)<\/div>\s*<\/div>/gi;
      const linkRegex = /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const titleLinkRegex = /<a class="result__url[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const snippetRegex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/i;

      let match: RegExpExecArray | null;
      while ((match = resultBlockRegex.exec(html)) !== null && results.length < limit) {
         const block = match[1];
         if (!block) continue;

         let itemUrl = "";
         let itemTitle = "";
         let itemSnippet = "";

         const tMatch = titleLinkRegex.exec(block) || linkRegex.exec(block);
         if (tMatch && tMatch[1]) {
            let rawUrl = tMatch[1];
            if (rawUrl.includes("uddg=")) {
               const uddgMatch = /uddg=([^&]+)/.exec(rawUrl);
               if (uddgMatch && uddgMatch[1]) {
                  rawUrl = decodeURIComponent(uddgMatch[1]);
               }
            }
            itemUrl = rawUrl;
         }

         const sMatch = snippetRegex.exec(block);
         if (sMatch && sMatch[1]) {
            itemSnippet = cleanSnippet(stripHtmlTags(sMatch[1]));
         }

         const titleMatch = /<h2 class="result__title">([\s\S]*?)<\/h2>/i.exec(block);
         if (titleMatch && titleMatch[1]) {
            itemTitle = cleanSnippet(stripHtmlTags(titleMatch[1]));
         }

         if (itemUrl && (itemTitle || itemSnippet)) {
            results.push({
               title: itemTitle || itemUrl,
               url: itemUrl,
               snippet: itemSnippet
            });
         }
      }

      return {
         query,
         provider: "duckduckgo",
         results
      };
   } catch (error) {
      return {
         query,
         provider: "duckduckgo",
         results: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
