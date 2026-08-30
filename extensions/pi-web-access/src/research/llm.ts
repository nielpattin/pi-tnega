import type { Api, Message, Model } from "@earendil-works/pi-ai/compat";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWebAccessConfig } from "../config.ts";
import type {
   ResearchActivity,
   ResearchDepth,
   ResearchOptions,
   ResearchResponse,
   ResearchSource,
   SearchItem
} from "../domain.ts";
import { fetchWebContent } from "../fetch/service.ts";
import { executeSearch } from "../providers/index.ts";
import { cleanSnippet } from "../utils/text.ts";

function findModelInRegistry(registry: ExtensionContext["modelRegistry"], spec: string): Model<Api> | undefined {
   if (!registry) return undefined;
   const trimmed = spec.trim();
   if (!trimmed) return undefined;

   const slashIndex = trimmed.indexOf("/");
   if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
      const provider = trimmed.slice(0, slashIndex);
      const id = trimmed.slice(slashIndex + 1);
      return registry.find(provider, id);
   }

   const available = registry.getAvailable();
   return available.find((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
}

interface AuthenticatedModelCandidate {
   model: Model<Api>;
   apiKey?: string;
   headers?: Record<string, string | null>;
}

async function resolveCandidateModels(ctx: ExtensionContext): Promise<AuthenticatedModelCandidate[]> {
   const config = getWebAccessConfig();
   const registry = ctx.modelRegistry;
   if (!registry) return [];

   const candidates: AuthenticatedModelCandidate[] = [];
   const seen = new Set<string>();

   const tryAddModel = async (model: Model<Api> | undefined) => {
      if (!model) return;
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) return;
      seen.add(key);

      try {
         const auth = await registry.getApiKeyAndHeaders(model);
         if (auth.ok) {
            candidates.push({ model, apiKey: auth.apiKey, headers: auth.headers });
         }
      } catch {}
   };

   // 1. Configured researchModel in pi-web-access.json
   if (config.researchModel) {
      await tryAddModel(findModelInRegistry(registry, config.researchModel));
   }

   // 2. Active session model
   if (ctx.model) {
      await tryAddModel(ctx.model);
   }

   // 3. Configured researchModelFallbacks in pi-web-access.json
   if (config.researchModelFallbacks && config.researchModelFallbacks.length > 0) {
      for (const fallbackSpec of config.researchModelFallbacks) {
         await tryAddModel(findModelInRegistry(registry, fallbackSpec));
      }
   }

   // 4. Auto-discover all available and authenticated models in Pi
   const allAvailable = registry.getAvailable();
   for (const model of allAvailable) {
      await tryAddModel(model);
   }

   return candidates;
}

async function decomposeQueryWithLLM(
   query: string,
   depth: ResearchDepth = "deep",
   ctx?: ExtensionContext,
   signal?: AbortSignal
): Promise<string[]> {
   const clean = query.trim();
   if (!clean) return [];

   if (!ctx?.modelRegistry) {
      return [clean];
   }

   const targetCount = depth === "exhaustive" ? "3-4" : depth === "fast" ? "2" : "2-3";
   const candidates = await resolveCandidateModels(ctx);

   if (candidates.length === 0) {
      return [clean];
   }

   const prompt = [
      "You are an expert search query planner for technical web research.",
      `Decompose the research topic into ${targetCount} concise, high-precision web search queries.`,
      "Guidelines:",
      "- At least one query MUST explicitly target official documentation, primary source repositories, or specifications (e.g. 'Bun official docs runtime compatibility').",
      "- Other queries should target empirical benchmarks, architecture, or limitations.",
      "- Strip conversational fluff, instructions, and punctuation. Return clean search terms.",
      "- Return ONLY the queries, one per line. Do not number or bullet them.",
      "",
      `Research Topic: ${clean}`
   ].join("\n");

   const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now()
   };

   for (const { model, apiKey, headers } of candidates) {
      try {
         const response = await complete(
            model,
            { messages: [userMessage] },
            {
               apiKey,
               headers,
               signal
            }
         );

         if (response.stopReason === "aborted") {
            throw new Error("Query decomposition aborted");
         }

         const textParts = (response.content ?? [])
            .filter((p: unknown) => typeof (p as { text?: string }).text === "string")
            .map((p: unknown) => (p as { text: string }).text.trim())
            .filter((t) => t.length > 0);

         const rawResponse = textParts.join("\n").trim();
         const lines = rawResponse
            .split(/\r?\n/)
            .map((line) => line.replace(/^[\d\s.\-*•]+/, "").trim())
            .filter((line) => line.length > 0);

         if (lines.length >= 2) {
            return lines;
         }
      } catch (err) {
         if (signal?.aborted) throw err;
         // Try next candidate model
      }
   }

   return [clean];
}

