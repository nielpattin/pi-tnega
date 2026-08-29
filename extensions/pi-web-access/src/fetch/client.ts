import { getWebAccessConfig } from "../config.ts";
import { validateSafeUrl } from "./ssrf.ts";

export type FetchBodyInit = string | Uint8Array | FormData | Blob | ArrayBuffer | ReadableStream | null;

export interface FetchRequestOptions {
   readonly method?: string;
   readonly headers?: Record<string, string>;
   readonly body?: FetchBodyInit;
   readonly timeoutMs?: number;
   readonly signal?: AbortSignal;
   readonly maxRedirects?: number;
}

export async function fetchWithTimeout(targetUrl: string | URL, options: FetchRequestOptions = {}): Promise<Response> {
   const config = getWebAccessConfig();
   const timeoutMs = options.timeoutMs ?? config.timeoutMs;
   const maxRedirects = options.maxRedirects ?? 5;

   let currentUrl = typeof targetUrl === "string" ? targetUrl : targetUrl.toString();
   let redirectsCount = 0;

   while (redirectsCount <= maxRedirects) {
      const validatedUrl = await validateSafeUrl(currentUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
         controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onParentAbort = () => {
         controller.abort(options.signal?.reason ?? new Error("Aborted by caller"));
      };

      if (options.signal) {
         options.signal.addEventListener("abort", onParentAbort);
      }

      try {
         const response = await fetch(validatedUrl.toString(), {
            method: options.method ?? "GET",
            headers: {
               "User-Agent": config.userAgent,
               Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.7",
               "Accept-Language": "en-US,en;q=0.9",
               ...options.headers
            },
            body: options.body,
            signal: controller.signal,
            redirect: "manual"
         });

         // Handle redirects manually to validate destination with SSRF checks
         if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
               return response;
            }

            redirectsCount++;
            if (redirectsCount > maxRedirects) {
               throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
            }

            currentUrl = new URL(location, validatedUrl).toString();
            continue;
         }

         return response;
      } finally {
         clearTimeout(timeoutId);
         if (options.signal) {
            options.signal.removeEventListener("abort", onParentAbort);
         }
      }
   }

   throw new Error("Too many redirects");
}
