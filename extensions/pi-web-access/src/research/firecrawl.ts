import { getWebAccessConfig } from "../config.ts";
import type { ResearchActivity, ResearchOptions, ResearchResponse, ResearchSource } from "../domain.ts";
import { fetchWithTimeout } from "../fetch/client.ts";

interface FirecrawlAgentStartResponse {
   success?: boolean;
   id?: string;
   error?: string;
}

interface FirecrawlAgentStatusResponse {
   status?: "processing" | "completed" | "failed";
   creditsUsed?: number;
   id?: string;
   data?: {
      markdown?: string;
      finalAnalysis?: string;
      sources?: Array<{
         title?: string;
         description?: string;
         url?: string;
      }>;
      activities?: Array<{
         type?: string;
         status?: string;
         message?: string;
         timestamp?: string;
         depth?: number;
      }>;
   };
   activities?: Array<{
      type?: string;
      status?: string;
      message?: string;
      timestamp?: string;
      depth?: number;
   }>;
   sources?: Array<{
      title?: string;
      description?: string;
      url?: string;
   }>;
   finalAnalysis?: string;
   error?: string;
}

function mapDepthToEffort(depth: "fast" | "deep" | "exhaustive" | undefined): "low" | "medium" | "high" {
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

export async function researchFirecrawl(options: ResearchOptions): Promise<ResearchResponse> {
   const config = getWebAccessConfig();
   const apiKey = config.firecrawlApiKey;
   let query = options.query.trim();

   if (!apiKey) {
      return {
         query,
         provider: "firecrawl",
         synthesis: "",
         sources: [],
         error: "FIRECRAWL_API_KEY is not configured"
      };
   }

   if (options.includeDomains && options.includeDomains.length > 0) {
      const siteClauses = options.includeDomains.map((d) => `site:${d}`).join(" OR ");
      query = `${query} (${siteClauses})`;
   }
   if (options.excludeDomains && options.excludeDomains.length > 0) {
      const excludeClauses = options.excludeDomains.map((d) => `-site:${d}`).join(" ");
      query = `${query} ${excludeClauses}`;
   }

   const agentUrl = "https://api.firecrawl.dev/v2/agent";
   const effort = mapDepthToEffort(options.depth);

   const urls =
      options.includeDomains && options.includeDomains.length > 0
         ? options.includeDomains.map((d) => (d.startsWith("http") ? d : `https://${d}`))
         : undefined;

   try {
      const startRes = await fetchWithTimeout(agentUrl, {
         method: "POST",
         headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
         },
         body: JSON.stringify({
            prompt: options.systemPrompt ? `${options.systemPrompt}\n\nTask: ${query}` : query,
            model: "spark-2",
            effort,
            urls,
            strictConstrainToURLs: Boolean(urls && urls.length > 0)
         }),
         signal: options.signal
      });

      if (!startRes.ok) {
         const errText = await startRes.text();
         return {
            query,
            provider: "firecrawl",
            synthesis: "",
            sources: [],
            error: `Firecrawl agent start error (${startRes.status}): ${errText}`
         };
      }

      const startData = (await startRes.json()) as FirecrawlAgentStartResponse;
      const jobId = startData.id;

      if (!jobId) {
         return {
            query,
            provider: "firecrawl",
            synthesis: "",
            sources: [],
            error: "Firecrawl did not return a job ID for research task"
         };
      }

      // Poll until completion or timeout
      const pollUrl = `https://api.firecrawl.dev/v2/agent/${jobId}`;
      const timeoutMs = options.timeoutMs ?? (options.depth === "exhaustive" ? 300_000 : 120_000);
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
         if (options.signal?.aborted) {
            throw new Error("Research operation aborted");
         }

         await new Promise((resolve) => setTimeout(resolve, 2000));

         const statusRes = await fetchWithTimeout(pollUrl, {
            headers: {
               Authorization: `Bearer ${apiKey}`
            },
            signal: options.signal
         });

         if (!statusRes.ok) {
            const errText = await statusRes.text();
            return {
               query,
               provider: "firecrawl",
               synthesis: "",
               sources: [],
               error: `Firecrawl research status error (${statusRes.status}): ${errText}`
            };
         }

         const statusData = (await statusRes.json()) as FirecrawlAgentStatusResponse;

         if (statusData.status === "completed") {
            const rawSources = statusData.data?.sources ?? statusData.sources ?? [];
            const rawActivities = statusData.data?.activities ?? statusData.activities ?? [];
            const finalAnalysis =
               statusData.data?.markdown ?? statusData.data?.finalAnalysis ?? statusData.finalAnalysis ?? "";

            const sources: ResearchSource[] = rawSources.map((s) => ({
               title: s.title || "Untitled",
               url: s.url || "",
               snippet: s.description
            }));

            const activities: ResearchActivity[] = rawActivities.map((a) => ({
               type: a.type || "activity",
               message: a.message || "",
               timestamp: a.timestamp,
               depth: a.depth
            }));

            const cost =
               statusData.creditsUsed !== undefined
                  ? `${statusData.creditsUsed} credit${statusData.creditsUsed === 1 ? "" : "s"}`
                  : undefined;

            return {
               query,
               provider: "firecrawl",
               synthesis: finalAnalysis || "Research completed with no synthesis returned.",
               sources,
               activities,
               cost,
               requestId: statusData.id ?? jobId
            };
         }

         if (statusData.status === "failed") {
            return {
               query,
               provider: "firecrawl",
               synthesis: "",
               sources: [],
               error: statusData.error || "Firecrawl research job failed"
            };
         }
      }

      return {
         query,
         provider: "firecrawl",
         synthesis: "",
         sources: [],
         error: `Firecrawl research timed out after ${Math.round(timeoutMs / 1000)}s`
      };
   } catch (error) {
      return {
         query,
         provider: "firecrawl",
         synthesis: "",
         sources: [],
         error: error instanceof Error ? error.message : String(error)
      };
   }
}
