import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SiteOutlineResponse } from "../domain.ts";
import { outlineSite } from "../outline/service.ts";
import { renderOutlineCall, renderOutlineResult } from "../ui/tool-renderers.ts";

export const OutlineSiteToolParamsSchema = Type.Object(
   {
      url: Type.String({
         minLength: 1,
         description:
            "The root or documentation website URL to map and discover pages from (e.g. 'https://docs.firecrawl.dev', 'https://docs.rs/tokio')."
      }),
      search: Type.Optional(
         Type.String({
            description:
               "Optional keyword or path filter to rank and restrict discovered URLs (e.g. 'api', 'schema', 'authentication')."
         })
      ),
      limit: Type.Optional(
         Type.Integer({
            minimum: 1,
            maximum: 5000,
            description: "Maximum number of URLs to discover and return (1-5000). Defaults to 100."
         })
      ),
      sitemap: Type.Optional(
         Type.Union([Type.Literal("include"), Type.Literal("skip"), Type.Literal("only")], {
            description:
               "Sitemap discovery mode: 'include' (sitemap + crawl), 'only' (strict sitemap only), or 'skip'. Defaults to 'include'."
         })
      ),
      include_subdomains: Type.Optional(
         Type.Boolean({
            description: "Whether to discover URLs on subdomains. Defaults to true."
         })
      )
   },
   {
      description:
         "Fast sitemap and link discovery for a website or documentation domain. Returns a complete outline of valid subpages, URLs, and titles."
   }
);

export type OutlineSiteToolParams = Static<typeof OutlineSiteToolParamsSchema>;

export async function handleOutlineSite(
   _toolCallId: string,
   params: OutlineSiteToolParams,
   signal?: AbortSignal,
   _onUpdate?: unknown,
   _ctx?: ExtensionContext
): Promise<AgentToolResult<SiteOutlineResponse>> {
   const result = await outlineSite({
      url: params.url,
      search: params.search,
      limit: params.limit,
      sitemap: params.sitemap,
      includeSubdomains: params.include_subdomains,
      signal
   });

   if (result.error && result.links.length === 0) {
      return {
         content: [{ type: "text", text: `Outline failed for "${params.url}": ${result.error}` }],
         details: result
      };
   }

   const text = formatOutlineTextResponse(result);
   return {
      content: [{ type: "text", text }],
      details: result
   };
}

export function formatOutlineTextResponse(response: SiteOutlineResponse): string {
   const parts: string[] = [];
   const searchMsg = response.search ? ` matching "${response.search}"` : "";

   if (response.links.length === 0) {
      parts.push(`No pages discovered for "${response.url}"${searchMsg}.`);
      return parts.join("\n");
   }

   parts.push(`Discovered ${response.totalLinks} pages for "${response.url}"${searchMsg}:\n`);

   for (let i = 0; i < response.links.length; i++) {
      const item = response.links[i];
      if (!item) continue;
      const title = item.title ? `${item.title} - ` : "";
      parts.push(`${i + 1}. ${title}${item.url}`);
      if (item.description) {
         parts.push(`   ${item.description}`);
      }
   }

   return parts.join("\n").trim();
}

export const outlineSiteTool: ToolDefinition<typeof OutlineSiteToolParamsSchema, SiteOutlineResponse> = {
   name: "outline_site",
   label: "Outline Site",
   description:
      "Map and discover all subpages, sitemap entries, and documentation links on a domain in one fast step with optional keyword filtering.",
   parameters: OutlineSiteToolParamsSchema,
   execute: handleOutlineSite,
   renderCall: renderOutlineCall,
   renderResult: renderOutlineResult
};
