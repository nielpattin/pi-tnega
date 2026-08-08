import { Context, Effect, Layer, Schema, JsonSchema, SchemaRepresentation } from "effect";
import { SchemaConversionError, SchemaValidationError } from "../domain.js";

export interface SchemaValidatorShape {
   readonly convertSchema: (jsonSchemaDoc: unknown) => Effect.Effect<Schema.Schema<any>, SchemaConversionError>;

   readonly validateData: (schema: Schema.Schema<any>, data: unknown) => Effect.Effect<unknown, SchemaValidationError>;
}

export class SchemaValidator extends Context.Service<SchemaValidator, SchemaValidatorShape>()(
   "workers/SchemaValidator"
) {
   static readonly layer = Layer.effect(
      SchemaValidator,
      Effect.sync(() => {
         const convertSchema = Effect.fn("SchemaValidator.convertSchema")(function* (jsonSchemaDoc: unknown) {
            if (!jsonSchemaDoc || typeof jsonSchemaDoc !== "object") {
               return yield* new SchemaConversionError({
                  message: "Schema document must be an object."
               });
            }
            return yield* Effect.try({
               try: () => {
                  const document = JsonSchema.fromSchemaDraft2020_12(jsonSchemaDoc as any);
                  return SchemaRepresentation.fromJsonSchemaDocument(document) as Schema.Schema<any>;
               },
               catch: (cause) =>
                  new SchemaConversionError({
                     message: `Failed to convert JSON schema: ${cause instanceof Error ? cause.message : String(cause)}`
                  })
            });
         });

         const validateData = Effect.fn("SchemaValidator.validateData")(function* (
            schema: Schema.Schema<any>,
            data: unknown
         ) {
            return yield* Effect.tryPromise({
               try: () => Schema.decodeUnknownPromise(schema as any)(data),
               catch: (cause) =>
                  new SchemaValidationError({
                     message: `Schema validation failed: ${cause instanceof Error ? cause.message : String(cause)}`
                  })
            });
         });

         return SchemaValidator.of({
            convertSchema,
            validateData
         });
      })
   );

   static override use<A, E, R>(
      fn: (svc: SchemaValidatorShape) => Effect.Effect<A, E, R>
   ): Effect.Effect<A, E, R | SchemaValidator> {
      return Effect.gen(function* () {
         const svc = yield* SchemaValidator;
         return yield* fn(svc);
      });
   }
}
