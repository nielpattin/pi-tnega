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

  it("accepts valid structured output against an outputSchema and settles the job", async () => {
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

    const validRes = await runtime.runPromise(
      handleSubmit({ result: { data: { count: 10 } } }, { jobId: job.id, expectedSchema: jsonSchema })
    );
    expect(validRes).toEqual({ ok: true, status: "completed" });

    const updated = await runtime.runPromise(JobRegistry.use((svc) => svc.get(job.id)));
    expect(updated?.status).toBe("completed");
    expect(updated?.resultData).toEqual({ count: 10 });
  });

  it("returns precise validation errors without settling or terminating on schema failure", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-validate-error",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );
    await runtime.runPromise(JobRegistry.use((svc) => svc.updateStatus(job.id, "running")));

    const jsonSchema = {
      type: "object",
      properties: {
        count: { type: "number" }
      },
      required: ["count"]
    };

    const invalidRes = await runtime.runPromise(
      handleSubmit({ result: { data: { count: "not-a-num" } } }, { jobId: job.id, expectedSchema: jsonSchema })
    );

    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.status).toBeUndefined();
    expect(String(invalidRes.error)).toContain("count");
    expect(String(invalidRes.error)).toContain("number");

    const updated = await runtime.runPromise(JobRegistry.use((svc) => svc.get(job.id)));
    expect(updated?.status).toBe("running");
    expect(updated?.resultData).toBeUndefined();
    expect(updated?.errorText).toBeUndefined();
  });

  it("allows more than three invalid schema submissions before a valid fourth submission clears state and settles exactly once", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-retry-loop",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );
    await runtime.runPromise(JobRegistry.use((svc) => svc.updateStatus(job.id, "running")));

    const jsonSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" }
        },
        total: { type: "integer" }
      },
      required: ["items", "total"]
    };

    const invalidPayloads = [
      { items: "not-an-array", total: 1 },
      { items: [1, 2], total: 1 },
      { items: ["a"], total: "not-a-number" },
      { items: ["a", "b"] }
    ];

    for (const payload of invalidPayloads) {
      const res = await runtime.runPromise(
        handleSubmit({ result: { data: payload } }, { jobId: job.id, expectedSchema: jsonSchema })
      );
      expect(res.ok).toBe(false);
      expect(res.status).toBeUndefined();
    }

    const validPayload = { items: ["alpha", "beta", "gamma"], total: 3 };
    const validRes = await runtime.runPromise(
      handleSubmit({ result: { data: validPayload } }, { jobId: job.id, expectedSchema: jsonSchema })
    );
    expect(validRes).toEqual({ ok: true, status: "completed" });

    const updated = await runtime.runPromise(JobRegistry.use((svc) => svc.get(job.id)));
    expect(updated?.status).toBe("completed");
    expect(updated?.resultData).toEqual(validPayload);
  });

  it("preserves the final valid structured data exactly after earlier invalid attempts", async () => {
    const job = await runtime.runPromise(
      JobRegistry.use((svc) =>
        svc.register({
          id: "task-preserve-data",
          ownerSessionId: "parent",
          name: "test",
          kind: "agent",
          promptOrCommand: "do something"
        })
      )
    );
    await runtime.runPromise(JobRegistry.use((svc) => svc.updateStatus(job.id, "running")));

    const jsonSchema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            value: { type: "number" }
          },
          required: ["value"]
        },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["nested", "tags"]
    };

    await runtime.runPromise(
      handleSubmit({ result: { data: { nested: { value: "wrong" }, tags: [] } } }, { jobId: job.id, expectedSchema: jsonSchema })
    );

    const validPayload = { nested: { value: 42 }, tags: ["a", "b"], extra: true };
    await runtime.runPromise(
      handleSubmit({ result: { data: validPayload } }, { jobId: job.id, expectedSchema: jsonSchema })
    );

    const updated = await runtime.runPromise(JobRegistry.use((svc) => svc.get(job.id)));
    expect(updated?.resultData).toEqual(validPayload);
  });
});
