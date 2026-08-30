import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const providers = await loadExtension("extensions/pi-web-access/src/providers/index.ts");
const firecrawl = await loadExtension("extensions/pi-web-access/src/providers/firecrawl.ts");
const exa = await loadExtension("extensions/pi-web-access/src/providers/exa.ts");

test("resolveProvider respects explicit provider request", () => {
   assert.equal(providers.resolveProvider("tavily"), "tavily");
   assert.equal(providers.resolveProvider("exa"), "exa");
   assert.equal(providers.resolveProvider("firecrawl"), "firecrawl");
});

test("resolveProvider prioritizes defaultProvider when configured and available", () => {
   const originalDefault = process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER;
   const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;

   try {
      process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER = "firecrawl";
      process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";

      const resolved = providers.resolveProvider("auto");
      assert.equal(resolved, "firecrawl");
   } finally {
      if (originalDefault) process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER = originalDefault;
      else delete process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER;

      if (originalFirecrawlKey) process.env.FIRECRAWL_API_KEY = originalFirecrawlKey;
      else delete process.env.FIRECRAWL_API_KEY;
   }
});

test("PROVIDERS registry contains only firecrawl, exa, and tavily", () => {
   const expected = ["firecrawl", "exa", "tavily"];
   assert.equal(Object.keys(providers.PROVIDERS).length, 3);
   for (const name of expected) {
      assert.ok(providers.PROVIDERS[name], `Missing provider: ${name}`);
      assert.equal(providers.PROVIDERS[name].id, name);
      assert.ok(typeof providers.PROVIDERS[name].search === "function");
   }
});

test("searchFirecrawl returns descriptive error when FIRECRAWL_API_KEY is missing", async () => {
   const originalKey = process.env.FIRECRAWL_API_KEY;
   delete process.env.FIRECRAWL_API_KEY;

   try {
      const result = await firecrawl.searchFirecrawl({ query: "test query" });
      assert.equal(result.provider, "firecrawl");
      assert.equal(result.results.length, 0);
      assert.ok(result.error?.includes("FIRECRAWL_API_KEY"));
   } finally {
      if (originalKey) {
         process.env.FIRECRAWL_API_KEY = originalKey;
      }
   }
});

test("resolveProvider prioritizes answer-capable engines for mode='answer'", () => {
   const originalExa = process.env.EXA_API_KEY;
   const originalFirecrawl = process.env.FIRECRAWL_API_KEY;
   const originalDefault = process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER;

   try {
      process.env.EXA_API_KEY = "test-exa-key";
      process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
      process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER = "firecrawl";

      // mode="search" uses configured default (firecrawl)
      assert.equal(providers.resolveProvider("auto", "search"), "firecrawl");

      // mode="answer" routes to answer-capable engine (exa)
      assert.equal(providers.resolveProvider("auto", "answer"), "exa");
   } finally {
      if (originalExa) process.env.EXA_API_KEY = originalExa;
      else delete process.env.EXA_API_KEY;

      if (originalFirecrawl) process.env.FIRECRAWL_API_KEY = originalFirecrawl;
      else delete process.env.FIRECRAWL_API_KEY;

      if (originalDefault) process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER = originalDefault;
      else delete process.env.PI_WEB_SEARCH_DEFAULT_PROVIDER;
   }
});

test("searchExa answer mode uses /answer even when a category is provided", async () => {
   const originalExa = process.env.EXA_API_KEY;
   const originalFetch = globalThis.fetch;
   const requests = [];
   process.env.EXA_API_KEY = "test-exa-key";
   globalThis.fetch = async (url) => {
      requests.push(String(url));
      return {
         ok: true,
         status: 200,
         json: async () => ({
            answer: "Direct answer",
            citations: [],
            requestId: "answer-request"
         })
      };
   };

   try {
      const result = await exa.searchExa({
         query: "What is HTTP?",
         mode: "answer",
         category: "company"
      });

      assert.deepEqual(requests, ["https://api.exa.ai/answer"]);
      assert.equal(result.mode, "answer");
      assert.equal(result.answer, "Direct answer");
   } finally {
      globalThis.fetch = originalFetch;
      if (originalExa) process.env.EXA_API_KEY = originalExa;
      else delete process.env.EXA_API_KEY;
   }
});

test("searchExa answer mode falls back to /search only after a non-2xx answer response", async () => {
   const originalExa = process.env.EXA_API_KEY;
   const originalFetch = globalThis.fetch;
   const requests = [];
   let callCount = 0;
   process.env.EXA_API_KEY = "test-exa-key";
   globalThis.fetch = async (url) => {
      requests.push(String(url));
      callCount += 1;
      if (callCount === 1) {
         return { ok: false, status: 503 };
      }
      return {
         ok: true,
         status: 200,
         json: async () => ({
            requestId: "search-request",
            results: [{ title: "HTTP", url: "https://example.com", text: "HTTP result" }]
         })
      };
   };

   try {
      const result = await exa.searchExa({ query: "What is HTTP?", mode: "answer" });

      assert.deepEqual(requests, ["https://api.exa.ai/answer", "https://api.exa.ai/search"]);
      assert.equal(result.mode, "search");
      assert.equal(result.results.length, 1);
   } finally {
      globalThis.fetch = originalFetch;
      if (originalExa) process.env.EXA_API_KEY = originalExa;
      else delete process.env.EXA_API_KEY;
   }
});

test("executeSearch falls back sequentially to next available provider on error", async () => {
   const originalFirecrawl = process.env.FIRECRAWL_API_KEY;
   const originalTavily = process.env.TAVILY_API_KEY;
   const originalFetch = globalThis.fetch;
   const attemptedUrls = [];

   process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
   process.env.TAVILY_API_KEY = "test-tavily-key";

   globalThis.fetch = async (url) => {
      attemptedUrls.push(String(url));
      if (String(url).includes("firecrawl.dev") || String(url).includes("api.exa.ai")) {
         return { ok: false, status: 500, text: async () => "Internal server error" };
      }
      return {
         ok: true,
         status: 200,
         json: async () => ({
            results: [{ title: "Tavily Fallback", url: "https://fallback.com", content: "Fallback text" }]
         })
      };
   };

   try {
      const result = await providers.executeSearch({ query: "test fallback query", provider: "firecrawl" });
      assert.ok(attemptedUrls.length >= 2);
      assert.ok(attemptedUrls.some((u) => u.includes("firecrawl.dev")));
      assert.ok(attemptedUrls.some((u) => u.includes("tavily.com")));
      assert.equal(result.provider, "tavily");
      assert.equal(result.results.length, 1);
   } finally {
      globalThis.fetch = originalFetch;
      if (originalFirecrawl) process.env.FIRECRAWL_API_KEY = originalFirecrawl;
      else delete process.env.FIRECRAWL_API_KEY;
      if (originalTavily) process.env.TAVILY_API_KEY = originalTavily;
      else delete process.env.TAVILY_API_KEY;
   }
});
