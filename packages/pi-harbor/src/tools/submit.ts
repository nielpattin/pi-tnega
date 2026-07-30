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
   settleJob?: boolean;
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
      if (options?.jobId && options.settleJob !== false) {
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
         const converted = yield* validator.convertSchema(options.expectedSchema).pipe(
            Effect.match({
               onFailure: (err) => ({ ok: false as const, error: err.message }),
               onSuccess: (schema) => ({ ok: true as const, schema })
            })
         );
         if (!converted.ok) {
            return { ok: false, error: converted.error };
         }

         const validated = yield* validator.validateData(converted.schema, data).pipe(
            Effect.match({
               onFailure: (err) => ({ ok: false as const, error: err.message }),
               onSuccess: () => ({ ok: true as const })
            })
         );
         if (!validated.ok) {
            return { ok: false, error: validated.error };
         }
      }

      if (options?.jobId && options.settleJob !== false) {
         yield* registry.updateStatus(options.jobId, "completed", {
            resultData: data
         });
      }
      return { ok: true, status: "completed" };
   }

   return { ok: false, error: "Result must contain data or error" };
});
