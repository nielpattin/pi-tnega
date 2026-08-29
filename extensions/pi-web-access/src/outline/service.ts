import { getWebAccessConfig } from "../config.ts";
import type { SiteOutlineItem, SiteOutlineOptions, SiteOutlineResponse } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet, formatCost, normalizeUrl } from "../utils/text.ts";

interface FirecrawlMapItem {
   url?: string;
   title?: string;
   description?: string;
}

interface FirecrawlMapResponse {
   success?: boolean;
   links?: Array<FirecrawlMapItem | string>;
   error?: string;
}

export async function outlineSite(options: SiteOutlineOptions): Promise<SiteOutlineResponse> {
   const startTime = Date.now();
   const config = getWebAccessConfig();
   const firecrawlKey = config.firecrawlApiKey;
   const exaKey = config.exaApiKey;
   const rawUrl = options.url.trim();
   const normalizedUrl = normalizeUrl(rawUrl);

   if (!firecrawlKey && !exaKey) {
      return {
         url: normalizedUrl,
         search: options.search,
         links: [],
         totalLinks: 0,
         durationMs: Date.now() - startTime,
         error: "Either FIRECRAWL_API_KEY or EXA_API_KEY is required to outline site structures"
      };
   }

   // 1. Primary engine: Firecrawl /v2/map (full sitemap traversal)
   if (firecrawlKey) {
      const mapUrl = "https://api.firecrawl.dev/v2/map";
      const limit = options.limit ?? 100;

      try {
         const requestPayload: Record<string, unknown> = {
            url: normalizedUrl,
            limit,
            sitemap: options.sitemap ?? "include",
            includeSubdomains: options.includeSubdomains ?? true,
            ignoreQueryParameters: options.ignoreQueryParameters ?? true
         };

         if (options.search) {
            requestPayload.search = options.search;
         }

         const response = await fetchWithTimeout(mapUrl, {
            method: "POST",
            headers: {
               Authorization: `Bearer ${firecrawlKey}`,
               "Content-Type": "application/json"
            },
            body: JSON.stringify(requestPayload),
            signal: options.signal,
            timeoutMs: options.timeoutMs ?? 30_000
         });

         if (!response.ok) {
            const errText = await response.text();
            return {
               url: normalizedUrl,
               search: options.search,
               links: [],
               totalLinks: 0,
               durationMs: Date.now() - startTime,
               error: `Firecrawl Map API error (${response.status}): ${errText}`
            };
         }

         const data = (await response.json()) as FirecrawlMapResponse;
         const rawLinks = data.links ?? [];

         const links: SiteOutlineItem[] = rawLinks.map((item) => {
            if (typeof item === "string") {
               return { url: item };
            }
            return {
               url: item.url || "",
               title: item.title || undefined,
               description: item.description || undefined
            };
         });

         return {
            url: normalizedUrl,
            search: options.search,
            links,
            totalLinks: links.length,
            durationMs: Date.now() - startTime
         };
      } catch (error) {
         return {
            url: normalizedUrl,
            search: options.search,
            links: [],
            totalLinks: 0,
            durationMs: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error)
         };
      }
   }

   // 2. Fallback engine: Exa /search scoped to domain path
   try {
      const parsed = new URL(normalizedUrl);
      const domainScope = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      const query = options.search
         ? `${options.search} on ${parsed.hostname}`
         : `site:${parsed.hostname} overview and documentation pages`;

      const limit = Math.min(options.limit ?? 100, 100);

      const response = await fetchWithTimeout("https://api.exa.ai/search", {
         method: "POST",
         headers: {
            "x-api-key": exaKey!,
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            query,
            type: "auto",
            includeDomains: [domainScope],
            numResults: limit,
            contents: {
               summary: true
            }
         }),
         signal: options.signal,
         timeoutMs: options.timeoutMs ?? 30_000
      });

      if (!response.ok) {
         const errText = await response.text();
         return {
            url: normalizedUrl,
            search: options.search,
            links: [],
            totalLinks: 0,
            durationMs: Date.now() - startTime,
            error: `Exa search outline fallback error (${response.status}): ${errText}`
         };
      }

      const data = (await response.json()) as {
         results?: Array<{ title?: string; url?: string; summary?: string }>;
         costDollars?: number | { total?: number };
      };

      const links: SiteOutlineItem[] = (data.results ?? []).map((r) => ({
         url: r.url || "",
         title: r.title ? cleanSnippet(r.title) : undefined,
         description: r.summary ? cleanSnippet(r.summary) : undefined
      }));

      return {
         url: normalizedUrl,
         search: options.search,
         links,
         totalLinks: links.length,
         durationMs: Date.now() - startTime,
         cost: formatCost(data.costDollars)
      };
   } catch (error) {
      return {
         url: normalizedUrl,
         search: options.search,
         links: [],
         totalLinks: 0,
         durationMs: Date.now() - startTime,
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
