import { getWebAccessConfig } from "../config.ts";
import type { ResearchActivity, ResearchOptions, ResearchResponse, ResearchSource } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";
import { cleanSnippet } from "../utils/text.ts";

interface ExaAgentRunCitation {
   title?: string;
   url?: string;
}

interface ExaAgentRunGroundingItem {
   field?: string;
   citations?: ExaAgentRunCitation[];
   confidence?: string;
}

interface ExaAgentRunResponse {
   id?: string;
   status?: "queued" | "running" | "completed" | "failed" | "cancelled";
   stopReason?: string | null;
   output?: {
      text?: string;
      structured?: unknown;
      grounding?: ExaAgentRunGroundingItem[];
   };
   usage?: {
      agentComputeUnits?: number;
      searches?: number;
   };
   costDollars?: {
      total?: number;
   };
   error?: {
      code?: string;
      message?: string;
   };
}

function mapDepthToEffort(depth: "fast" | "deep" | "exhaustive" | undefined): string {
   switch (depth) {
      case "fast":
         return "low";
      case "exhaustive":
         return "high";
      case "deep":
      default:
         return "medium";
   }
}

export async function researchExa(options: ResearchOptions): Promise<ResearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.exaApiKey;
   const query = (options.query || (options.queries && options.queries[0]) || "").trim();

   if (!apiKey) {
      return {
         query,
         provider: "exa",
         synthesis: "",
         sources: [],
         error: "EXA_API_KEY is not configured"
      };
   }

   const effort = mapDepthToEffort(options.depth);
   const timeoutMs = options.timeoutMs ?? (options.depth === "exhaustive" ? 180_000 : 90_000);

   let queryWithInstructions = query;
   if (options.systemPrompt) {
      queryWithInstructions = `[Instructions: ${options.systemPrompt}]\n\n${query}`;
   }
   if (options.includeDomains && options.includeDomains.length > 0) {
      queryWithInstructions += `\n[Focus on domains: ${options.includeDomains.join(", ")}]`;
   }
   if (options.excludeDomains && options.excludeDomains.length > 0) {
      queryWithInstructions += `\n[Exclude domains: ${options.excludeDomains.join(", ")}]`;
   }

   try {
      // Step 1: Start Agent Run
      const startRes = await fetchWithTimeout("https://api.exa.ai/agent/runs", {
         method: "POST",
         headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            query: queryWithInstructions,
            effort
         }),
         signal: options.signal
      });

      if (!startRes.ok) {
         const errText = await startRes.text();
         return {
            query,
            provider: "exa",
            synthesis: "",
            sources: [],
            error: `Exa Agent API start error (${startRes.status}): ${errText}`
         };
      }

      const startData = (await startRes.json()) as ExaAgentRunResponse;
      const runId = startData.id;

      if (!runId) {
         return {
            query,
            provider: "exa",
            synthesis: "",
            sources: [],
            error: "Exa Agent API did not return a run ID"
         };
      }

      // Step 2: Poll Agent Run
      const pollUrl = `https://api.exa.ai/agent/runs/${runId}`;
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
         if (options.signal?.aborted) {
            throw new Error("Research operation aborted");
         }

         await new Promise((resolve) => setTimeout(resolve, 2000));

         const pollRes = await fetchWithTimeout(pollUrl, {
            headers: {
               "x-api-key": apiKey
            },
            signal: options.signal
         });

         if (!pollRes.ok) {
            const errText = await pollRes.text();
            return {
               query,
               provider: "exa",
               synthesis: "",
               sources: [],
               error: `Exa Agent status error (${pollRes.status}): ${errText}`
            };
         }

         const run = (await pollRes.json()) as ExaAgentRunResponse;

         if (run.status === "completed") {
            const text = run.output?.text || "No synthesis returned by Exa Agent.";
            const seenUrls = new Set<string>();
            const sources: ResearchSource[] = [];

            for (const item of run.output?.grounding ?? []) {
               for (const citation of item.citations ?? []) {
                  if (citation.url && !seenUrls.has(citation.url)) {
                     seenUrls.add(citation.url);
                     sources.push({
                        title: cleanSnippet(citation.title || citation.url),
                        url: citation.url
                     });
                  }
               }
            }

            const activities: ResearchActivity[] = [];
            if (run.usage?.searches) {
               activities.push({
                  type: "search",
                  message: `Executed ${run.usage.searches} search tool calls`
               });
            }
            if (run.usage?.agentComputeUnits) {
               activities.push({
                  type: "compute",
                  message: `Consumed ${run.usage.agentComputeUnits} ACU`
               });
            }

            return {
               query,
               provider: "exa",
               synthesis: text,
               sources,
               activities
            };
         }

         if (run.status === "failed" || run.status === "cancelled") {
            return {
               query,
               provider: "exa",
               synthesis: "",
               sources: [],
               error: run.error?.message || `Exa Agent run ${run.status} (reason: ${run.stopReason || "unknown"})`
            };
         }
      }

      return {
         query,
         provider: "exa",
         synthesis: "",
         sources: [],
         error: `Exa Agent run timed out after ${Math.round(timeoutMs / 1000)}s`
      };
   } catch (error) {
      return {
         query,
         provider: "exa",
         synthesis: "",
         sources: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
