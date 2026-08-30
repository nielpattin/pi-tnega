import { basename } from "node:path";
import { getWebAccessConfig } from "../config.ts";
import type { FetchOptions, FetchResult } from "../domain.ts";
import { applyTruncation } from "../utils/temp.ts";
import { fetchWithTimeout } from "./client.ts";

interface FirecrawlScrapeResponse {
   success?: boolean;
   creditsUsed?: number;
   id?: string;
   warning?: string;
   data?: {
      markdown?: string;
      html?: string;
      rawHtml?: string;
      links?: string[];
      metadata?: {
         title?: string | string[];
         description?: string | string[];
         statusCode?: number;
         sourceURL?: string;
         url?: string;
         contentType?: string;
         creditsUsed?: number;
      };
   };
   error?: string;
}

function formatCreditsUsed(response: FirecrawlScrapeResponse): string | undefined {
   const creditsUsed = response.data?.metadata?.creditsUsed ?? response.creditsUsed;
   if (creditsUsed === undefined) return undefined;
   return `${creditsUsed} credit${creditsUsed === 1 ? "" : "s"}`;
}

export async function fetchWithFirecrawl(url: string, options: FetchOptions): Promise<FetchResult> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;

   if (!apiKey) {
      return {
         url,
         title: undefined,
         content: "",
         contentType: "text/markdown",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "firecrawl",
         error: "FIRECRAWL_API_KEY is not configured"
      };
   }

   const scrapeUrl = "https://api.firecrawl.dev/v2/scrape";
   const maxBytes = options.maxBytes ?? config.maxBytes;

   const format = options.format ?? "markdown";
   const formatsPayload: Array<{ type: string }> = [{ type: format === "html" ? "html" : "markdown" }];

   if (options.includeLinks) {
      formatsPayload.push({ type: "links" });
   }

   try {
      const response = await fetchWithTimeout(scrapeUrl, {
         method: "POST",
         headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            url,
            formats: formatsPayload,
            onlyMainContent: true,
            blockAds: true,
            removeBase64Images: true
         }),
         signal: options.signal,
         timeoutMs: options.timeoutMs
      });

      if (!response.ok) {
         const errText = await response.text();
         return {
            url,
            title: undefined,
            content: "",
            contentType: "text/markdown",
            statusCode: response.status,
            truncated: false,
            byteLength: 0,
            provider: "firecrawl",
            error: `Firecrawl Scrape API error (${response.status}): ${errText}`
         };
      }

      const data = (await response.json()) as FirecrawlScrapeResponse;
      const rawContent = format === "html" ? data.data?.html || "" : data.data?.markdown || "";
      const metadata = data.data?.metadata;
      const rawTitle = metadata?.title;
      const pageTitle = Array.isArray(rawTitle) ? rawTitle[0] : rawTitle || undefined;
      const statusCode = metadata?.statusCode || 200;

      const truncation = applyTruncation(rawContent, maxBytes, url);

      const cost = formatCreditsUsed(data);

      return {
         url,
         title: pageTitle,
         content: truncation.content,
         contentType: metadata?.contentType || (format === "html" ? "text/html" : "text/markdown"),
         statusCode,
         truncated: truncation.truncated,
         byteLength: truncation.byteLength,
         fullByteLength: truncation.fullByteLength,
         lines: truncation.lines,
         totalLines: truncation.totalLines,
         tempFilePath: truncation.tempFilePath,
         provider: "firecrawl",
         cost,
         requestId: data.id,
         links: data.data?.links
      };
   } catch (error) {
      return {
         url,
         title: undefined,
         content: "",
         contentType: "text/markdown",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "firecrawl",
         error: error instanceof Error ? error.message : String(error)
      };
   }
}

export async function parseLocalFileWithFirecrawl(
   filePath: string,
   fileBuffer: Buffer,
   options: FetchOptions
): Promise<FetchResult> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;

   if (!apiKey) {
      return {
         url: filePath,
         title: undefined,
         content: "",
         contentType: "application/octet-stream",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "firecrawl",
         error: "FIRECRAWL_API_KEY is required to parse Office/eBook documents (.docx, .xlsx, .pptx, .epub, .odt, .rtf)"
      };
   }

   const parseUrl = "https://api.firecrawl.dev/v2/parse";
   const maxBytes = options.maxBytes ?? config.maxBytes;
   const fileName = basename(filePath);

   try {
      const formData = new FormData();
      const fileBlob = new Blob([new Uint8Array(fileBuffer)]);
      formData.append("file", fileBlob, fileName);
      formData.append(
         "options",
         JSON.stringify({
            formats: [{ type: "markdown" }],
            onlyMainContent: true
         })
      );

      const response = await fetchWithTimeout(parseUrl, {
         method: "POST",
         headers: {
            Authorization: `Bearer ${apiKey}`
         },
         body: formData,
         signal: options.signal,
         timeoutMs: options.timeoutMs ?? 60_000
      });

      if (!response.ok) {
         const errText = await response.text();
         return {
            url: filePath,
            title: undefined,
            content: "",
            contentType: "application/octet-stream",
            statusCode: response.status,
            truncated: false,
            byteLength: 0,
            provider: "firecrawl",
            error: `Firecrawl Parse API error (${response.status}): ${errText}`
         };
      }

      const data = (await response.json()) as FirecrawlScrapeResponse;
      const rawMarkdown = data.data?.markdown || "";
      const metadata = data.data?.metadata;
      const rawTitle = metadata?.title;
      const pageTitle = Array.isArray(rawTitle) ? rawTitle[0] : rawTitle || fileName;
      const statusCode = metadata?.statusCode || 200;

      const truncation = applyTruncation(rawMarkdown, maxBytes, filePath);

      const cost = formatCreditsUsed(data);

      return {
         url: filePath,
         title: pageTitle,
         content: truncation.content,
         contentType: metadata?.contentType || "text/markdown",
         statusCode,
         truncated: truncation.truncated,
         byteLength: truncation.byteLength,
         fullByteLength: truncation.fullByteLength,
         lines: truncation.lines,
         totalLines: truncation.totalLines,
         tempFilePath: truncation.tempFilePath,
         provider: "firecrawl",
         cost,
         requestId: data.id,
         links: data.data?.links
      };
   } catch (error) {
      return {
         url: filePath,
         title: undefined,
         content: "",
         contentType: "application/octet-stream",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "firecrawl",
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
