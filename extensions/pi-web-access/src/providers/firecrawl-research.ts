import { getWebAccessConfig } from "../config.ts";
import type {
   ResearchPaperMetadata,
   ResearchPaperResult,
   ResearchPassage,
   ResearchReadPaperOptions,
   ResearchReadPaperResponse,
   ResearchSearchPapersOptions,
   ResearchSearchPapersResponse,
   ResearchSimilarPapersOptions,
   ResearchSimilarPapersResponse
} from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v2";

/**
 * Resolves a paper identifier (such as `arxiv:2105.05233`, `doi:...`, `pmid:...`, or `web:https://...`)
 * into a canonical, browsable web URL.
 */
export function resolvePaperUrl(idOrUrl: string, fallback?: string): string {
   const trimmed = (idOrUrl ?? "").trim();
   if (!trimmed) {
      return fallback ?? "";
   }

   if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return trimmed;
   }

   if (trimmed.startsWith("web:http://") || trimmed.startsWith("web:https://")) {
      return trimmed.slice(4);
   }

   if (trimmed.startsWith("arxiv:")) {
      const arxivId = trimmed.slice(6);
      return `https://arxiv.org/abs/${arxivId}`;
   }

   if (trimmed.startsWith("doi:")) {
      const doi = trimmed.slice(4);
      return `https://doi.org/${doi}`;
   }

   if (trimmed.startsWith("pmid:")) {
      const pmid = trimmed.slice(5);
      return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
   }

   if (trimmed.startsWith("pmcid:")) {
      const pmcid = trimmed.slice(6);
      return `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`;
   }

   if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(trimmed)) {
      return `https://doi.org/${trimmed}`;
   }

   return fallback ?? `https://api.firecrawl.dev/v2/search/research/papers/${encodeURIComponent(trimmed)}`;
}

/**
 * Search the Firecrawl Research paper index (~43M scientific and biomedical abstracts).
 */
export async function searchResearchPapers(
   options: ResearchSearchPapersOptions
): Promise<ResearchSearchPapersResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;

   if (!apiKey) {
      return {
         success: false,
         results: [],
         error: "FIRECRAWL_API_KEY is not configured"
      };
   }

   const url = new URL(`${FIRECRAWL_API_BASE}/search/research/papers`);
   url.searchParams.set("query", options.query.trim());

   if (options.k !== undefined) {
      url.searchParams.set("k", String(options.k));
   }

   if (options.authors) {
      url.searchParams.set("authors", options.authors.trim());
   }

   if (options.categories) {
      const cats =
         typeof options.categories === "string"
            ? options.categories.trim()
            : options.categories
                 .map((c) => c.trim())
                 .filter(Boolean)
                 .join(",");
      if (cats) {
         url.searchParams.set("categories", cats);
      }
   }

   if (options.from) {
      url.searchParams.set("from", options.from.trim());
   }

   if (options.to) {
      url.searchParams.set("to", options.to.trim());
   }

   try {
      const response = await fetchWithTimeout(url.toString(), {
         method: "GET",
         headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json"
         },
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            success: false,
            results: [],
            error: `Firecrawl Paper Search error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as {
         success?: boolean;
         results?: ResearchPaperResult[];
         error?: string;
      };

      if (data.error) {
         return {
            success: false,
            results: [],
            error: data.error
         };
      }

      return {
         success: data.success ?? true,
         results: data.results ?? []
      };
   } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
         success: false,
         results: [],
         error: `Firecrawl Paper Search failed: ${errorMsg}`
      };
   }
}

/**
 * Inspect paper metadata or read passages for a question using Firecrawl Research Index.
 */
export async function getPaperOrPassages(
   paperId: string,
   options: ResearchReadPaperOptions = {}
): Promise<ResearchReadPaperResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;

   if (!apiKey) {
      return {
         success: false,
         error: "FIRECRAWL_API_KEY is not configured"
      };
   }

   const encodedId = encodeURIComponent(paperId.trim());
   const url = new URL(`${FIRECRAWL_API_BASE}/search/research/papers/${encodedId}`);

   if (options.query) {
      url.searchParams.set("query", options.query.trim());
   }

   if (options.k !== undefined) {
      url.searchParams.set("k", String(options.k));
   }

   try {
      const response = await fetchWithTimeout(url.toString(), {
         method: "GET",
         headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json"
         },
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            success: false,
            error: `Firecrawl Get Paper error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as {
         success?: boolean;
         paper?: ResearchPaperMetadata;
         paperId?: string;
         query?: string;
         passages?: ResearchPassage[];
         error?: string;
      };

      if (data.error) {
         return {
            success: false,
            error: data.error
         };
      }

      return {
         success: data.success ?? true,
         paper: data.paper,
         paperId: data.paperId ?? paperId,
         query: data.query,
         passages: data.passages
      };
   } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
         success: false,
         error: `Firecrawl Get Paper failed: ${errorMsg}`
      };
   }
}

/**
 * Expand from a seed paper through structural expansion and citation graph.
 */
export async function findRelatedPapers(
   paperId: string,
   options: ResearchSimilarPapersOptions
): Promise<ResearchSimilarPapersResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;

   if (!apiKey) {
      return {
         success: false,
         results: [],
         error: "FIRECRAWL_API_KEY is not configured"
      };
   }

   const encodedId = encodeURIComponent(paperId.trim());
   const url = new URL(`${FIRECRAWL_API_BASE}/search/research/papers/${encodedId}/similar`);

   url.searchParams.set("intent", options.intent.trim());

   if (options.mode) {
      url.searchParams.set("mode", options.mode);
   }

   if (options.k !== undefined) {
      url.searchParams.set("k", String(options.k));
   }

   if (options.rerank !== undefined) {
      url.searchParams.set("rerank", String(options.rerank));
   }

   if (options.anchor) {
      if (typeof options.anchor === "string") {
         const trimmed = options.anchor.trim();
         if (trimmed) url.searchParams.set("anchor", trimmed);
      } else {
         for (const a of options.anchor) {
            const trimmed = a.trim();
            if (trimmed) url.searchParams.append("anchor", trimmed);
         }
      }
   }

   try {
      const response = await fetchWithTimeout(url.toString(), {
         method: "GET",
         headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json"
         },
         signal: options.signal
      });

      if (!response.ok) {
         const errorText = await response.text();
         return {
            success: false,
            results: [],
            error: `Firecrawl Related Papers error (${response.status}): ${errorText}`
         };
      }

      const data = (await response.json()) as {
         success?: boolean;
         results?: ResearchPaperResult[];
         poolSize?: number;
         truncated?: boolean;
         note?: string | null;
         error?: string;
      };

      if (data.error) {
         return {
            success: false,
            results: [],
            error: data.error
         };
      }

      return {
         success: data.success ?? true,
         results: data.results ?? [],
         poolSize: data.poolSize,
         truncated: data.truncated,
         note: data.note
      };
   } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
         success: false,
         results: [],
         error: `Firecrawl Related Papers failed: ${errorMsg}`
      };
   }
}
