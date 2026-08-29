import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const researchService = await loadExtension("extensions/pi-web-access/src/research/service.ts");
const researchTools = await loadExtension("extensions/pi-web-access/src/tools/web-research.ts");

test("resolveResearchProvider respects explicit provider", () => {
   assert.equal(researchService.resolveResearchProvider("firecrawl"), "firecrawl");
   assert.equal(researchService.resolveResearchProvider("exa"), "exa");
});

test("webResearchTool has valid parameters and schema", () => {
   assert.equal(researchTools.webResearchTool.name, "web_research");
   assert.equal(researchTools.webResearchTool.label, "Web Research");
   assert.ok(researchTools.webResearchTool.parameters.properties.query);
   assert.ok(researchTools.webResearchTool.parameters.properties.depth);
   assert.ok(researchTools.webResearchTool.parameters.properties.provider);
   assert.ok(researchTools.webResearchTool.parameters.properties.includeDomains);
   assert.ok(researchTools.webResearchTool.parameters.properties.excludeDomains);
   assert.ok(researchTools.webResearchTool.parameters.properties.systemPrompt);
});

test("formatResearchTextResponse formats synthesis and sources", () => {
   const formatted = researchTools.formatResearchTextResponse({
      query: "test topic",
      provider: "firecrawl",
      synthesis: "Comprehensive summary of findings.",
      sources: [
         { title: "Docs", url: "https://docs.example.com", snippet: "Useful snippet text" }
      ]
   });

   assert.ok(formatted.includes("Comprehensive summary of findings."));
   assert.ok(formatted.includes("https://docs.example.com"));
   assert.ok(formatted.includes("Referenced Sources"));
});
