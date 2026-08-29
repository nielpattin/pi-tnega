import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const outlineService = await loadExtension("extensions/pi-web-access/src/outline/service.ts");
const outlineTools = await loadExtension("extensions/pi-web-access/src/tools/outline-site.ts");
const toolRenderers = await loadExtension("extensions/pi-web-access/src/ui/tool-renderers.ts");

const testTheme = {
   fg: (_color, text) => String(text),
   bold: (text) => `**${text}**`
};

test("outlineSiteTool conforms to tool definition contract", () => {
   assert.equal(outlineTools.outlineSiteTool.name, "outline_site");
   assert.equal(outlineTools.outlineSiteTool.label, "Outline Site");
   assert.ok(outlineTools.outlineSiteTool.parameters.properties.url);
   assert.ok(outlineTools.outlineSiteTool.parameters.properties.search);
   assert.ok(outlineTools.outlineSiteTool.parameters.properties.limit);
   assert.ok(outlineTools.outlineSiteTool.parameters.properties.sitemap);
   assert.ok(outlineTools.outlineSiteTool.parameters.properties.include_subdomains);
});

test("outlineSite returns clear error when neither FIRECRAWL_API_KEY nor EXA_API_KEY is configured", async () => {
   const originalFirecrawl = process.env.FIRECRAWL_API_KEY;
   const originalExa = process.env.EXA_API_KEY;
   delete process.env.FIRECRAWL_API_KEY;
   delete process.env.EXA_API_KEY;

   try {
      const result = await outlineService.outlineSite({ url: "https://docs.example.com" });
      assert.equal(result.totalLinks, 0);
      assert.ok(result.error?.includes("FIRECRAWL_API_KEY"));
   } finally {
      if (originalFirecrawl) process.env.FIRECRAWL_API_KEY = originalFirecrawl;
      if (originalExa) process.env.EXA_API_KEY = originalExa;
   }
});

test("formatOutlineTextResponse produces readable structured link lists", () => {
   const formatted = outlineTools.formatOutlineTextResponse({
      url: "https://docs.example.com",
      search: "api",
      totalLinks: 2,
      links: [
         { url: "https://docs.example.com/api/intro", title: "API Intro", description: "Getting started with API" },
         { url: "https://docs.example.com/api/auth", title: "Authentication", description: "API Auth tokens" }
      ]
   });

   assert.ok(formatted.includes("Discovered 2 pages"));
   assert.ok(formatted.includes("API Intro - https://docs.example.com/api/intro"));
   assert.ok(formatted.includes("Getting started with API"));
   assert.ok(formatted.includes("Authentication - https://docs.example.com/api/auth"));
});

test("renderOutlineCall and renderOutlineResult produce informative TUI displays", () => {
   const callComp = toolRenderers.renderOutlineCall(
      { url: "https://docs.example.com", search: "schema", limit: 50 },
      testTheme
   );
   assert.ok(callComp);

   // Collapsed
   const collapsedComp = toolRenderers.renderOutlineResult(
      {
         content: [{ type: "text", text: "Discovered links" }],
         details: {
            url: "https://docs.example.com",
            search: "schema",
            totalLinks: 2,
            durationMs: 350,
            links: [
               { url: "https://docs.example.com/schema", title: "Schema Basics" },
               { url: "https://docs.example.com/schema/custom", title: "Custom Types" }
            ]
         }
      },
      { expanded: false },
      testTheme
   );
   assert.ok(collapsedComp);

   // Expanded
   const expandedComp = toolRenderers.renderOutlineResult(
      {
         content: [{ type: "text", text: "Full outline list" }],
         details: {
            url: "https://docs.example.com",
            search: "schema",
            totalLinks: 2,
            durationMs: 350,
            cost: "1 credit",
            links: [
               { url: "https://docs.example.com/schema", title: "Schema Basics" }
            ]
         }
      },
      { expanded: true },
      testTheme
   );
   assert.ok(expandedComp);
});
