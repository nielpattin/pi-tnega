import { describe, it, expect } from "vitest";
import { SchemaValidator } from "../src/services/SchemaValidator.js";
import { SchemaConversionError, SchemaValidationError } from "../src/domain.js";
import { ManagedRuntime } from "effect";

describe("SchemaValidator Service", () => {
  const runtime = ManagedRuntime.make(SchemaValidator.layer);

  it("converts a valid JSON schema document to an Effect schema", async () => {
    const rawSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
        status: { type: "string" }
      },
      required: ["count", "status"]
    };

    const convertResult = await runtime.runPromise(
      SchemaValidator.use((svc) => svc.convertSchema(rawSchema))
    );
    expect(convertResult).toBeDefined();
  });

  it("validates data against converted schema successfully", async () => {
    const rawSchema = {
      type: "object",
      properties: {
        count: { type: "number" }
      },
      required: ["count"]
    };

    const schema = await runtime.runPromise(
      SchemaValidator.use((svc) => svc.convertSchema(rawSchema))
    );

    const validData = { count: 42 };
    const validated = await runtime.runPromise(
      SchemaValidator.use((svc) => svc.validateData(schema, validData))
    );
    expect(validated).toEqual({ count: 42 });
  });

  it("raises SchemaValidationError on invalid submit payload", async () => {
    const rawSchema = {
      type: "object",
      properties: {
        count: { type: "number" }
      },
      required: ["count"]
    };

    const schema = await runtime.runPromise(
      SchemaValidator.use((svc) => svc.convertSchema(rawSchema))
    );

    const invalidData = { count: "not-a-number" };
    const exit = await runtime.runPromiseExit(
      SchemaValidator.use((svc) => svc.validateData(schema, invalidData))
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = exit.cause;
      expect(JSON.stringify(err)).toContain("SchemaValidationError");
    }
  });

  it("raises SchemaConversionError on non-object JSON Schema document", async () => {
    const exit = await runtime.runPromiseExit(
      SchemaValidator.use((svc) => svc.convertSchema("not-an-object"))
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("SchemaConversionError");
    }
  });
});
