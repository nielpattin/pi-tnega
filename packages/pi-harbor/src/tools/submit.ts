import { Type, type Static } from "typebox";
import { Effect } from "effect";
import { JobRegistry } from "../services/JobRegistry.js";
import { SchemaValidator } from "../services/SchemaValidator.js";

export const SubmitToolParamsSchema = Type.Object({
   result: Type.Union([Type.Object({ data: Type.Unknown() }), Type.Object({ error: Type.String() })])
});

export type SubmitToolParams = Static<typeof SubmitToolParamsSchema>;

export const submitToolDefinition = {
   name: "submit",
   description: "Submit final task execution result or error.",
   parameters: SubmitToolParamsSchema
};

export interface HandleSubmitOptions {
   jobId?: string;
   expectedSchema?: unknown;
   schemaMode?: "strict" | "permissive";
}

export const handleSubmit = Effect.fn("submit.handleSubmit")(function* (
   params: SubmitToolParams,
   options?: HandleSubmitOptions
) {
   const registry = yield* JobRegistry;

   const resultObj = params?.result;
   if (!resultObj || typeof resultObj !== "object") {
      return { ok: false, error: "Invalid result payload" };
   }

   if ("error" in resultObj && typeof resultObj.error === "string") {
      if (options?.jobId) {
         yield* registry.updateStatus(options.jobId, "failed", {
            errorText: resultObj.error
         });
      }
      return { ok: true, status: "failed" };
   }

   if ("data" in resultObj) {
      const data = resultObj.data;
      if (options?.expectedSchema) {
         const validator = yield* SchemaValidator;
         const converted = yield* validator
            .convertSchema(options.expectedSchema)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));

         if (converted) {
            const validationResult = yield* validator
               .validateData(converted, data)
               .pipe(Effect.catch((err: any) => Effect.succeed({ _error: err.message })));

            if (validationResult && typeof validationResult === "object" && "_error" in validationResult) {
               const errMsg = String((validationResult as any)._error);
               if (options?.schemaMode === "permissive") {
                  if (options?.jobId) {
                     yield* registry.updateStatus(options.jobId, "completed", {
                        resultData: data,
                        schemaWarning: errMsg
                     });
                  }
                  return { ok: true, status: "completed", schemaWarning: errMsg };
               } else {
                  if (options?.jobId) {
                     yield* registry.updateStatus(options.jobId, "failed", {
                        errorText: `Schema validation failed: ${errMsg}`
                     });
                  }
                  return { ok: true, status: "failed", errorText: errMsg };
               }
            }
         }
      }

      if (options?.jobId) {
         yield* registry.updateStatus(options.jobId, "completed", {
            resultData: data
         });
      }
      return { ok: true, status: "completed" };
   }

   return { ok: false, error: "Result must contain data or error" };
});
