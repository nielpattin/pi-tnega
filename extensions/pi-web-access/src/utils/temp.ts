import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBytes, truncateText } from "./text.ts";

export interface TruncationResult {
   readonly content: string;
   readonly truncated: boolean;
   readonly byteLength: number;
   readonly fullByteLength: number;
   readonly lines: number;
   readonly totalLines: number;
   readonly tempFilePath?: string;
}

export function writeFullContentToTempFile(content: string, urlKey: string): string {
   const hash = createHash("sha256").update(urlKey).digest("hex").slice(0, 12);
   const filename = `pi-fetch-${hash}.md`;
   const filePath = join(tmpdir(), filename);
   writeFileSync(filePath, content, "utf8");
   return filePath;
}

export function applyTruncation(rawContent: string, maxBytes: number, urlKey: string): TruncationResult {
   const totalLines = rawContent.split("\n").length;
   const truncation = truncateText(rawContent, maxBytes);
   if (!truncation.truncated) {
      return {
         content: rawContent,
         truncated: false,
         byteLength: truncation.byteLength,
         fullByteLength: truncation.byteLength,
         lines: totalLines,
         totalLines
      };
   }

   let tempFilePath: string | undefined;
   try {
      tempFilePath = writeFullContentToTempFile(rawContent, urlKey);
   } catch {
      // Disk write fallback
   }

   const notice = tempFilePath
      ? `\n\n---\n*[Output truncated: showing ${formatBytes(maxBytes)} of ${formatBytes(truncation.byteLength)}. Full content saved to: ${tempFilePath}. Use the 'read' tool with offset/limit to inspect specific sections.]*`
      : `\n\n---\n*[Output truncated: showing ${formatBytes(maxBytes)} of ${formatBytes(truncation.byteLength)}]*`;

   const finalContent = truncation.text + notice;
   const visibleLines = finalContent.split("\n").length;

   return {
      content: finalContent,
      truncated: true,
      byteLength: Math.min(maxBytes, truncation.byteLength),
      fullByteLength: truncation.byteLength,
      lines: visibleLines,
      totalLines,
      tempFilePath
   };
}
