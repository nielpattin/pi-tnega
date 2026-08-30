import { getWebAccessConfig } from "../config.ts";
import type { FetchOptions, FetchResult } from "../domain.ts";
import { applyTruncation } from "../utils/temp.ts";
import { formatCost } from "../utils/text.ts";
import { fetchWithTimeout } from "./client.ts";

interface ExaContentsItem {
   id?: string;
   url?: string;
   title?: string;
   author?: string | null;
   publishedDate?: string | null;
   text?: string;
   summary?: string;
   highlights?: string[];
   extras?: {
      links?: string[];
      imageLinks?: string[];
   };
}

interface ExaStatusItem {
   id?: string;
   status?: string;
   error?: string;
}

interface ExaContentsApiResponse {
   requestId?: string;
   searchTime?: number;
   costDollars?: number | { total?: number; [key: string]: unknown };
   results?: ExaContentsItem[];
   statuses?: ExaStatusItem[];
   error?: string;
}

export async function fetchWithExa(url: string, options: FetchOptions): Promise<FetchResult> {
   const config = getWebAccessConfig();
   const apiKey = config.exaApiKey;

   if (!apiKey) {
      return {
         url,
         title: undefined,
         content: "",
         contentType: "text/plain",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "exa",
         error: "EXA_API_KEY is not configured"
      };
   }

   const maxBytes = options.maxBytes ?? config.maxBytes;

   try {
      const requestPayload: Record<string, unknown> = {
         urls: [url],
         text: true,
         summary: true,
         highlights: true
      };

      if (options.includeLinks) {
         requestPayload.extras = {
            links: 30,
            imageLinks: 10
         };
      }

      const response = await fetchWithTimeout("https://api.exa.ai/contents", {
         method: "POST",
         headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json"
         },
         body: JSON.stringify(requestPayload),
         signal: options.signal,
         timeoutMs: options.timeoutMs
      });

      if (!response.ok) {
         const errText = await response.text();
         return {
            url,
            title: undefined,
            content: "",
            contentType: "text/plain",
            statusCode: response.status,
            truncated: false,
            byteLength: 0,
            provider: "exa",
            error: `Exa Contents API error (${response.status}): ${errText}`
         };
      }

      const data = (await response.json()) as ExaContentsApiResponse;
      const item = data.results?.[0];
      const statusItem = data.statuses?.[0];

      if (statusItem?.status === "error" || (!item && statusItem?.error)) {
         return {
            url,
            title: undefined,
            content: "",
            contentType: "text/plain",
            statusCode: 502,
            truncated: false,
            byteLength: 0,
            provider: "exa",
            requestId: data.requestId,
            serverTimeMs: data.searchTime,
            cost: formatCost(data.costDollars),
            error: statusItem.error ?? "Exa crawl status failed for URL"
         };
      }

      if (!item) {
         return {
            url,
            title: undefined,
            content: "",
            contentType: "text/plain",
            statusCode: 404,
            truncated: false,
            byteLength: 0,
            provider: "exa",
            requestId: data.requestId,
            serverTimeMs: data.searchTime,
            cost: formatCost(data.costDollars),
            error: "No content returned by Exa for URL"
         };
      }

      const pageTitle = item.title || undefined;
      const rawText = item.text || item.summary || "";

      const truncation = applyTruncation(rawText, maxBytes, url);

      return {
         url,
         title: pageTitle,
         author: item.author || undefined,
         publishedDate: item.publishedDate || undefined,
         content: truncation.content,
         contentType: "text/plain",
         statusCode: 200,
         truncated: truncation.truncated,
         byteLength: truncation.byteLength,
         fullByteLength: truncation.fullByteLength,
         lines: truncation.lines,
         totalLines: truncation.totalLines,
         tempFilePath: truncation.tempFilePath,
         provider: "exa",
         requestId: data.requestId,
         serverTimeMs: data.searchTime,
         cost: formatCost(data.costDollars),
         links: item.extras?.links
      };
   } catch (error) {
      return {
         url,
         title: undefined,
         content: "",
         contentType: "text/plain",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "exa",
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
