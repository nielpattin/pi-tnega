import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWebAccessConfig } from "../config.ts";
import type { FetchOptions, FetchResult } from "../domain.ts";
import { MemoryCache } from "../utils/cache.ts";
import { applyTruncation } from "../utils/temp.ts";
import { normalizeUrl } from "../utils/text.ts";
import { fetchWithTimeout } from "./client.ts";
import { fetchWithExa } from "./exa.ts";
import { extractHtmlContent } from "./extractor.ts";
import { fetchWithFirecrawl, parseLocalFileWithFirecrawl } from "./firecrawl.ts";
import { transformGitHubUrl } from "./github.ts";
import { extractPdfContent } from "./pdf.ts";

const fetchCache = new MemoryCache<FetchResult>(100, 5 * 60 * 1000);

export function isLocalFilePath(input: string): boolean {
   const trimmed = input.trim();
   if (trimmed.startsWith("file://")) return true;
   if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
   if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return true;
   if (
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      trimmed.startsWith(".\\") ||
      trimmed.startsWith("..\\")
   ) {
      return true;
   }
   return existsSync(trimmed);
}

export function resolveLocalFilePath(input: string): string {
   const trimmed = input.trim();
   if (trimmed.startsWith("file://")) {
      try {
         return fileURLToPath(trimmed);
      } catch {
         return trimmed.slice(7);
      }
   }
   return resolve(trimmed);
}

async function handleLocalFileFetch(inputPath: string, options: FetchOptions): Promise<FetchResult> {
   const config = getWebAccessConfig();
   const maxBytes = options.maxBytes ?? config.maxBytes;
   const localPath = resolveLocalFilePath(inputPath);

   if (!existsSync(localPath)) {
      return {
         url: inputPath,
         title: undefined,
         content: "",
         contentType: "text/plain",
         statusCode: 404,
         truncated: false,
         byteLength: 0,
         provider: "local",
         error: `Local file not found: ${localPath}`
      };
   }

   try {
      const stats = statSync(localPath);
      if (stats.isDirectory()) {
         return {
            url: inputPath,
            title: undefined,
            content: "",
            contentType: "text/plain",
            statusCode: 400,
            truncated: false,
            byteLength: 0,
            provider: "local",
            error: `Specified path is a directory, not a file: ${localPath}`
         };
      }

      const lower = localPath.toLowerCase();
      const isPdf = lower.endsWith(".pdf");
      const isHtml = lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
      const isOfficeOrEbook =
         lower.endsWith(".docx") ||
         lower.endsWith(".doc") ||
         lower.endsWith(".docm") ||
         lower.endsWith(".xlsx") ||
         lower.endsWith(".xls") ||
         lower.endsWith(".xlsm") ||
         lower.endsWith(".xlsb") ||
         lower.endsWith(".pptx") ||
         lower.endsWith(".ppt") ||
         lower.endsWith(".pptm") ||
         lower.endsWith(".odt") ||
         lower.endsWith(".ods") ||
         lower.endsWith(".odp") ||
         lower.endsWith(".epub") ||
         lower.endsWith(".rtf");

      if (isOfficeOrEbook) {
         const buffer = await readFile(localPath);
         return await parseLocalFileWithFirecrawl(localPath, buffer, options);
      }

      if (isPdf) {
         const buffer = await readFile(localPath);
         const extracted = await extractPdfContent(buffer);
         const truncation = applyTruncation(extracted.content, maxBytes, localPath);

         return {
            url: localPath,
            title: extracted.title,
            content: truncation.content,
            contentType: "application/pdf",
            statusCode: 200,
            truncated: truncation.truncated,
            byteLength: truncation.byteLength,
            fullByteLength: truncation.fullByteLength,
            lines: truncation.lines,
            totalLines: truncation.totalLines,
            tempFilePath: truncation.tempFilePath,
            provider: "local"
         };
      }

      const rawText = await readFile(localPath, "utf8");

      if (isHtml && (options.format ?? "markdown") !== "html") {
         const extracted = extractHtmlContent(rawText, {
            baseUrl: `file://${localPath}`,
            includeLinks: options.includeLinks
         });
         const truncation = applyTruncation(extracted.content, maxBytes, localPath);

         return {
            url: localPath,
            title: extracted.title,
            content: truncation.content,
            contentType: "text/html",
            statusCode: 200,
            truncated: truncation.truncated,
            byteLength: truncation.byteLength,
            fullByteLength: truncation.fullByteLength,
            lines: truncation.lines,
            totalLines: truncation.totalLines,
            tempFilePath: truncation.tempFilePath,
            links: extracted.links,
            provider: "local"
         };
      }

      const truncation = applyTruncation(rawText, maxBytes, localPath);

      return {
         url: localPath,
         title: undefined,
         content: truncation.content,
         contentType: isHtml ? "text/html" : "text/plain",
         statusCode: 200,
         truncated: truncation.truncated,
         byteLength: truncation.byteLength,
         fullByteLength: truncation.fullByteLength,
         lines: truncation.lines,
         totalLines: truncation.totalLines,
         tempFilePath: truncation.tempFilePath,
         provider: "local"
      };
   } catch (error) {
      return {
         url: inputPath,
         title: undefined,
         content: "",
         contentType: "text/plain",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "local",
         error: error instanceof Error ? error.message : String(error)
      };
   }
}