function buildPromptForLLM(
   mainQuery: string,
   systemPrompt: string | undefined,
   depth: ResearchDepth = "deep",
   queryResults: Array<{ query: string; items: SearchItem[]; answer?: string }>,
   sources: ResearchSource[],
   fetchedContents: Map<string, string>
): string {
   const depthInstructions =
      depth === "fast"
         ? "Write a concise research briefing highlighting the most essential facts and direct answers."
         : depth === "exhaustive"
           ? "Write an exhaustive, in-depth comparative investigation analyzing empirical data, methodology, limitations, and cross-source consensus."
           : "Write a comprehensive, objective, and well-structured deep research synthesis with clear sections and evidence comparison.";

   const lines: string[] = [
      "You are an expert research assistant synthesizing live multi-source web intelligence.",
      depthInstructions,
      "",
      "Requirements:",
      "1. Provide clear sectional breakdowns, key metrics, and factual evidence.",
      "2. Explicitly distinguish directly reported data vs estimates or claims.",
      "3. Cross-reference findings across sources and note any conflicting evidence or limitations.",
      "4. Cite sources inline using bracketed indices like [1], [2] matching the numbered sources list.",
      "5. Base your synthesis on the actual extracted page content provided below."
   ];

   if (systemPrompt) {
      lines.push(`\nAdditional Guidance: ${systemPrompt}`);
   }

   lines.push(`\nTarget Topic / Question: ${mainQuery}\n`);
   lines.push("<search_evidence>");

   for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!;
      const citationTag = `[${i + 1}]`;
      const fullContent = fetchedContents.get(src.url);

      lines.push(`\n--- Source ${citationTag}: ${src.title} (${src.url}) ---`);
      if (fullContent) {
         lines.push("Extracted Page Content:");
         lines.push(fullContent.slice(0, 4500));
      } else if (src.snippet) {
         lines.push(`Search Snippet: ${src.snippet}`);
      }
   }

   lines.push("\n</search_evidence>\n");
   lines.push(
      "Provide the final research report in clean Markdown format with a summary, key findings, and detailed analysis."
   );

   return lines.join("\n");
}

function buildDeterministicSynthesis(
   mainQuery: string,
   queryResults: Array<{ query: string; items: SearchItem[]; answer?: string }>,
   sources: ResearchSource[],
   fetchedContents: Map<string, string>
): string {
   const parts: string[] = [];

   parts.push(`## Research Synthesis: ${mainQuery}\n`);

   const answers = queryResults.filter((r) => r.answer && r.answer.trim().length > 0);
   if (answers.length > 0) {
      parts.push("### Key Highlights\n");
      for (const ans of answers) {
         parts.push(`- **${ans.query}**: ${ans.answer?.trim()}`);
      }
      parts.push("");
   }

   parts.push("### Multi-Angle Findings\n");
   for (let i = 0; i < queryResults.length; i++) {
      const section = queryResults[i];
      if (!section) continue;
      parts.push(`#### Angle ${i + 1}: ${section.query}\n`);

      if (section.items.length === 0) {
         parts.push("*No direct results found for this angle.*\n");
         continue;
      }

      for (const item of section.items.slice(0, 4)) {
         const cleanTitle = cleanSnippet(item.title || item.url);
         const pageContent = fetchedContents.get(item.url);
         const snippetText = pageContent
            ? cleanSnippet(pageContent.slice(0, 300))
            : item.snippet
              ? cleanSnippet(item.snippet)
              : "";

         if (snippetText) {
            parts.push(`- **${cleanTitle}**: ${snippetText}`);
         } else {
            parts.push(`- **${cleanTitle}** (${item.url})`);
         }
      }
      parts.push("");
   }

   parts.push("### Summary Assessment\n");
   parts.push(
      `Synthesized findings across ${sources.length} sources and ${queryResults.length} query perspectives for "${mainQuery}".`
   );

   return parts.join("\n");
}

