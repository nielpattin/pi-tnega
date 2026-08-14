import { Effect } from "effect";
import { Type, type TSchema } from "typebox";
import { JobRegistry } from "../services/JobRegistry.js";

/** Universal parameters used for all worker completions. */
export const StructuredOutputToolParamsSchema = Type.Object({
   summary: Type.String({
      description: "Concise 1-3 sentence high-level overview of outcome."
   }),
   report: Type.String({
      description: "Complete detailed analysis, file paths, diffs, and findings formatted as Markdown prose."
   })
});

/** Explicit failure parameters for workers that cannot complete their assignment. */
export const WorkerErrorToolParamsSchema = Type.Object({
   error: Type.String({
      minLength: 1,
      description: "Why the worker could not complete the assignment."
   })
});

export function createStructuredOutputToolParamsSchema(): TSchema {
   return StructuredOutputToolParamsSchema;
}

export interface HandleStructuredOutputOptions {
   jobId?: string;
   settleJob?: boolean;
}

export const handleStructuredOutput = Effect.fn("structuredOutput.handleStructuredOutput")(function* (
   params: unknown,
   options?: HandleStructuredOutputOptions
) {
   const registry = yield* JobRegistry;

   let data: unknown = params;
   if (params && typeof params === "object" && !Array.isArray(params)) {
      const p = params as Record<string, unknown>;
      if (typeof p.summary === "string" || typeof p.report === "string") {
         data = {
            summary: typeof p.summary === "string" ? p.summary : "",
            report: typeof p.report === "string" ? p.report : ""
         };
      } else if ("data" in p && p.data) {
         data = p.data;
      } else if ("value" in p && p.value) {
         if (typeof p.value === "string") {
            try {
               data = JSON.parse(p.value);
            } catch {
               data = { summary: "Result", report: p.value };
            }
         } else {
            data = p.value;
         }
      }
   }

   if (options?.jobId && options.settleJob !== false) {
      yield* registry.updateStatus(options.jobId, "completed", {
         resultData: data
      });
   }
   return { ok: true as const, status: "completed" as const, data };
});

export function createWorkerErrorTool() {
   return {
      name: "worker_error",
      label: "Worker Error",
      description: "Report that the worker could not complete its assignment.",
      promptSnippet: "Report an unrecoverable worker failure.",
      promptGuidelines: [
         "Use worker_error only when the assignment cannot be completed.",
         "Call it exactly once as the final action and include a concise reason.",
         "Do not emit a final assistant answer before or after calling worker_error."
      ],
      parameters: WorkerErrorToolParamsSchema,
      async execute(_toolCallId: string, params: { error: string }) {
         return {
            content: [{ type: "text" as const, text: `Worker failed: ${params.error}` }],
            details: params,
            terminate: true as const
         };
      }
   };
}
