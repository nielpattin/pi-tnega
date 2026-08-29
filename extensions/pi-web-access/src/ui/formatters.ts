import type { Theme } from "@earendil-works/pi-coding-agent";

export function formatUrlSummary(urlString: string, maxLength = 80): string {
   if (!urlString) return "";
   const trimmed = urlString.trim();

   // Handle Windows drive path, absolute POSIX path, or relative path
   if (
      /^[a-zA-Z]:[\\/]/.test(trimmed) ||
      trimmed.startsWith("/") ||
      trimmed.startsWith("\\") ||
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      trimmed.startsWith(".\\") ||
      trimmed.startsWith("..\\")
   ) {
      if (trimmed.length <= maxLength) return trimmed;
      return `...${trimmed.slice(-maxLength + 3)}`;
   }

   // Handle file:// URLs
   if (trimmed.startsWith("file://")) {
      try {
         const decoded = decodeURIComponent(trimmed.slice(7));
         if (decoded.length <= maxLength) return decoded;
         return `...${decoded.slice(-maxLength + 3)}`;
      } catch {
         return trimmed;
      }
   }

   // Handle Web URLs (http://, https://)
   try {
      const parsed = new URL(trimmed);
      const decodedPathname = decodeURI(parsed.pathname);
      const display = `${parsed.hostname}${decodedPathname === "/" ? "" : decodedPathname}`;
      return display.length > maxLength ? `${display.slice(0, maxLength - 3)}...` : display;
   } catch {
      try {
         const decoded = decodeURIComponent(trimmed);
         return decoded.length > maxLength ? `${decoded.slice(0, maxLength - 3)}...` : decoded;
      } catch {
         return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
      }
   }
}

export function formatStatusBadge(statusCode: number, theme: Theme): string {
   if (statusCode >= 200 && statusCode < 300) {
      return theme.fg("success", `${statusCode} OK`);
   }
   if (statusCode >= 300 && statusCode < 400) {
      return theme.fg("warning", `${statusCode} Redirect`);
   }
   if (statusCode >= 400) {
      return theme.fg("error", `${statusCode} Error`);
   }
   return theme.fg("muted", String(statusCode));
}