async function invokeLLMSynthesis(
   mainQuery: string,
   systemPrompt: string | undefined,
   depth: ResearchDepth = "deep",
   queryResults: Array<{ query: string; items: SearchItem[]; answer?: string }>,
   sources: ResearchSource[],
   fetchedContents: Map<string, string>,
   ctx?: ExtensionContext,
   signal?: AbortSignal
): Promise<{ text: string; modelName: string } | null> {
   if (!ctx?.modelRegistry) {
      return null;
   }

   const candidateModels = await resolveCandidateModels(ctx);
   if (candidateModels.length === 0) {
      return null;
   }

   const prompt = buildPromptForLLM(mainQuery, systemPrompt, depth, queryResults, sources, fetchedContents);
   const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now()
   };

   for (const { model, apiKey, headers } of candidateModels) {
      try {
         const response = await complete(
            model,
            { messages: [userMessage] },
            {
               apiKey,
               headers,
               signal
            }
         );

         if (response.stopReason === "aborted") {
            throw new Error("Research LLM synthesis aborted");
         }

         const textParts = (response.content ?? [])
            .filter((p: unknown) => typeof (p as { text?: string }).text === "string")
            .map((p: unknown) => (p as { text: string }).text.trim())
            .filter((t) => t.length > 0);

         const synthesisText = textParts.join("\n\n").trim();
         if (synthesisText.length > 0) {
            return {
               text: synthesisText,
               modelName: `${model.provider}/${model.id}`
            };
         }
      } catch (err) {
         if (signal?.aborted) throw err;
         // Try next available candidate model
      }
   }

   return null;
}