async function executeRemoteHttpFetch(normalizedUrl: string, options: FetchOptions): Promise<FetchResult> {
   const config = getWebAccessConfig();
   const maxBytes = options.maxBytes ?? config.maxBytes;

   try {
      const parsedUrl = new URL(normalizedUrl);
      const transformedUrl = transformGitHubUrl(parsedUrl) ?? normalizedUrl;

      const response = await fetchWithTimeout(transformedUrl, {
         signal: options.signal,
         timeoutMs: options.timeoutMs
      });

      const contentType = response.headers.get("content-type") ?? "text/html";
      const isPdf =
         contentType.includes("application/pdf") ||
         normalizedUrl.toLowerCase().endsWith(".pdf") ||
         parsedUrl.pathname.toLowerCase().endsWith(".pdf");

      if (!response.ok) {
         return {
            url: normalizedUrl,
            title: undefined,
            content: "",
            contentType,
            statusCode: response.status,
            truncated: false,
            byteLength: 0,
            provider: "local",
            error: `HTTP error: ${response.status} ${response.statusText}`
         };
      }

      if (isPdf) {
         const buffer = await response.arrayBuffer();
         const extracted = await extractPdfContent(buffer);
         const truncation = applyTruncation(extracted.content, maxBytes, normalizedUrl);

         return {
            url: normalizedUrl,
            title: extracted.title,
            content: truncation.content,
            contentType: "application/pdf",
            statusCode: response.status,
            truncated: truncation.truncated,
            byteLength: truncation.byteLength,
            fullByteLength: truncation.fullByteLength,
            lines: truncation.lines,
            totalLines: truncation.totalLines,
            tempFilePath: truncation.tempFilePath,
            provider: "local"
         };
      }

      const bodyText = await response.text();
      const format = options.format ?? "markdown";

      if (format === "html") {
         const truncation = applyTruncation(bodyText, maxBytes, normalizedUrl);
         return {
            url: normalizedUrl,
            title: undefined,
            content: truncation.content,
            contentType,
            statusCode: response.status,
            truncated: truncation.truncated,
            byteLength: truncation.byteLength,
            fullByteLength: truncation.fullByteLength,
            lines: truncation.lines,
            totalLines: truncation.totalLines,
            tempFilePath: truncation.tempFilePath,
            provider: "local"
         };
      }

      const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

      if (!isHtml) {
         const truncation = applyTruncation(bodyText, maxBytes, normalizedUrl);
         return {
            url: normalizedUrl,
            title: undefined,
            content: truncation.content,
            contentType,
            statusCode: response.status,
            truncated: truncation.truncated,
            byteLength: truncation.byteLength,
            fullByteLength: truncation.fullByteLength,
            lines: truncation.lines,
            totalLines: truncation.totalLines,
            tempFilePath: truncation.tempFilePath,
            provider: "local"
         };
      }

      const extracted = extractHtmlContent(bodyText, {
         baseUrl: normalizedUrl,
         includeLinks: options.includeLinks
      });

      const truncation = applyTruncation(extracted.content, maxBytes, normalizedUrl);

      return {
         url: normalizedUrl,
         title: extracted.title,
         content: truncation.content,
         contentType,
         statusCode: response.status,
         truncated: truncation.truncated,
         byteLength: truncation.byteLength,
         fullByteLength: truncation.fullByteLength,
         lines: truncation.lines,
         totalLines: truncation.totalLines,
         tempFilePath: truncation.tempFilePath,
         links: extracted.links,
         provider: "local"
      };
   } catch (error) {
      return {
         url: normalizedUrl,
         title: undefined,
         content: "",
         contentType: "text/plain",
         statusCode: 500,
         truncated: false,
         byteLength: 0,
         provider: "local",
         error: error instanceof Error ? error.message : String(error)
      };
   }
}

