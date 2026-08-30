import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FetchResult } from "../domain.ts";
import { fetchWebContent } from "../fetch/service.ts";
import { renderFetchCall, renderFetchResult } from "../ui/tool-renderers.ts";

export const FetchContentToolParamsSchema = Type.Object(
   {
      url: Type.String({
         minLength: 1,
         description:
            "The web URL (e.g. 'https://docs.rs/...', 'https://example.com/article') or local file path (e.g. 'C:\\docs\\paper.pdf', './report.docx', './data.xlsx', '/home/user/manual.pdf', './spec.html') to fetch and extract content from."
      }),
      provider: Type.Optional(
         Type.Union([Type.Literal("auto"), Type.Literal("local"), Type.Literal("firecrawl"), Type.Literal("exa")], {
            description:
               "Scraping provider: 'local' (fast direct fetch & local PDF parsing), 'firecrawl' (headless browser for SPAs & anti-bot bypass), 'exa' (Exa web index), or 'auto' (fast local with automatic headless fallback on blocked/SPA pages). Defaults to 'auto'."
         })
      ),
      format: Type.Optional(
         Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
            description: "Format of the returned content ('markdown', 'text', or 'html'). Defaults to 'markdown'."
         })
      ),
      include_links: Type.Optional(
         Type.Boolean({
            description: "Whether to extract and append external links found on the page."
         })
      )
   },
   {
      description:
         "Fetch and extract readable Markdown or text from web pages, local or remote PDF documents, HTML files, articles, documentation, or raw GitHub files."
   }
);

export type FetchContentToolParams = Static<typeof FetchContentToolParamsSchema>;

export async function handleFetchContent(
   _toolCallId: string,
   params: FetchContentToolParams,
   signal?: AbortSignal,
   _onUpdate?: unknown,
   _ctx?: ExtensionContext
): Promise<AgentToolResult<FetchResult>> {
   const result = await fetchWebContent({
      url: params.url,
      provider: params.provider,
      format: params.format,
      includeLinks: params.include_links,
      signal
   });

   if (result.error) {
      return {
         content: [{ type: "text", text: `Fetch failed for ${result.url}: ${result.error}` }],
         details: result
      };
   }

   const prefix = result.title ? `# ${result.title}\nURL: ${result.url}\n\n` : "";
   const fullText = `${prefix}${result.content}`;

   return {
      content: [{ type: "text", text: fullText }],
      details: result
   };
}

export const fetchContentTool: ToolDefinition<typeof FetchContentToolParamsSchema, FetchResult> = {
   name: "fetch_content",
   label: "Fetch Content",
   description:
      "Fetch and extract readable Markdown or text from web pages, local or remote PDF documents, Office files (Word .docx, Excel .xlsx, PowerPoint .pptx, EPUB), HTML files, articles, documentation, or raw GitHub files.",
   parameters: FetchContentToolParamsSchema,
   execute: handleFetchContent,
   renderCall: renderFetchCall,
   renderResult: renderFetchResult
};
