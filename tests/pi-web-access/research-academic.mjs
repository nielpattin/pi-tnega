import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const firecrawlPapers = await loadExtension("extensions/pi-web-access/src/providers/firecrawl-research.ts");
const academicResearch = await loadExtension("extensions/pi-web-access/src/research/academic.ts");
const researchService = await loadExtension("extensions/pi-web-access/src/research/service.ts");
const researchTools = await loadExtension("extensions/pi-web-access/src/tools/web-research.ts");

test("searchResearchPapers returns descriptive error when FIRECRAWL_API_KEY is missing", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   delete process.env.FIRECRAWL_API_KEY;

   try {
      const result = await firecrawlPapers.searchResearchPapers({ query: "diffusion models" });
      assert.equal(result.success, false);
      assert.equal(result.results.length, 0);
      assert.ok(result.error?.includes("FIRECRAWL_API_KEY"));
   } finally {
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
   }
});

test("searchResearchPapers constructs valid query and parses results", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   const originalFetch = globalThis.fetch;
   const requests = [];

   process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
   globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return {
         ok: true,
         status: 200,
         json: async () => ({
            success: true,
            results: [
               {
                  paperId: "2014215642691656232",
                  primaryId: "arxiv:2105.05233",
                  ids: { arxiv: ["2105.05233"] },
                  title: "Diffusion Models Beat GANs on Image Synthesis",
                  abstract: "We show that diffusion models can achieve image sample quality...",
                  score: 0.01639
               }
            ]
         })
      };
   };

   try {
      const result = await firecrawlPapers.searchResearchPapers({
         query: "diffusion models",
         authors: "Dhariwal",
         categories: ["cs.LG", "cs.CV"],
         k: 10
      });

      assert.equal(result.success, true);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].title, "Diffusion Models Beat GANs on Image Synthesis");
      assert.equal(result.results[0].primaryId, "arxiv:2105.05233");

      assert.equal(requests.length, 1);
      const reqUrl = new URL(requests[0].url);
      assert.equal(reqUrl.pathname, "/v2/search/research/papers");
      assert.equal(reqUrl.searchParams.get("query"), "diffusion models");
      assert.equal(reqUrl.searchParams.get("authors"), "Dhariwal");
      assert.equal(reqUrl.searchParams.get("categories"), "cs.LG,cs.CV");
      assert.equal(reqUrl.searchParams.get("k"), "10");
   } finally {
      globalThis.fetch = originalFetch;
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
      else delete process.env.FIRECRAWL_API_KEY;
   }
});

test("getPaperOrPassages fetches metadata and passages", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   const originalFetch = globalThis.fetch;
   const requests = [];

   process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
   globalThis.fetch = async (url) => {
      requests.push(String(url));
      return {
         ok: true,
         status: 200,
         json: async () => ({
            success: true,
            paperId: "2014215642691656232",
            query: "FID score comparison",
            paper: {
               paperId: "2014215642691656232",
               title: "Diffusion Models Beat GANs on Image Synthesis",
               abstract: "We show that diffusion models...",
               authors: "Prafulla Dhariwal, Alexander Nichol",
               categories: ["cs.LG"]
            },
            passages: [
               {
                  text: "Our model achieves an FID of 2.97 on ImageNet 128x128.",
                  score: 0.88
               }
            ]
         })
      };
   };

   try {
      const result = await firecrawlPapers.getPaperOrPassages("arxiv:2105.05233", {
         query: "FID score comparison",
         k: 2
      });

      assert.equal(result.success, true);
      assert.equal(result.paper?.title, "Diffusion Models Beat GANs on Image Synthesis");
      assert.equal(result.passages?.length, 1);
      assert.ok(result.passages[0].text.includes("FID of 2.97"));

      assert.equal(requests.length, 1);
      const reqUrl = new URL(requests[0]);
      assert.ok(decodeURIComponent(reqUrl.pathname).includes("arxiv:2105.05233"));
      assert.equal(reqUrl.searchParams.get("query"), "FID score comparison");
      assert.equal(reqUrl.searchParams.get("k"), "2");
   } finally {
      globalThis.fetch = originalFetch;
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
      else delete process.env.FIRECRAWL_API_KEY;
   }
});

