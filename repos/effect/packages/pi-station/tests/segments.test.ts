import { describe, expect, it } from "vitest";

// Mock theme that just returns text as-is
const mockTheme = {
   fg: (_color: string, text: string) => text,
};

// Helper to create mock segment context
function createMockCtx(overrides: Record<string, any> = {}) {
   return {
      autoCompactEnabled: false,
      colors: {},
      contextPercent: 0,
      contextTokens: 0,
      contextWindow: 0,
      customCompactionEnabled: false,
      theme: mockTheme,
      usageStats: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, latestCacheHitRate: undefined, output: 0 },
      usingSubscription: false,
      ...overrides,
   };
}

// Import segments from the module
import { SEGMENTS } from "../segments.ts";

describe("cache_read segment", () => {
   it("shows only cache tokens without cost", () => {
      const ctx = createMockCtx({
         usageStats: { cacheRead: 405_000, cacheWrite: 0, cost: 0.105, input: 10_000, output: 5000 },
      });
      const result = SEGMENTS.cache_read.render(ctx as any);
      expect(result.visible).toBe(true);
      expect(result.content).toContain("C:405k");
      expect(result.content).not.toContain("$");
   });

   it("hides when no cache read tokens", () => {
      const ctx = createMockCtx({
         usageStats: { cacheRead: 0, cacheWrite: 0, cost: 0.105, input: 10_000, output: 5000 },
      });
      const result = SEGMENTS.cache_read.render(ctx as any);
      expect(result.visible).toBe(false);
   });
});

describe("cache_hit segment", () => {
   it("shows latest cache hit rate when present", () => {
      const ctx = createMockCtx({
         usageStats: {
            cacheRead: 400_000,
            cacheWrite: 0,
            cost: 0.105,
            input: 100_000,
            latestCacheHitRate: 99.8,
            output: 5000,
         },
      });
      const result = SEGMENTS.cache_hit.render(ctx as any);
      expect(result.visible).toBe(true);
      expect(result.content).toContain("CH99.8%");
   });

   it("hides when latestCacheHitRate is undefined", () => {
      const ctx = createMockCtx({
         usageStats: {
            cacheRead: 400_000,
            cacheWrite: 0,
            cost: 0.105,
            input: 100_000,
            latestCacheHitRate: undefined,
            output: 5000,
         },
      });
      const result = SEGMENTS.cache_hit.render(ctx as any);
      expect(result.visible).toBe(false);
   });

   it("shows 100% when latestCacheHitRate is 100", () => {
      const ctx = createMockCtx({
         usageStats: {
            cacheRead: 400_000,
            cacheWrite: 0,
            cost: 0.105,
            input: 0,
            latestCacheHitRate: 100,
            output: 5000,
         },
      });
      const result = SEGMENTS.cache_hit.render(ctx as any);
      expect(result.visible).toBe(true);
      expect(result.content).toContain("CH100.0%");
   });
});

describe("cost segment", () => {
   it("shows cost when cost exists", () => {
      const ctx = createMockCtx({
         usageStats: { cacheRead: 405_000, cacheWrite: 0, cost: 0.105, input: 10_000, output: 5000 },
      });
      const result = SEGMENTS.cost.render(ctx as any);
      expect(result.visible).toBe(true);
      expect(result.content).toContain("$0.105");
   });

   it("shows (sub) indicator when using subscription", () => {
      const ctx = createMockCtx({
         usageStats: { cacheRead: 405_000, cacheWrite: 0, cost: 0.105, input: 10_000, output: 5000 },
         usingSubscription: true,
      });
      const result = SEGMENTS.cost.render(ctx as any);
      expect(result.visible).toBe(true);
      expect(result.content).toContain("$0.105 (sub)");
   });

   it("hides when no cost and not using subscription", () => {
      const ctx = createMockCtx({
         usageStats: { cacheRead: 405_000, cacheWrite: 0, cost: 0, input: 10_000, output: 5000 },
      });
      const result = SEGMENTS.cost.render(ctx as any);
      expect(result.visible).toBe(false);
   });
});
