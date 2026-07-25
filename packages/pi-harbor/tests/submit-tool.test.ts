import { describe, expect, it } from "vitest";
import { Effect, ManagedRuntime, Layer } from "effect";
import { SubmitToolParamsSchema, submitToolDefinition, handleSubmit } from "../src/tools/submit.js";
import { JobRegistry } from "../src/services/JobRegistry.js";
import { SchemaValidator } from "../src/services/SchemaValidator.js";

describe("submit tool", () => {
  const TestLayer = JobRegistry.layer.pipe(Layer.provideMerge(SchemaValidator.layer));
  const runtime = ManagedRuntime.make(TestLayer);

  it("exports valid TypeBox SubmitToolParamsSchema", () => {
    expect(SubmitToolParamsSchema.type).toBe("object");
    expect(submitToolDefinition.name).toBe("submit");
  });

  it("settles job as completed when data is provided without schema", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-1",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );

    const res = await runtime.runPromise(
      handleSubmit({ result: { data: { foo: "bar" } } }, { jobId: job.id })
    );

    expect(res).toEqual({ ok: true, status: "completed" });

    const updated = await runtime.runPromise(
      JobRegistry.use((svc) => svc.get("task-1"))
    );
    expect(updated?.status).toBe("completed");
    expect(updated?.resultData).toEqual({ foo: "bar" });
  });

  it("settles job as failed when error is provided", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-2",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );

    const res = await runtime.runPromise(
      handleSubmit({ result: { error: "Failed to process" } }, { jobId: job.id })
    );

    expect(res).toEqual({ ok: true, status: "failed" });

    const updated = await runtime.runPromise(
      JobRegistry.use((svc) => svc.get("task-2"))
    );
    expect(updated?.status).toBe("failed");
    expect(updated?.errorText).toBe("Failed to process");
  });

  it("validates output data against expected schema when provided", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-3",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );

    const jsonSchema = {
      type: "object",
      properties: {
        count: { type: "number" }
      },
      required: ["count"]
    };

    // Valid case
    const validRes = await runtime.runPromise(
      handleSubmit({ result: { data: { count: 10 } } }, { jobId: job.id, expectedSchema: jsonSchema })
    );
    expect(validRes.status).toBe("completed");

    // Invalid case
    const job4 = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-4",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );

    const invalidRes = await runtime.runPromise(
      handleSubmit({ result: { data: { count: "not-a-num" } } }, { jobId: job4.id, expectedSchema: jsonSchema })
    );
    expect(invalidRes.status).toBe("failed");
  });
});
