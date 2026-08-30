import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const webSearch = await loadExtension("extensions/pi-web-access/src/tools/web-search.ts");
const fetchTools = await loadExtension("extensions/pi-web-access/src/tools/fetch-content.ts");
const researchTools = await loadExtension("extensions/pi-web-access/src/tools/web-research.ts");
const toolRenderers = await loadExtension("extensions/pi-web-access/src/ui/tool-renderers.ts");

const testTheme = {
   fg: (_color, text) => String(text),
   bold: (text) => `**${text}**`
};

function renderText(component) {
   return component.render(200).join("\n");
}

test("webSearchTool conforms to tool definition contract", () => {
   assert.equal(webSearch.webSearchTool.name, "web_search");
   assert.equal(typeof webSearch.webSearchTool.description, "string");
   assert.ok(webSearch.webSearchTool.parameters.properties.query);
   assert.ok(webSearch.webSearchTool.parameters.properties.provider);
   assert.ok(webSearch.webSearchTool.parameters.properties.mode);
   assert.ok(webSearch.webSearchTool.parameters.properties.category);
   assert.ok(webSearch.webSearchTool.parameters.properties.includeDomains);
   assert.ok(webSearch.webSearchTool.parameters.properties.excludeDomains);
   assert.ok(webSearch.webSearchTool.parameters.properties.userLocation);
   assert.equal(typeof webSearch.webSearchTool.renderCall, "function");
   assert.equal(typeof webSearch.webSearchTool.renderResult, "function");
});

test("fetchContentTool conforms to tool definition contract", () => {
   assert.equal(fetchTools.fetchContentTool.name, "fetch_content");
   assert.equal(typeof fetchTools.fetchContentTool.description, "string");
   assert.ok(fetchTools.fetchContentTool.parameters.properties.url);
   assert.ok(fetchTools.fetchContentTool.parameters.properties.provider);
   assert.ok(fetchTools.fetchContentTool.parameters.properties.format);
   assert.ok(fetchTools.fetchContentTool.parameters.properties.include_links);
});

test("webResearchTool conforms to tool definition contract", () => {
   assert.equal(researchTools.webResearchTool.name, "web_research");
   assert.equal(typeof researchTools.webResearchTool.description, "string");
   assert.ok(researchTools.webResearchTool.parameters.properties.query);
   assert.ok(researchTools.webResearchTool.parameters.properties.depth);
   assert.ok(researchTools.webResearchTool.parameters.properties.provider);
   assert.ok(researchTools.webResearchTool.parameters.properties.includeDomains);
   assert.ok(researchTools.webResearchTool.parameters.properties.excludeDomains);
   assert.ok(researchTools.webResearchTool.parameters.properties.systemPrompt);
});

test("formatSearchTextResponse produces structured output with answers and items", () => {
   const formatted = webSearch.formatSearchTextResponse({
      query: "test query",
      provider: "firecrawl",
      answer: "Direct synthesis answer",
      results: [
         {
            title: "Result Title",
            url: "https://example.com/test",
            snippet: "Snippet description details"
         }
      ]
   });

   assert.ok(formatted.includes("Direct synthesis answer"));
   assert.ok(formatted.includes("Result Title"));
   assert.ok(formatted.includes("https://example.com/test"));
   assert.ok(formatted.includes("Snippet description details"));
});

test("renderSearchCall and renderSearchResult produce informative TUI displays", () => {
   const callComp = toolRenderers.renderSearchCall(
      { query: "TypeScript 5.8", provider: "exa", category: "publication" },
      testTheme
   );
   assert.ok(callComp);

   // Collapsed search result
   const collapsedComp = toolRenderers.renderSearchResult(
      {
         content: [{ type: "text", text: "Formatted results" }],
         details: {
            query: "TypeScript 5.8",
            provider: "exa",
            cost: "$0.002",
            results: [
               { title: "TypeScript 5.8 Announcement", url: "https://devblogs.microsoft.com/ts58", snippet: "Release details" }
            ]
         }
      },
      { expanded: false },
      testTheme
   );
   assert.match(renderText(collapsedComp), /Cost: \$0\.002/);

   // Expanded search result
   const expandedComp = toolRenderers.renderSearchResult(
      {
         content: [{ type: "text", text: "Formatted results text" }],
         details: {
            query: "TypeScript 5.8",
            provider: "exa",
            cost: "$0.002",
            results: [
               { title: "TypeScript 5.8 Announcement", url: "https://devblogs.microsoft.com/ts58", snippet: "Release details" }
            ]
         }
      },
      { expanded: true },
      testTheme
   );
   assert.match(renderText(expandedComp), /Cost: \$0\.002/);
});

test("renderFetchCall and renderFetchResult produce informative TUI displays", () => {
   const callComp = toolRenderers.renderFetchCall({ url: "https://example.com", provider: "firecrawl" }, testTheme);
   assert.ok(callComp);

   // Collapsed fetch result
   const collapsedComp = toolRenderers.renderFetchResult(
      {
         content: [{ type: "text", text: "# Page Content" }],
         details: {
            url: "https://example.com",
            title: "Example Page",
            content: "Page Content",
            contentType: "text/html",
            statusCode: 200,
            cost: "1 credit",
            truncated: false,
            byteLength: 1200
         }
      },
      { expanded: false },
      testTheme
   );
   assert.match(renderText(collapsedComp), /Cost: 1 credit/);

   // Expanded fetch result
   const expandedComp = toolRenderers.renderFetchResult(
      {
         content: [{ type: "text", text: "# Page Content\n\nFull body text" }],
         details: {
            url: "https://example.com",
            title: "Example Page",
            content: "Page Content",
            contentType: "text/html",
            statusCode: 200,
            cost: "1 credit",
            truncated: false,
            byteLength: 1200
         }
      },
      { expanded: true },
      testTheme
   );
   assert.match(renderText(expandedComp), /Cost: 1 credit/);
});

test("renderResearchCall and renderResearchResult produce informative TUI displays", () => {
   const callComp = toolRenderers.renderResearchCall(
      { query: "Quantum computing breakthroughs", depth: "deep", provider: "firecrawl" },
      testTheme
   );
   assert.ok(callComp);

   const resultComp = toolRenderers.renderResearchResult(
      {
         content: [{ type: "text", text: "## Quantum Findings\n\nDetailed analysis text" }],
         details: {
            query: "Quantum computing breakthroughs",
            provider: "firecrawl",
            synthesis: "Detailed analysis text",
            sources: [{ title: "Nature Paper", url: "https://nature.com/articles/123" }]
         }
      },
      { expanded: false },
      testTheme
   );
   assert.ok(resultComp);
});
