import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { loadExtension } from "../_bootstrap.mjs";

const extractor = await loadExtension("extensions/pi-web-access/src/fetch/extractor.ts");
const github = await loadExtension("extensions/pi-web-access/src/fetch/github.ts");
const pdfExtractor = await loadExtension("extensions/pi-web-access/src/fetch/pdf.ts");
const fetchService = await loadExtension("extensions/pi-web-access/src/fetch/service.ts");
const textUtils = await loadExtension("extensions/pi-web-access/src/utils/text.ts");
const tempUtils = await loadExtension("extensions/pi-web-access/src/utils/temp.ts");
const firecrawlFetch = await loadExtension("extensions/pi-web-access/src/fetch/firecrawl.ts");
const exaFetch = await loadExtension("extensions/pi-web-access/src/fetch/exa.ts");

test("extractHtmlContent extracts title and markdown from HTML article", () => {
   const html = `
      <!DOCTYPE html>
      <html>
         <head><title>Test Article Title</title></head>
         <body>
            <nav><a href="/home">Home</a></nav>
            <article>
               <h1>Test Article Title</h1>
               <p>This is the first paragraph of the article with important details.</p>
               <h2>Section 1</h2>
               <p>Here is some code: <code>console.log('hello');</code></p>
               <ul>
                  <li>Item 1</li>
                  <li>Item 2</li>
               </ul>
            </article>
            <footer>Copyright 2026</footer>
         </body>
      </html>
   `;

   const result = extractor.extractHtmlContent(html);
   assert.equal(result.title, "Test Article Title");
   assert.ok(result.content.includes("This is the first paragraph"));
   assert.ok(result.content.includes("console.log('hello');"));
   assert.ok(result.content.includes("Item 1"));
   // Nav and footer should be stripped
   assert.equal(result.content.includes("Copyright 2026"), false);
});

test("extractHtmlContent extracts page links when includeLinks is true", () => {
   const html = `
      <html>
         <body>
            <p>Check out <a href="https://example.com/docs">the documentation</a> and <a href="https://github.com/repo">GitHub</a>.</p>
         </body>
      </html>
   `;

   const result = extractor.extractHtmlContent(html, { includeLinks: true });
   assert.ok(result.links);
   assert.ok(result.links.some((link) => link.includes("https://example.com/docs")));
   assert.ok(result.links.some((link) => link.includes("https://github.com/repo")));
});

test("transformGitHubUrl transforms blob and raw github URLs to raw user content", () => {
   const blobUrl = new URL("https://github.com/owner/repo/blob/main/src/index.ts");
   assert.equal(
      github.transformGitHubUrl(blobUrl),
      "https://raw.githubusercontent.com/owner/repo/main/src/index.ts"
   );

   const rawUrl = new URL("https://raw.githubusercontent.com/owner/repo/main/src/index.ts");
   assert.equal(github.transformGitHubUrl(rawUrl), "https://raw.githubusercontent.com/owner/repo/main/src/index.ts");
});

test("isLocalFilePath identifies local file paths and file URLs", () => {
   assert.equal(fetchService.isLocalFilePath("file:///path/to/file.pdf"), true);
   assert.equal(fetchService.isLocalFilePath("C:\\Users\\docs\\test.pdf"), true);
   assert.equal(fetchService.isLocalFilePath("/home/user/doc.pdf"), true);
   assert.equal(fetchService.isLocalFilePath("./package.json"), true);
   assert.equal(fetchService.isLocalFilePath("https://example.com"), false);
});

test("fetchWebContent handles local files directly", async () => {
   const result = await fetchService.fetchWebContent({ url: "./package.json" });
   assert.equal(result.statusCode, 200);
   assert.ok(result.content.includes('"name":'));
});

