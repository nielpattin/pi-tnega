import type { Message } from "@earendil-works/pi-ai/compat";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
   ResearchActivity,
   ResearchDepth,
   ResearchOptions,
   ResearchPaperResult,
   ResearchPassage,
   ResearchResponse,
   ResearchSource
} from "../domain.ts";
import {
   findRelatedPapers,
   getPaperOrPassages,
   resolvePaperUrl,
   searchResearchPapers
} from "../providers/firecrawl-research.ts";
import { resolveCandidateModels, type AuthenticatedModelCandidate } from "./llm.ts";
import type { ResearchProgressCallback } from "./service.ts";

interface PaperCandidate {
   readonly paper: ResearchPaperResult;
   readonly sourceKind: "search" | "citation-expansion";
   passages?: ResearchPassage[];
}

function deduplicatePapers(papers: PaperCandidate[]): PaperCandidate[] {
   const seen = new Set<string>();
   const result: PaperCandidate[] = [];

   for (const item of papers) {
      const key = item.paper.primaryId || item.paper.paperId;
      if (key && !seen.has(key)) {
         seen.add(key);
         result.push(item);
      }
   }

   return result;
}

function buildAcademicDeterministicSynthesis(
   mainQuery: string,
   candidates: PaperCandidate[],
   sources: ResearchSource[]
): string {
   const lines: string[] = [];
   lines.push(`## Academic Literature Review: ${mainQuery}\n`);

   if (candidates.length === 0) {
      lines.push("No academic papers matching the query criteria were discovered in the research index.");
      return lines.join("\n");
   }

   lines.push("### Primary Literature & Abstract Summaries\n");
   for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!;
      const tag = `[${i + 1}]`;
      const authorText = src.authors ? ` *by ${src.authors}*` : "";
      lines.push(`#### ${tag} ${src.title}${authorText}`);
      if (src.primaryId) {
         lines.push(`- **Identifier**: \`${src.primaryId}\` · [Direct Link](${src.url})`);
      }
      if (src.snippet) {
         lines.push(`\n**Abstract:**\n> ${src.snippet}\n`);
      }
      if (src.passages && src.passages.length > 0) {
         lines.push("**Key Passages & Evidence:**");
         for (const passage of src.passages) {
            lines.push(`> ${passage}`);
         }
         lines.push("");
      }
   }

   return lines.join("\n");
}

function buildAcademicPromptForLLM(
   mainQuery: string,
   systemPrompt: string | undefined,
   depth: ResearchDepth = "deep",
   sources: ResearchSource[],
   candidates: PaperCandidate[]
): string {
   const depthInstructions =
      depth === "fast"
         ? "Write a concise academic briefing summarizing the primary methodologies and empirical findings."
         : depth === "exhaustive"
           ? "Write an exhaustive, publication-grade literature review analyzing theoretical foundations, architectural mechanisms, empirical benchmarks, and open research questions across the citation lineage."
           : "Write a comprehensive and structured scientific literature review comparing methodologies, empirical results, and theoretical contributions.";

   const lines: string[] = [
      "You are a scientific research assistant specializing in academic literature review and synthesis.",
      depthInstructions,
      "",
      "Review Guidelines:",
      "1. Structure your review into clear Markdown sections:",
      "   - ## Overview & Problem Formulation",
      "   - ## Key Methodologies & Architectural Innovations",
      "   - ## Empirical Benchmarks & Comparative Findings",
      "   - ## Lineage, Citations & Future Research Directions",
      "2. Explicitly cite candidate papers using bracketed references like [1], [2] matching the numbered sources below.",
      "3. Use the extracted full-text passages and paper abstracts to provide concrete mathematical details, dataset benchmarks, and qualitative trade-offs.",
      "4. Highlight connections and lineages between foundational precursor papers and recent advancements."
   ];

   if (systemPrompt) {
      lines.push(`\nAdditional Steering Guidance: ${systemPrompt}`);
   }

   lines.push(`\nResearch Target: ${mainQuery}\n`);
   lines.push("<literature_evidence>");

   for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!;
      const tag = `[${i + 1}]`;
      const cand = candidates.find(
         (c) => (c.paper.primaryId || c.paper.paperId) === src.primaryId || c.paper.paperId === src.paperId
      );
      const authors = src.authors || cand?.paper.authors || "Unknown Authors";
      const categories = cand?.paper.categories ? ` [${cand.paper.categories.join(", ")}]` : "";

      lines.push(`\n--- Paper ${tag}: ${src.title} ---`);
      lines.push(`Authors: ${authors}${categories}`);
      lines.push(`Identifier: ${src.primaryId || src.paperId || "N/A"} (${src.url})`);
      if (src.snippet) {
         lines.push(`Abstract: ${src.snippet}`);
      }
      if (src.passages && src.passages.length > 0) {
         lines.push("Extracted Full-Text Passages:");
         for (const p of src.passages) {
            lines.push(`> ${p}`);
         }
      }
   }

   lines.push("\n</literature_evidence>\n");
   lines.push(
      "Synthesize the academic findings now in clean Markdown format with rigorous citations [1], [2] throughout."
   );

   return lines.join("\n");
}