test("findRelatedPapers queries citation graph endpoint", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   const originalFetch = globalThis.fetch;
   const requests = [];

   process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
   globalThis.fetch = async (url) => {
      requests.push(String(url));
      return {
         ok: true,
         status: 200,
         json: async () => ({
            success: true,
            results: [
               {
                  paperId: "482107036680302043",
                  primaryId: "arxiv:2006.11239",
                  title: "Denoising Diffusion Probabilistic Models",
                  abstract: "We present high quality image synthesis...",
                  score: 0.032
               }
            ],
            poolSize: 40,
            truncated: false
         })
      };
   };

   try {
      const result = await firecrawlPapers.findRelatedPapers("arxiv:2105.05233", {
         intent: "image synthesis foundational models",
         mode: "references",
         k: 5
      });

      assert.equal(result.success, true);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].primaryId, "arxiv:2006.11239");

      assert.equal(requests.length, 1);
      const reqUrl = new URL(requests[0]);
      assert.ok(reqUrl.pathname.includes("/similar"));
      assert.equal(reqUrl.searchParams.get("intent"), "image synthesis foundational models");
      assert.equal(reqUrl.searchParams.get("mode"), "references");
   } finally {
      globalThis.fetch = originalFetch;
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
      else delete process.env.FIRECRAWL_API_KEY;
   }
});

test("resolvePaperUrl resolves arxiv, doi, pmid, and web ids to canonical urls", () => {
   assert.equal(
      firecrawlPapers.resolvePaperUrl("arxiv:2105.05233"),
      "https://arxiv.org/abs/2105.05233"
   );
   assert.equal(
      firecrawlPapers.resolvePaperUrl("doi:10.1038/s41586-020-2649-2"),
      "https://doi.org/10.1038/s41586-020-2649-2"
   );
   assert.equal(
      firecrawlPapers.resolvePaperUrl("pmid:32814907"),
      "https://pubmed.ncbi.nlm.nih.gov/32814907/"
   );
   assert.equal(
      firecrawlPapers.resolvePaperUrl("pmcid:PMC7438258"),
      "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7438258/"
   );
   assert.equal(
      firecrawlPapers.resolvePaperUrl("web:https://openreview.net/forum?id=123"),
      "https://openreview.net/forum?id=123"
   );
});

test("researchAcademic orchestrates paper search, expansion, passages, and synthesis", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   const originalFetch = globalThis.fetch;

   process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
   globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/search/research/papers/arxiv:2105.05233/similar")) {
         return {
            ok: true,
            status: 200,
            json: async () => ({
               success: true,
               results: [
                  {
                     paperId: "482107036680302043",
                     primaryId: "arxiv:2006.11239",
                     title: "Denoising Diffusion Probabilistic Models",
                     abstract: "Foundational diffusion paper.",
                     score: 0.03
                  }
               ],
               poolSize: 10
            })
         };
      }

      if (urlStr.includes("/search/research/papers/arxiv:2105.05233?")) {
         return {
            ok: true,
            status: 200,
            json: async () => ({
               success: true,
               paperId: "2014215642691656232",
               query: "sample quality",
               paper: {
                  paperId: "2014215642691656232",
                  title: "Diffusion Models Beat GANs on Image Synthesis",
                  abstract: "Abstract content",
                  authors: "Prafulla Dhariwal"
               },
               passages: [
                  {
                     text: "Classifier guidance substantially improves sample fidelity.",
                     score: 0.92
                  }
               ]
            })
         };
      }

      if (urlStr.includes("/search/research/papers?")) {
         return {
            ok: true,
            status: 200,
            json: async () => ({
               success: true,
               results: [
                  {
                     paperId: "2014215642691656232",
                     primaryId: "arxiv:2105.05233",
                     ids: { arxiv: ["2105.05233"] },
                     title: "Diffusion Models Beat GANs on Image Synthesis",
                     abstract: "We show that diffusion models can achieve image sample quality...",
                     score: 0.016
                  }
               ]
            })
         };
      }

      return {
         ok: false,
         status: 404,
         text: async () => "Not Found"
      };
   };

   try {
      const response = await academicResearch.researchAcademic({
         query: "Diffusion Models vs GANs",
         scope: "academic",
         depth: "deep"
      });

      assert.equal(response.query, "Diffusion Models vs GANs");
      assert.ok(response.sources.length >= 1);
      assert.equal(response.sources[0].primaryId, "arxiv:2105.05233");
      assert.ok(response.synthesis.includes("Diffusion Models"));
   } finally {
      globalThis.fetch = originalFetch;
      if (originalKey) process.env.FIRECRAWL_API_KEY = originalKey;
      else delete process.env.FIRECRAWL_API_KEY;
   }
});

test("webResearchTool schema and routing supports scope=academic", () => {
   assert.ok(researchTools.webResearchTool.parameters.properties.scope);
   assert.ok(researchTools.webResearchTool.parameters.properties.authors);
   assert.ok(researchTools.webResearchTool.parameters.properties.categories);
});