test("fetchWebContent extracts structured Markdown from showcase PDF fixture", async () => {
   const result = await fetchService.fetchWebContent({
      url: "./extensions/pi-web-access/fixtures/pdf-inspector-showcase.pdf"
   });
   assert.equal(result.statusCode, 200);
   assert.equal(result.contentType, "application/pdf");
   // Headings
   assert.ok(result.content.includes("# PDF Inspector Comprehensive Showcase"));
   // Lists
   assert.ok(result.content.includes("High-precision spatial text extraction"));
   // Code block
   assert.ok(result.content.includes("```\nimport { processPdf }"));
   // Markdown tables
   assert.ok(result.content.includes("|Engine|Reading Order|Table TEDS|Latency (200 docs)|"));
   assert.ok(result.content.includes("|pdf-inspector (Rust)|0.915|0.814|0.470s|"));
   assert.ok(result.content.includes("|Cloud Compute|$1,245.50|$1,480.20|+18.8%|"));
});

test("extractPdfContent extracts text safely using pdf-inspector", async () => {
   const emptyBuffer = Buffer.from("not a pdf");
   const result = await pdfExtractor.extractPdfContent(emptyBuffer);
   assert.equal(typeof result.content, "string");
   assert.equal(result.pageCount, 0);
});

test("truncateText truncates cleanly at byte boundaries", () => {
   const sample = "Hello, world! This is a test.";
   const result = textUtils.truncateText(sample, 10);
   assert.equal(result.truncated, true);
   assert.equal(result.text, "Hello, wor");
   assert.equal(result.byteLength, sample.length);
});

test("applyTruncation saves full content to temp file and appends hint when truncated", () => {
   const fullText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.";
   const result = tempUtils.applyTruncation(fullText, 25, "https://example.com/long-article");

   assert.equal(result.truncated, true);
   assert.equal(result.fullByteLength, fullText.length);
   assert.ok(result.tempFilePath);
   assert.ok(existsSync(result.tempFilePath));
   assert.ok(result.content.includes("Full content saved to:"));
   assert.ok(result.content.includes(result.tempFilePath));

   const savedOnDisk = readFileSync(result.tempFilePath, "utf8");
   assert.equal(savedOnDisk, fullText);

   // Clean up test file
   try {
      unlinkSync(result.tempFilePath);
   } catch {
      // Ignored
   }
});

test("applyTruncation leaves untruncated content untouched without creating temp file", () => {
   const shortText = "Short text under max budget";
   const result = tempUtils.applyTruncation(shortText, 500, "https://example.com/short");

   assert.equal(result.truncated, false);
   assert.equal(result.content, shortText);
   assert.equal(result.tempFilePath, undefined);
});

test("formatBytes formats byte sizes accurately", () => {
   assert.equal(textUtils.formatBytes(500), "500 B");
   assert.equal(textUtils.formatBytes(2048), "2.0 KB");
   assert.equal(textUtils.formatBytes(2 * 1024 * 1024), "2.00 MB");
});

test("fetchWithFirecrawl returns error when FIRECRAWL_API_KEY is not configured", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   delete process.env.FIRECRAWL_API_KEY;

   try {
      const result = await firecrawlFetch.fetchWithFirecrawl("https://example.com", {});
      assert.equal(result.provider, "firecrawl");
      assert.ok(result.error?.includes("FIRECRAWL_API_KEY"));
   } finally {
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
   }
});

test("parseLocalFileWithFirecrawl returns error when FIRECRAWL_API_KEY is missing", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   delete process.env.FIRECRAWL_API_KEY;

   try {
      const result = await firecrawlFetch.parseLocalFileWithFirecrawl(
         "sample.docx",
         Buffer.from("dummy docx content"),
         {}
      );
      assert.equal(result.provider, "firecrawl");
      assert.ok(result.error?.includes("FIRECRAWL_API_KEY"));
   } finally {
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
   }
});

test("fetchWithExa returns error when EXA_API_KEY is not configured", async () => {
   const originalKey = process.env.EXA_API_KEY;
   delete process.env.EXA_API_KEY;

   try {
      const result = await exaFetch.fetchWithExa("https://example.com", {});
      assert.equal(result.provider, "exa");
      assert.ok(result.error?.includes("EXA_API_KEY"));
   } finally {
      if (originalKey) process.env.EXA_API_KEY = originalKey;
   }
});