export async function fetchWebContent(options: FetchOptions): Promise<FetchResult> {
   const startTime = Date.now();
   const config = getWebAccessConfig();
   const inputUrl = options.url.trim();

   // Handle local files (e.g. C:\path\file.pdf, /path/file.pdf, file:///...)
   if (isLocalFilePath(inputUrl)) {
      const localRes = await handleLocalFileFetch(inputPathHelper(inputUrl), options);
      return {
         ...localRes,
         durationMs: Date.now() - startTime
      };
   }

   const normalizedUrl = normalizeUrl(inputUrl);
   const provider = options.provider ?? "auto";
   const format = options.format ?? "markdown";
   const maxBytes = options.maxBytes ?? config.maxBytes;

   const cacheKey = `${provider}:${normalizedUrl}:${format}:${Boolean(options.includeLinks)}:${maxBytes}`;
   const cached = fetchCache.get(cacheKey);
   if (cached) {
      return {
         ...cached,
         durationMs: Date.now() - startTime
      };
   }

   let result: FetchResult;

   // Explicit provider routes
   if (provider === "firecrawl") {
      result = await fetchWithFirecrawl(normalizedUrl, options);
   } else if (provider === "exa") {
      result = await fetchWithExa(normalizedUrl, options);
   } else if (provider === "local") {
      result = await executeRemoteHttpFetch(normalizedUrl, options);
   } else {
      // Provider: "auto" (Fast local first, with smart fallback to Firecrawl/Exa on anti-bot/SPA skeletons)
      const localResult = await executeRemoteHttpFetch(normalizedUrl, options);

      const isBlockedOrEmpty =
         localResult.error ||
         localResult.statusCode === 401 ||
         localResult.statusCode === 403 ||
         localResult.statusCode === 429 ||
         localResult.statusCode === 503 ||
         (localResult.statusCode === 200 && localResult.content.trim().length < 80);

      if (isBlockedOrEmpty) {
         if (config.firecrawlApiKey) {
            const firecrawlResult = await fetchWithFirecrawl(normalizedUrl, options);
            if (!firecrawlResult.error && firecrawlResult.content.length > 50) {
               result = firecrawlResult;
            } else {
               result = localResult;
            }
         } else if (config.exaApiKey) {
            const exaResult = await fetchWithExa(normalizedUrl, options);
            if (!exaResult.error && exaResult.content.length > 50) {
               result = exaResult;
            } else {
               result = localResult;
            }
         } else {
            result = localResult;
         }
      } else {
         result = localResult;
      }
   }

   const finalResult: FetchResult = {
      ...result,
      durationMs: Date.now() - startTime
   };

   if (!finalResult.error) {
      fetchCache.set(cacheKey, finalResult);
   }

   return finalResult;
}

function inputPathHelper(path: string): string {
   return path;
}
