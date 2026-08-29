import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SearchResponse } from "../domain.ts";
import { executeSearch } from "../providers/index.ts";
import { renderSearchCall, renderSearchResult } from "../ui/tool-renderers.ts";

export const WebSearchToolParamsSchema = Type.Object(
   {
      query: Type.String({
         minLength: 1,
         description: "Search keywords or question to find relevant web pages."
      }),
      provider: Type.Optional(
         Type.Union(
            [
               Type.Literal("auto"),
               Type.Literal("duckduckgo"),
               Type.Literal("exa"),
               Type.Literal("brave"),
               Type.Literal("tavily"),
               Type.Literal("firecrawl"),
               Type.Literal("gemini")
            ],
            {
               description:
                  "Search provider to query ('duckduckgo', 'exa', 'brave', 'tavily', 'firecrawl', 'gemini'). Defaults to 'auto'."
            }
         )
      ),
      mode: Type.Optional(
         Type.Union([Type.Literal("search"), Type.Literal("answer")], {
            default: "search",
            description:
               "Search mode: 'search' (default: returns ranked web pages and snippets) or 'answer' (use when user asks a question or wants a direct cited factual answer)."
         })
      ),
      category: Type.Optional(
         Type.Union(
            [
               Type.Literal("developer"),
               Type.Literal("research"),
               Type.Literal("pdf"),
               Type.Literal("company"),
               Type.Literal("publication"),
               Type.Literal("news"),
               Type.Literal("personal site"),
               Type.Literal("financial report"),
               Type.Literal("people")
            ],
            {
               description:
                  "Optional category filter: 'developer' (code repos/docs/PRs), 'research' (academic/scientific), 'pdf' (PDF files), 'company', 'publication', 'news', 'personal site', 'financial report', 'people'."
            }
         )
      ),
      includeDomains: Type.Optional(
         Type.Array(Type.String(), {
            description: "Optional list of domains or paths to restrict results to (e.g. ['docs.rs', 'github.com'])."
         })
      ),
      excludeDomains: Type.Optional(
         Type.Array(Type.String(), {
            description: "Optional list of domains to exclude from search results."
         })
      ),
      freshness: Type.Optional(
         Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
            description: "Time range filter: 'day' (past 24h), 'week' (past 7 days), 'month' (past 30 days), 'year'."
         })
      ),
      userLocation: Type.Optional(
         Type.String({
            description: "Two-letter ISO country code to localize search results (e.g. 'US', 'GB', 'DE')."
         })
      ),
      systemPrompt: Type.Optional(
         Type.String({
            description: "Guidance to steer search ranking, source preferences, or output constraints."
         })
      ),
      limit: Type.Optional(
         Type.Integer({
            minimum: 1,
            maximum: 20,
            description: "Maximum number of search results to return (1-20). Defaults to 5."
         })
      )
   },
   {
      description:
         "Search the web using multi-engine routing with domain filtering, freshness filters, geo-location, and category targeting."
   }
);

export type WebSearchToolParams = Static<typeof WebSearchToolParamsSchema>;

export async function handleWebSearch(
   _toolCallId: string,
   params: WebSearchToolParams,
   signal?: AbortSignal,
   _onUpdate?: unknown,
   _ctx?: ExtensionContext
): Promise<AgentToolResult<SearchResponse>> {
   const result = await executeSearch({
      query: params.query,
      provider: params.provider,
      mode: params.mode,
      category: params.category,
      includeDomains: params.includeDomains,
      excludeDomains: params.excludeDomains,
      freshness: params.freshness,
      userLocation: params.userLocation,
      systemPrompt: params.systemPrompt,
      limit: params.limit,
      signal
   });

   if (result.error && result.results.length === 0) {
      return {
         content: [{ type: "text", text: `Search failed for "${params.query}" (${result.provider}): ${result.error}` }],
         details: result
      };
   }

   const text = formatSearchTextResponse(result);
   return {
      content: [{ type: "text", text }],
      details: result
   };
}

export function formatSearchTextResponse(response: SearchResponse): string {
   const parts: string[] = [];

   if (response.answer) {
      parts.push(`Summary Answer:\n${response.answer}\n`);
   }

   if (response.results.length === 0) {
      parts.push(`No search results found for query: "${response.query}".`);
      return parts.join("\n");
   }

   parts.push(`Search results for "${response.query}" (${response.provider}):\n`);

   for (let i = 0; i < response.results.length; i++) {
      const item = response.results[i];
      if (!item) continue;
      parts.push(`${i + 1}. ${item.title}`);
      parts.push(`   URL: ${item.url}`);
      if (item.publishedDate) {
         parts.push(`   Date: ${item.publishedDate}`);
      }
      if (item.category) {
         parts.push(`   Category: ${item.category}`);
      }
      if (item.snippet) {
         parts.push(`   ${item.snippet}`);
      }
      parts.push("");
   }

   return parts.join("\n").trim();
}

export const webSearchTool: ToolDefinition<typeof WebSearchToolParamsSchema, SearchResponse> = {
   name: "web_search",
   label: "Web Search",
   description:
      "Search the web using multi-engine routing with domain filtering, freshness filters, geo-location, and category targeting. Set mode='answer' when the user asks a question or wants a direct factual answer with citations. Set mode='search' (default) to find web pages, documentation, and URLs.",
   parameters: WebSearchToolParamsSchema,
   execute: handleWebSearch,
   renderCall: renderSearchCall,
   renderResult: renderSearchResult
};
