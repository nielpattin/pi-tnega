import { describe, it, expect, vi } from "vitest";
import { decodeAcpRecord, pollAgyDb, type AcpRecord, type AcpDecodedEvent } from "../src/utils/acp-decoder.js";
import { Effect, Scope, Exit } from "effect";

describe("ACP Decoder", () => {
  it("decodes in_progress status to ToolStart event", () => {
    const record: AcpRecord = {
      id: "call-1",
      toolCallId: "call-1",
      toolName: "read",
      status: "in_progress",
      args: { path: "src/index.ts" }
    };
    const decoded = decodeAcpRecord(record);
    expect(decoded).toEqual({
      _tag: "ToolStart",
      toolCallId: "call-1",
      toolName: "read",
      argsPreview: '{"path":"src/index.ts"}',
      timestamp: undefined
    });
  });

  it("decodes completed status to ToolEnd event", () => {
    const record: AcpRecord = {
      id: "call-1",
      toolCallId: "call-1",
      toolName: "read",
      status: "completed",
      result: "file contents",
      isError: false
    };
    const decoded = decodeAcpRecord(record);
    expect(decoded).toEqual({
      _tag: "ToolEnd",
      toolCallId: "call-1",
      toolName: "read",
      resultPreview: "file contents",
      isError: false,
      timestamp: undefined
    });
  });

  it("decodes stdout deltas to AssistantDelta event", () => {
    const record: AcpRecord = {
      delta: "Hello world"
    };
    const decoded = decodeAcpRecord(record);
    expect(decoded).toEqual({
      _tag: "AssistantDelta",
      delta: "Hello world",
      timestamp: undefined
    });
  });
});

describe("AGY DB Poller", () => {
  it("polls DB and emits decoded events using an injectable reader", async () => {
    const records: AcpRecord[][] = [
      [{ delta: "chunk 1" }],
      [{ id: "t1", toolCallId: "t1", toolName: "grep", status: "in_progress" }],
      [{ id: "t1", toolCallId: "t1", toolName: "grep", status: "completed", result: "ok" }]
    ];
    let pollCount = 0;
    const fakeReader = vi.fn(async () => {
      const current = records[pollCount] || [];
      pollCount++;
      return current;
    });

    const eventsEmitted: AcpDecodedEvent[] = [];
    const onEvent = (evt: AcpDecodedEvent) => {
      eventsEmitted.push(evt);
    };

    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(
      Scope.provide(
        pollAgyDb({
          conversationId: "conv-123",
          readDb: fakeReader,
          onEvent,
          intervalMs: 10
        }),
        scope
      )
    );

    // Wait a bit for polling ticks
    await new Promise((r) => setTimeout(r, 50));
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(fakeReader).toHaveBeenCalled();
    expect(eventsEmitted.length).toBeGreaterThanOrEqual(2);
    expect(eventsEmitted[0]).toEqual({ _tag: "AssistantDelta", delta: "chunk 1" });
    expect(eventsEmitted[1]._tag).toBe("ToolStart");
  });
});
