import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/compaction/hook.js";
import { compactAtConfiguredThreshold, modelCompactionKey } from "../src/compaction/threshold.js";
import { DEFAULT_RAFT_CONFIG } from "../src/config.js";

const contextWithUsage = (percent: number | null): ExtensionContext =>
  ({
    model: { provider: "anthropic", id: "sonnet" },
    getContextUsage: () => ({
      tokens: percent === null ? null : percent * 1_000,
      contextWindow: 100_000,
      percent,
    }),
    compact: vi.fn((options) => options?.onComplete?.({} as never)),
    hasUI: true,
    ui: { notify: vi.fn() },
  }) as unknown as ExtensionContext;

describe("model-linked compaction thresholds", () => {
  it("builds canonical provider/model keys", () => {
    expect(modelCompactionKey({ provider: "openai", id: "gpt-5" } as never)).toBe("openai/gpt-5");
    expect(modelCompactionKey(undefined)).toBeUndefined();
  });

  it("compacts when the active model reaches its configured threshold", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.lifecycle.compaction.thresholds["anthropic/sonnet"] = 0.8;
    const context = contextWithUsage(80);

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(
      (context as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).toHaveBeenCalledOnce();
  });

  it("defers Pi's earlier automatic threshold for the active model", () => {
    let handler:
      | ((event: SessionBeforeCompactEvent, context: ExtensionContext) => unknown)
      | undefined;
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_compact") {
          handler = candidate as typeof handler;
        }
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, {
      getEngine: () => "pi",
      getThresholdContextRatio: (key) => (key === "anthropic/sonnet" ? 0.8 : undefined),
    });
    const context = {
      model: { provider: "anthropic", id: "sonnet", contextWindow: 100_000 },
    } as unknown as ExtensionContext;
    const event = {
      reason: "threshold",
      preparation: { tokensBefore: 70_000 },
      branchEntries: [],
    } as unknown as SessionBeforeCompactEvent;

    expect(handler?.(event, context)).toEqual({ cancel: true });
    expect(
      handler?.(
        { ...event, preparation: { tokensBefore: 80_000 } } as SessionBeforeCompactEvent,
        context,
      ),
    ).toBeUndefined();
    expect(
      handler?.({ ...event, reason: "overflow" } as SessionBeforeCompactEvent, context),
    ).toBeUndefined();
  });

  it("compacts when token usage reaches a configured token threshold", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.lifecycle.compaction.tokenThresholds["anthropic/sonnet"] = 50_000;
    const context = contextWithUsage(80); // 80,000 of 100,000 tokens

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(
      (context as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).toHaveBeenCalledOnce();
  });

  it("lets token thresholds win over ratios and skips unknown token usage", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.lifecycle.compaction.thresholds["anthropic/sonnet"] = 0.25;
    config.lifecycle.compaction.tokenThresholds["anthropic/sonnet"] = 900_000;
    const context = contextWithUsage(80); // 80,000 tokens: ratio exceeded, token threshold not

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(
      (context as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).not.toHaveBeenCalled();

    const unknownUsage = contextWithUsage(null); // tokens unknown right after compaction
    await expect(compactAtConfiguredThreshold(unknownUsage, config)).resolves.toBe(false);
    expect(
      (unknownUsage as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).not.toHaveBeenCalled();
  });

  it("defers Pi's automatic threshold below a configured token threshold", () => {
    let handler:
      | ((event: SessionBeforeCompactEvent, context: ExtensionContext) => unknown)
      | undefined;
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_compact") {
          handler = candidate as typeof handler;
        }
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, {
      getEngine: () => "pi",
      getThresholdTokens: (key) => (key === "anthropic/sonnet" ? 150_000 : undefined),
      // A configured token threshold takes precedence: this ratio is ignored.
      getThresholdContextRatio: () => 0.25,
    });
    const context = {
      model: { provider: "anthropic", id: "sonnet", contextWindow: 100_000 },
    } as unknown as ExtensionContext;
    const event = {
      reason: "threshold",
      preparation: { tokensBefore: 120_000 },
      branchEntries: [],
    } as unknown as SessionBeforeCompactEvent;

    expect(handler?.(event, context)).toEqual({ cancel: true });
    expect(
      handler?.(
        { ...event, preparation: { tokensBefore: 150_000 } } as SessionBeforeCompactEvent,
        context,
      ),
    ).toBeUndefined();
    expect(
      handler?.({ ...event, reason: "overflow" } as SessionBeforeCompactEvent, context),
    ).toBeUndefined();
  });

  it("does not compact below threshold or for an unconfigured model", async () => {
    const config = structuredClone(DEFAULT_RAFT_CONFIG);
    config.lifecycle.compaction.thresholds["anthropic/sonnet"] = 0.85;
    const context = contextWithUsage(80);

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(
      (context as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).not.toHaveBeenCalled();

    config.lifecycle.compaction.thresholds = {};
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(
      (context as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).not.toHaveBeenCalled();
  });
});
