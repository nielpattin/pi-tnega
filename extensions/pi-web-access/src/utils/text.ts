export function formatBytes(bytes: number): string {
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
   return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(durationMs?: number): string {
   if (durationMs === undefined || durationMs < 0) return "";
   if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
   return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatCost(value: unknown): string | undefined {
   if (value === undefined || value === null) return undefined;
   if (typeof value === "number") {
      return `$${value.toFixed(4).replace(/\.?0+$/, "")}`;
   }
   if (typeof value === "object" && "total" in value && typeof (value as { total: unknown }).total === "number") {
      const total = (value as { total: number }).total;
      return `$${total.toFixed(4).replace(/\.?0+$/, "")}`;
   }
   if (typeof value === "string" && value.length > 0) {
      return value;
   }
   return undefined;
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean; byteLength: number } {
   const encoder = new TextEncoder();
   const encoded = encoder.encode(text);
   const byteLength = encoded.length;

   if (byteLength <= maxBytes) {
      return { text, truncated: false, byteLength };
   }

   const decoder = new TextDecoder("utf-8", { fatal: false });
   const slice = encoded.subarray(0, maxBytes);
   const truncatedText = decoder.decode(slice);

   return {
      text: truncatedText,
      truncated: true,
      byteLength
   };
}

export function stripHtmlTags(html: string): string {
   return html.replace(/<[^>]+>/g, "");
}

export function cleanSnippet(snippet: string): string {
   return snippet
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
}

export function normalizeUrl(rawUrl: string): string {
   const trimmed = rawUrl.trim();
   if (!trimmed) return "";
   if (/^https?:\/\//i.test(trimmed)) return trimmed;
   return `https://${trimmed}`;
}
