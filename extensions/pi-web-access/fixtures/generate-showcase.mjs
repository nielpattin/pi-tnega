import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = join(__dirname, "../fixtures");
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, "pdf-inspector-showcase.pdf");

async function generateShowcasePdf() {
   const doc = await PDFDocument.create();

   const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
   const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
   const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique);
   const fontMono = await doc.embedFont(StandardFonts.Courier);

   // PAGE 1: Typography, Lists, Code, Table
   const page1 = doc.addPage([600, 800]);
   let y = 750;

   // H1 Title
   page1.drawText("PDF Inspector Comprehensive Showcase", {
      x: 50,
      y,
      size: 22,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.2)
   });
   y -= 30;

   // H2 Subtitle
   page1.drawText("Demonstrating Full Layout, Table, and Typography Detection", {
      x: 50,
      y,
      size: 15,
      font: fontBold,
      color: rgb(0.3, 0.3, 0.4)
   });
   y -= 25;

   // Body with bold & italic
   page1.drawText("This document is specifically crafted to exercise the layout engine of Firecrawl's pdf-inspector.", {
      x: 50,
      y,
      size: 10,
      font: fontRegular,
      color: rgb(0.2, 0.2, 0.2)
   });
   y -= 15;
   page1.drawText("It contains bold emphasis, italic commentary, and structured data elements.", {
      x: 50,
      y,
      size: 10,
      font: fontOblique,
      color: rgb(0.2, 0.2, 0.2)
   });
   y -= 25;

   // H3: Lists Section
   page1.drawText("Structured Lists", {
      x: 50,
      y,
      size: 13,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.25)
   });
   y -= 18;

   // Bullet List
   page1.drawText("• High-precision spatial text extraction with font statistics", {
      x: 60,
      y,
      size: 10,
      font: fontRegular
   });
   y -= 15;
   page1.drawText("• Dual-mode table detection with rectangle and heuristic alignment", {
      x: 60,
      y,
      size: 10,
      font: fontRegular
   });
   y -= 15;
   page1.drawText("• Multi-column newspaper reading order recovery", {
      x: 60,
      y,
      size: 10,
      font: fontRegular
   });
   y -= 22;

   // Numbered List
   page1.drawText("1. Parse xref table and sample page content streams", {
      x: 60,
      y,
      size: 10,
      font: fontRegular
   });
   y -= 15;
   page1.drawText("2. Extract positioned TextItems and PdfRects", {
      x: 60,
      y,
      size: 10,
      font: fontRegular
   });
   y -= 15;
   page1.drawText("3. Synthesize clean, structured Markdown output", {
      x: 60,
      y,
      size: 10,
      font: fontRegular
   });
   y -= 25;

   // H3: Code Block Section
   page1.drawText("Code Block (Monospace Font)", {
      x: 50,
      y,
      size: 13,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.25)
   });
   y -= 18;

   page1.drawRectangle({
      x: 50,
      y: y - 45,
      width: 500,
      height: 55,
      color: rgb(0.95, 0.95, 0.97),
      borderColor: rgb(0.85, 0.85, 0.9),
      borderWidth: 1
   });

   page1.drawText("import { processPdf } from '@firecrawl/pdf-inspector';", {
      x: 60,
      y: y - 10,
      size: 9,
      font: fontMono,
      color: rgb(0.1, 0.1, 0.4)
   });
   page1.drawText("const result = processPdf(pdfBuffer);", {
      x: 60,
      y: y - 24,
      size: 9,
      font: fontMono,
      color: rgb(0.1, 0.1, 0.4)
   });
   page1.drawText("console.log(result.markdown);", {
      x: 60,
      y: y - 38,
      size: 9,
      font: fontMono,
      color: rgb(0.1, 0.1, 0.4)
   });
   y -= 70;

   // H3: Table Section
   page1.drawText("Table 1: Benchmark Comparisons", {
      x: 50,
      y,
      size: 13,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.25)
   });
   y -= 18;

   // Draw Table Grid
   const tableTop = y;
   const col1 = 50;
   const col2 = 200;
   const col3 = 340;
   const col4 = 460;
   const tableWidth = 500;
   const rowHeight = 22;

   // Header row background
   page1.drawRectangle({
      x: 50,
      y: tableTop - rowHeight,
      width: tableWidth,
      height: rowHeight,
      color: rgb(0.9, 0.92, 0.96)
   });

   // Header text
   page1.drawText("Engine", { x: col1 + 10, y: tableTop - 15, size: 9, font: fontBold });
   page1.drawText("Reading Order", { x: col2 + 10, y: tableTop - 15, size: 9, font: fontBold });
   page1.drawText("Table TEDS", { x: col3 + 10, y: tableTop - 15, size: 9, font: fontBold });
   page1.drawText("Latency (200 docs)", { x: col4 + 10, y: tableTop - 15, size: 9, font: fontBold });

   // Row 1
   page1.drawText("pdf-inspector (Rust)", { x: col1 + 10, y: tableTop - 15 - rowHeight, size: 9, font: fontRegular });
   page1.drawText("0.915", { x: col2 + 10, y: tableTop - 15 - rowHeight, size: 9, font: fontRegular });
   page1.drawText("0.814", { x: col3 + 10, y: tableTop - 15 - rowHeight, size: 9, font: fontRegular });
   page1.drawText("0.470s", { x: col4 + 10, y: tableTop - 15 - rowHeight, size: 9, font: fontRegular });

   // Row 2
   page1.drawText("LiteParse", { x: col1 + 10, y: tableTop - 15 - rowHeight * 2, size: 9, font: fontRegular });
   page1.drawText("0.913", { x: col2 + 10, y: tableTop - 15 - rowHeight * 2, size: 9, font: fontRegular });
   page1.drawText("0.693", { x: col3 + 10, y: tableTop - 15 - rowHeight * 2, size: 9, font: fontRegular });
   page1.drawText("0.750s", { x: col4 + 10, y: tableTop - 15 - rowHeight * 2, size: 9, font: fontRegular });

   // Row 3
   page1.drawText("PyMuPDF4LLM", { x: col1 + 10, y: tableTop - 15 - rowHeight * 3, size: 9, font: fontRegular });
   page1.drawText("0.886", { x: col2 + 10, y: tableTop - 15 - rowHeight * 3, size: 9, font: fontRegular });
   page1.drawText("0.401", { x: col3 + 10, y: tableTop - 15 - rowHeight * 3, size: 9, font: fontRegular });
   page1.drawText("17.117s", { x: col4 + 10, y: tableTop - 15 - rowHeight * 3, size: 9, font: fontRegular });

   // Table borders
   for (let i = 0; i <= 4; i++) {
      page1.drawLine({
         start: { x: col1, y: tableTop - i * rowHeight },
         end: { x: col1 + tableWidth, y: tableTop - i * rowHeight },
         thickness: 1,
         color: rgb(0.8, 0.8, 0.85)
      });
   }
   for (const x of [col1, col2, col3, col4, col1 + tableWidth]) {
      page1.drawLine({
         start: { x, y: tableTop },
         end: { x, y: tableTop - 4 * rowHeight },
         thickness: 1,
         color: rgb(0.8, 0.8, 0.85)
      });
   }

   // PAGE 2: Multi-column Layout & Financial Table
   const page2 = doc.addPage([600, 800]);
   let y2 = 750;

   // H1 on Page 2
   page2.drawText("Page 2: Multi-Column Layout & Metrics", {
      x: 50,
      y: y2,
      size: 20,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.2)
   });
   y2 -= 35;

   // 2-Column Section Header
   page2.drawText("Parallel Architecture Analysis", {
      x: 50,
      y: y2,
      size: 13,
      font: fontBold,
      color: rgb(0.2, 0.2, 0.3)
   });
   y2 -= 20;

   // Column 1 (Left: x 50..270)
   const colLeftX = 50;
   page2.drawText("Column A: Spatial Grouping", { x: colLeftX, y: y2, size: 10, font: fontBold });
   page2.drawText("The parser detects multi-column", { x: colLeftX, y: y2 - 14, size: 9, font: fontRegular });
   page2.drawText("layouts by projecting vertical", { x: colLeftX, y: y2 - 28, size: 9, font: fontRegular });
   page2.drawText("gutters across text items.", { x: colLeftX, y: y2 - 42, size: 9, font: fontRegular });
   page2.drawText("Lines within each column are", { x: colLeftX, y: y2 - 56, size: 9, font: fontRegular });
   page2.drawText("grouped sequentially before", { x: colLeftX, y: y2 - 70, size: 9, font: fontRegular });
   page2.drawText("advancing to the next column.", { x: colLeftX, y: y2 - 84, size: 9, font: fontRegular });

   // Column 2 (Right: x 310..530)
   const colRightX = 310;
   page2.drawText("Column B: Reading Order", { x: colRightX, y: y2, size: 10, font: fontBold });
   page2.drawText("This ensures newspaper-style and", { x: colRightX, y: y2 - 14, size: 9, font: fontRegular });
   page2.drawText("academic paper columns are read", { x: colRightX, y: y2 - 28, size: 9, font: fontRegular });
   page2.drawText("top-to-bottom per column rather", { x: colRightX, y: y2 - 42, size: 9, font: fontRegular });
   page2.drawText("than interleaved horizontally.", { x: colRightX, y: y2 - 56, size: 9, font: fontRegular });
   page2.drawText("Full ToUnicode CMaps resolve all", { x: colRightX, y: y2 - 70, size: 9, font: fontRegular });
   page2.drawText("custom glyph identifiers.", { x: colRightX, y: y2 - 84, size: 9, font: fontRegular });

   y2 -= 120;

   // Financial Section
   page2.drawText("Table 2: Quarterly Operating Breakdown", {
      x: 50,
      y: y2,
      size: 13,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.25)
   });
   y2 -= 18;

   const finTop = y2;
   const fCol1 = 50;
   const fCol2 = 230;
   const fCol3 = 340;
   const fCol4 = 450;

   page2.drawRectangle({
      x: 50,
      y: finTop - rowHeight,
      width: tableWidth,
      height: rowHeight,
      color: rgb(0.92, 0.94, 0.97)
   });

   page2.drawText("Segment", { x: fCol1 + 10, y: finTop - 15, size: 9, font: fontBold });
   page2.drawText("Q1 Revenue ($M)", { x: fCol2 + 10, y: finTop - 15, size: 9, font: fontBold });
   page2.drawText("Q2 Revenue ($M)", { x: fCol3 + 10, y: finTop - 15, size: 9, font: fontBold });
   page2.drawText("YoY Growth (%)", { x: fCol4 + 10, y: finTop - 15, size: 9, font: fontBold });

   page2.drawText("Cloud Compute", { x: fCol1 + 10, y: finTop - 15 - rowHeight, size: 9, font: fontRegular });
   page2.drawText("$1,245.50", { x: fCol2 + 10, y: finTop - 15 - rowHeight, size: 9, font: fontRegular });
   page2.drawText("$1,480.20", { x: fCol3 + 10, y: finTop - 15 - rowHeight, size: 9, font: fontRegular });
   page2.drawText("+18.8%", { x: fCol4 + 10, y: finTop - 15 - rowHeight, size: 9, font: fontRegular });

   page2.drawText("Vector Search Engine", {
      x: fCol1 + 10,
      y: finTop - 15 - rowHeight * 2,
      size: 9,
      font: fontRegular
   });
   page2.drawText("$820.10", { x: fCol2 + 10, y: finTop - 15 - rowHeight * 2, size: 9, font: fontRegular });
   page2.drawText("$1,095.40", { x: fCol3 + 10, y: finTop - 15 - rowHeight * 2, size: 9, font: fontRegular });
   page2.drawText("+33.6%", { x: fCol4 + 10, y: finTop - 15 - rowHeight * 2, size: 9, font: fontRegular });

   page2.drawText("AI Agent Workflows", { x: fCol1 + 10, y: finTop - 15 - rowHeight * 3, size: 9, font: fontRegular });
   page2.drawText("$450.00", { x: fCol2 + 10, y: finTop - 15 - rowHeight * 3, size: 9, font: fontRegular });
   page2.drawText("$710.80", { x: fCol3 + 10, y: finTop - 15 - rowHeight * 3, size: 9, font: fontRegular });
   page2.drawText("+57.9%", { x: fCol4 + 10, y: finTop - 15 - rowHeight * 3, size: 9, font: fontRegular });

   for (let i = 0; i <= 4; i++) {
      page2.drawLine({
         start: { x: fCol1, y: finTop - i * rowHeight },
         end: { x: fCol1 + tableWidth, y: finTop - i * rowHeight },
         thickness: 1,
         color: rgb(0.8, 0.8, 0.85)
      });
   }
   for (const x of [fCol1, fCol2, fCol3, fCol4, fCol1 + tableWidth]) {
      page2.drawLine({
         start: { x, y: finTop },
         end: { x, y: finTop - 4 * rowHeight },
         thickness: 1,
         color: rgb(0.8, 0.8, 0.85)
      });
   }

   const pdfBytes = await doc.save();
   writeFileSync(outputPath, Buffer.from(pdfBytes));
   console.log(`Generated showcase PDF: ${outputPath} (${pdfBytes.length} bytes)`);
}

await generateShowcasePdf();
