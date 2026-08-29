import { extractText, processPdf, processPdfAsync } from "@firecrawl/pdf-inspector";

export interface ExtractedPdf {
   readonly title?: string;
   readonly content: string;
   readonly pageCount: number;
   readonly isScanned?: boolean;
}

export async function extractPdfContent(pdfData: ArrayBuffer | Uint8Array | Buffer): Promise<ExtractedPdf> {
   const buffer = Buffer.isBuffer(pdfData)
      ? pdfData
      : Buffer.from(pdfData instanceof ArrayBuffer ? pdfData : pdfData.buffer);

   try {
      const result = await processPdfAsync(buffer);
      const content = result.markdown || extractText(buffer) || "";
      const pdfTypeStr = String(result.pdfType);

      return {
         title: result.title,
         content: content.trim(),
         pageCount: result.pageCount,
         isScanned: pdfTypeStr === "Scanned" || pdfTypeStr === "ImageBased"
      };
   } catch {
      try {
         const syncResult = processPdf(buffer);
         const content = syncResult.markdown || extractText(buffer) || "";
         const pdfTypeStr = String(syncResult.pdfType);

         return {
            title: syncResult.title,
            content: content.trim(),
            pageCount: syncResult.pageCount,
            isScanned: pdfTypeStr === "Scanned" || pdfTypeStr === "ImageBased"
         };
      } catch {
         return {
            title: undefined,
            content: "",
            pageCount: 0,
            isScanned: false
         };
      }
   }
}
