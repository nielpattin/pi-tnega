import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResearchResponse } from "../domain.ts";
import { executeResearch } from "../research/service.ts";
import { renderResearchCall, renderResearchResult } from "../ui/tool-renderers.ts";

export const WebResearchToolParamsSchema = Type.Object(
   {
      query: Type.Optional(
         Type.String({
            description: "Main topic, question, or assertion to perform deep web research on."
         })
      ),
      queries: Type.Optional(
         Type.Array(Type.String(), {
            description: "Optional list of 2-4 varied query angles searched in parallel for multi-perspective research."
         })
      ),
      depth: Type.Optional(
         Type.Union([Type.Literal("fast"), Type.Literal("deep"), Type.Literal("exhaustive")], {
            description:
               "Research depth and rigor: 'fast' (quick synthesis), 'deep' (standard multi-angle research), 'exhaustive' (broad comprehensive investigation). Defaults to 'deep'."
         })
      ),
      includeDomains: Type.Optional(
         Type.Array(Type.String(), {
            description: "Optional list of domains or paths to focus research on (e.g. ['docs.rs', 'github.com'])."
         })
      ),
      excludeDomains: Type.Optional(
         Type.Array(Type.String(), {
            description: "Optional list of domains to exclude from research."
         })
      ),
      userLocation: Type.Optional(
         Type.String({
            description: "Two-letter ISO country code for region-specific research (e.g. 'US', 'GB')."
         })
      ),
      systemPrompt: Type.Optional(
         Type.String({
            description:
               "Custom steering instructions or persona guidance for the research synthesis (e.g. 'Focus on official SDK migration guides and breaking changes')."
         })
      )
   },
   {
      description:
         "Conduct in-depth web research on a topic using multi-query search decomposition, page scraping, and LLM synthesized analysis with source citations."
   }
);

export type WebResearchToolParams = Static<typeof WebResearchToolParamsSchema>;

export function formatResearchTextResponse(response: ResearchResponse): string {
   if (response.error && response.sources.length === 0) {
      return `Research failed with provider "${response.provider}": ${response.error}`;
   }

   const parts: string[] = [];

   // Synthesis
   if (response.synthesis) {
      parts.push(response.synthesis);
   }

   // Sources
   if (response.sources.length > 0) {
      parts.push("\n### Referenced Sources\n");
      response.sources.forEach((src, idx) => {
         const title = src.title || src.url;
         const snippet = src.snippet ? `\n> ${src.snippet.slice(0, 200)}...` : "";
         parts.push(`- **[${idx + 1}] [${title}](${src.url})**${snippet}`);
      });
   }

   return parts.join("\n");
}

export async function handleWebResearch(
   _toolCallId: string,
   params: WebResearchToolParams,
   signal?: AbortSignal,
   onUpdate?: (partial: AgentToolResult<ResearchResponse>) => void,
   ctx?: ExtensionContext
): Promise<AgentToolResult<ResearchResponse>> {
   const onProgress = onUpdate
      ? (partial: Partial<ResearchResponse>) => {
           onUpdate({
              content: [{ type: "text", text: partial.synthesis || "" }],
              details: partial as ResearchResponse
           });
        }
      : undefined;

   const response = await executeResearch(
      {
         query: params.query,
         queries: params.queries,
         depth: params.depth,
         includeDomains: params.includeDomains,
         excludeDomains: params.excludeDomains,
         userLocation: params.userLocation,
         systemPrompt: params.systemPrompt,
         signal
      },
      ctx,
      onProgress
   );

   const formattedText = formatResearchTextResponse(response);

   return {
      content: [{ type: "text", text: formattedText }],
      details: response
   };
}

export const webResearchTool: ToolDefinition<typeof WebResearchToolParamsSchema, ResearchResponse> = {
   name: "web_research",
   label: "Web Research",
   description:
      "Conduct in-depth web research on a topic, combining multi-query search decomposition, page scraping, and synthesized analysis with source citations. Self-contained and complete.",
   promptSnippet:
      "Use for complex questions or research topics. Returns a complete, fully cited research synthesis. Use this result directly to answer the user without performing redundant follow-up searches or manual fetches.",
   parameters: WebResearchToolParamsSchema,
   execute: handleWebResearch,
   renderCall: renderResearchCall,
   renderResult: renderResearchResult
};