async function invokeAcademicLLMSynthesis(
   mainQuery: string,
   systemPrompt: string | undefined,
   depth: ResearchDepth = "deep",
   sources: ResearchSource[],
   candidates: PaperCandidate[],
   candidateModels: AuthenticatedModelCandidate[],
   signal?: AbortSignal
): Promise<{ text: string; modelName: string } | null> {
   if (candidateModels.length === 0) {
      return null;
   }

   const prompt = buildAcademicPromptForLLM(mainQuery, systemPrompt, depth, sources, candidates);
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
            throw new Error("Academic research synthesis aborted");
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
         // Try next candidate model
      }
   }

   return null;
}

/**
 * Executes scientific literature research via Firecrawl Research Index and LLM synthesis.
 */
export async function researchAcademic(
   options: ResearchOptions,
   ctx?: ExtensionContext,
   onProgress?: ResearchProgressCallback
): Promise<ResearchResponse> {
   const startTime = Date.now();
   const mainQuery = options.query?.trim() || options.queries?.[0]?.trim() || "";
   const depth = options.depth ?? "deep";
   const activities: ResearchActivity[] = [];
   let candidates: PaperCandidate[] = [];

   const buildSourceList = (items: PaperCandidate[]): ResearchSource[] => {
      return items.map((cand) => {
         const p = cand.paper;
         const primaryId = p.primaryId || (p.ids?.arxiv?.[0] ? `arxiv:${p.ids.arxiv[0]}` : undefined);
         const url = resolvePaperUrl(primaryId || p.paperId);

         return {
            title: p.title,
            url,
            snippet: p.abstract,
            paperId: p.paperId,
            primaryId: p.primaryId,
            authors: p.authors,
            score: p.score,
            passages: cand.passages?.map((psg) => psg.text)
         };
      });
   };

   const emitUpdate = (type?: string, message?: string) => {
      if (message) {
         activities.push({
            type: type || "progress",
            message,
            timestamp: new Date().toISOString()
         });
      }
      if (onProgress) {
         onProgress({
            query: mainQuery,
            provider: "firecrawl (academic)",
            synthesis: "",
            sources: buildSourceList(candidates),
            activities: [...activities],
            durationMs: Date.now() - startTime
         });
      }
   };

   // Heartbeat timer (150ms) to ensure smooth live ticking elapsed timer and spinner animation in the TUI
   const heartbeat = onProgress ? setInterval(() => emitUpdate(), 150) : undefined;

   try {
      if (!mainQuery) {
         return {
            query: "",
            provider: "firecrawl (academic)",
            synthesis: "No search query provided for academic research.",
            sources: [],
            activities,
            durationMs: 0
         };
      }

      // 1. Determine search queries
      const searchQueries: string[] = [];
      if (options.queries && options.queries.length > 0) {
         searchQueries.push(...options.queries.map((q) => q.trim()).filter(Boolean));
      } else {
         searchQueries.push(mainQuery);
      }

      emitUpdate("plan", `Searching academic paper index across ${searchQueries.length} query angles...`);

      // 2. Discover seed papers
      const searchK = depth === "exhaustive" ? 20 : depth === "fast" ? 5 : 10;

      for (const query of searchQueries) {
         if (options.signal?.aborted) break;

         const searchRes = await searchResearchPapers({
            query,
            authors: options.authors,
            categories: options.categories,
            k: searchK,
            signal: options.signal
         });

         if (!searchRes.success && searchRes.error) {
            emitUpdate("warning", `Paper search warning: ${searchRes.error}`);
            if (candidates.length === 0 && searchQueries.length === 1) {
               return {
                  query: mainQuery,
                  provider: "firecrawl (academic)",
                  synthesis: `Academic research failed: ${searchRes.error}`,
                  sources: [],
                  activities,
                  durationMs: Date.now() - startTime,
                  error: searchRes.error
               };
            }
         }

         for (const p of searchRes.results) {
            candidates.push({
               paper: p,
               sourceKind: "search"
            });
         }

         candidates = deduplicatePapers(candidates);
         const displayQ = query.length > 40 ? `${query.slice(0, 37)}...` : query;
         emitUpdate("search", `Found ${searchRes.results.length} papers for "${displayQ}"`);
      }

      let uniqueCandidates = deduplicatePapers(candidates);

      // 3. Citation graph expansion (for deep or exhaustive research)
      if (depth !== "fast" && uniqueCandidates.length > 0 && !options.signal?.aborted) {
         const topSeeds = uniqueCandidates.slice(0, depth === "exhaustive" ? 3 : 2);
         emitUpdate("expand", `Expanding citation graph for top ${topSeeds.length} seed papers...`);

         for (const seed of topSeeds) {
            const seedId = seed.paper.primaryId || seed.paper.paperId;
            if (!seedId) continue;

            const relatedRes = await findRelatedPapers(seedId, {
               intent: mainQuery,
               mode: "similar",
               k: depth === "exhaustive" ? 15 : 8,
               signal: options.signal
            });

            if (relatedRes.success && relatedRes.results.length > 0) {
               for (const rel of relatedRes.results) {
                  candidates.push({
                     paper: rel,
                     sourceKind: "citation-expansion"
                  });
               }
               candidates = deduplicatePapers(candidates);
               emitUpdate(
                  "expand",
                  `Discovered ${relatedRes.results.length} related papers for ${seed.paper.primaryId || seed.paper.title.slice(0, 30)}`
               );
            }

            if (depth === "exhaustive") {
               const citersRes = await findRelatedPapers(seedId, {
                  intent: mainQuery,
                  mode: "citers",
                  k: 5,
                  signal: options.signal
               });
               if (citersRes.success && citersRes.results.length > 0) {
                  for (const rel of citersRes.results) {
                     candidates.push({
                        paper: rel,
                        sourceKind: "citation-expansion"
                     });
                  }
                  candidates = deduplicatePapers(candidates);
                  emitUpdate("expand", `Discovered ${citersRes.results.length} citing papers`);
               }
            }
         }

         uniqueCandidates = deduplicatePapers(candidates);
      }

      // 4. Passage extraction for top candidates
      const targetPassageCount = depth === "exhaustive" ? 6 : depth === "fast" ? 2 : 4;
      const passageCandidates = uniqueCandidates.slice(0, targetPassageCount);

      if (passageCandidates.length > 0 && !options.signal?.aborted) {
         emitUpdate("passages", `Reading relevant full-text passages across ${passageCandidates.length} papers...`);

         for (const item of passageCandidates) {
            const paperId = item.paper.primaryId || item.paper.paperId;
            if (!paperId) continue;

            const passagesRes = await getPaperOrPassages(paperId, {
               query: mainQuery,
               k: 3,
               signal: options.signal
            });

            if (passagesRes.success && passagesRes.passages && passagesRes.passages.length > 0) {
               item.passages = [...passagesRes.passages];
               emitUpdate(
                  "passages",
                  `Extracted ${passagesRes.passages.length} passages from ${item.paper.primaryId || item.paper.title.slice(0, 30)}`
               );
            }
         }
      }

      // 5. Construct sources
      const maxSources = depth === "exhaustive" ? 12 : depth === "fast" ? 4 : 8;
      const finalCandidates = uniqueCandidates.slice(0, maxSources);
      const sources: ResearchSource[] = buildSourceList(finalCandidates);

      // 6. Synthesize findings
      emitUpdate("synthesize", `Synthesizing literature review across ${sources.length} papers...`);

      const candidateModels = ctx ? await resolveCandidateModels(ctx) : [];
      let synthesisText: string | null = null;
      let providerLabel = "firecrawl (academic)";

      if (candidateModels.length > 0 && !options.signal?.aborted) {
         const synthRes = await invokeAcademicLLMSynthesis(
            mainQuery,
            options.systemPrompt,
            depth,
            sources,
            finalCandidates,
            candidateModels,
            options.signal
         );

         if (synthRes) {
            synthesisText = synthRes.text;
            providerLabel = `firecrawl-academic (${synthRes.modelName})`;
         }
      }

      if (!synthesisText) {
         synthesisText = buildAcademicDeterministicSynthesis(mainQuery, finalCandidates, sources);
      }

      const response: ResearchResponse = {
         query: mainQuery,
         provider: providerLabel,
         synthesis: synthesisText,
         sources,
         activities,
         durationMs: Date.now() - startTime
      };

      if (onProgress) {
         onProgress(response);
      }

      return response;
   } finally {
      if (heartbeat) {
         clearInterval(heartbeat);
      }
   }
}