export async function researchLLM(
   options: ResearchOptions,
   ctx?: ExtensionContext,
   onProgress?: (partial: Partial<ResearchResponse>) => void
): Promise<ResearchResponse> {
   const startTime = Date.now();
   const depth = options.depth ?? "deep";

   const activities: ResearchActivity[] = [];
   const seenUrls = new Set<string>();
   const sources: ResearchSource[] = [];
   const queryResults: Array<{ query: string; items: SearchItem[]; answer?: string }> = [];

   const emitUpdate = (type?: string, message?: string) => {
      if (message) {
         activities.push({ type: type || "progress", message, timestamp: new Date().toISOString() });
      }
      onProgress?.({
         query: options.query || "Web Research",
         provider: "llm",
         synthesis: "",
         sources: [...sources],
         activities: [...activities],
         durationMs: Date.now() - startTime
      });
   };

   // Heartbeat timer (150ms) to ensure smooth live ticking elapsed timer and spinner animation in the TUI
   const heartbeat = onProgress ? setInterval(() => emitUpdate(), 150) : undefined;

   try {
      let queryList: string[] = [];
      if (options.queries && options.queries.length > 0) {
         queryList = [...options.queries];
         emitUpdate("decompose", `Using ${queryList.length} user-specified query angles`);
      } else if (options.query) {
         if (depth !== "fast") {
            emitUpdate("decompose", "Planning search angles with registered model...");
         }
         queryList = await decomposeQueryWithLLM(options.query, depth, ctx, options.signal);
         if (queryList.length > 1) {
            emitUpdate("decompose", `Planned ${queryList.length} search angles`);
         }
      }

      const mainQuery = options.query || (queryList.length > 0 ? queryList[0]! : "Web Research");

      if (queryList.length === 0) {
         return {
            query: mainQuery,
            provider: "llm",
            synthesis: "",
            sources: [],
            error: "No query or queries provided for research"
         };
      }

      emitUpdate("search", `Searching web across ${queryList.length} angles in parallel...`);

      const limitPerQuery = depth === "exhaustive" ? 8 : depth === "fast" ? 3 : 5;

      const config = getWebAccessConfig();
      const searchProvider = config.research.searchProvider ?? "auto";

      // 1. Execute searches in parallel across all query angles
      const searchPromises = queryList.map(async (queryAngle) => {
         if (options.signal?.aborted) {
            throw new Error("Research operation aborted");
         }

         const response = await executeSearch({
            query: queryAngle,
            provider: searchProvider,
            mode: "search",
            includeDomains: options.includeDomains,
            excludeDomains: options.excludeDomains,
            userLocation: options.userLocation,
            systemPrompt: options.systemPrompt,
            limit: limitPerQuery,
            signal: options.signal
         });

         return {
            query: queryAngle,
            response
         };
      });

      const settled = await Promise.allSettled(searchPromises);

      let searchEnginesUsed: string[] = [];

      for (const res of settled) {
         if (res.status === "rejected") {
            emitUpdate("error", `Search failed: ${String(res.reason)}`);
            continue;
         }

         const { query: queryAngle, response } = res.value;

         if (response.provider && !searchEnginesUsed.includes(response.provider)) {
            searchEnginesUsed.push(response.provider);
         }

         emitUpdate(
            "search",
            `Found ${response.results.length} results via ${response.provider} for "${queryAngle.length > 40 ? queryAngle.slice(0, 37) + "..." : queryAngle}"`
         );

         const validItems: SearchItem[] = [];
         for (const item of response.results) {
            if (!item.url) continue;
            validItems.push(item);

            if (!seenUrls.has(item.url)) {
               seenUrls.add(item.url);
               sources.push({
                  title: cleanSnippet(item.title || item.url),
                  url: item.url,
                  snippet: item.snippet ? cleanSnippet(item.snippet) : undefined
               });
            }
         }

         queryResults.push({
            query: queryAngle,
            items: validItems,
            answer: response.answer
         });
      }

      if (sources.length === 0) {
         return {
            query: mainQuery,
            provider: "llm",
            synthesis: "",
            sources: [],
            activities,
            durationMs: Date.now() - startTime,
            error: "No research results found across all search angles"
         };
      }

      // 2. Fetch full readable content from top sources in parallel
      const maxSourcesToFetch = depth === "exhaustive" ? 8 : depth === "fast" ? 3 : 5;
      const topSources = sources.slice(0, maxSourcesToFetch);
      const fetchedContents = new Map<string, string>();

      emitUpdate("fetch", `Fetching full Markdown from ${topSources.length} top source pages...`);

      const fetchProvider = config.research.fetchProvider ?? config.fetch.provider ?? "auto";
      const fetchPromises = topSources.map(async (src) => {
         if (options.signal?.aborted) return;
         try {
            const fetchRes = await fetchWebContent({
               url: src.url,
               provider: fetchProvider,
               maxBytes: depth === "exhaustive" ? 12_000 : depth === "fast" ? 4_000 : 8_000,
               timeoutMs: 15_000,
               signal: options.signal
            });
            if (fetchRes.content && !fetchRes.error) {
               fetchedContents.set(src.url, fetchRes.content);
            }
         } catch {}
      });

      await Promise.allSettled(fetchPromises);

      if (fetchedContents.size > 0) {
         emitUpdate("fetch", `Extracted readable Markdown from ${fetchedContents.size} source pages`);
      }

      // 3. Perform actual LLM synthesis via Pi's model registry using full page evidence
      emitUpdate("synthesis", "Synthesizing research evidence via registered model...");

      let synthesis: string;
      let providerLabel = "llm";

      const llmResult = await invokeLLMSynthesis(
         mainQuery,
         options.systemPrompt,
         depth,
         queryResults,
         sources,
         fetchedContents,
         ctx,
         options.signal
      );

      if (llmResult) {
         synthesis = llmResult.text;
         providerLabel = `llm (${llmResult.modelName})`;
         activities.push({
            type: "synthesis",
            message: `Synthesized research findings using model ${llmResult.modelName}`
         });
      } else {
         synthesis = buildDeterministicSynthesis(mainQuery, queryResults, sources, fetchedContents);
         providerLabel = searchEnginesUsed.length > 0 ? `llm (${searchEnginesUsed.join(", ")})` : "llm";
      }

      return {
         query: mainQuery,
         provider: providerLabel,
         synthesis,
         sources,
         activities,
         durationMs: Date.now() - startTime
      };
   } finally {
      if (heartbeat) {
         clearInterval(heartbeat);
      }
   }
}
