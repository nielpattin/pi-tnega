import { describe, expect, it } from "vitest";
import { resolvePiModel, mapThinkingLevel } from "../src/backends/pi-model.js";

describe("pi-model", () => {
  const fakeRegistry = {
    models: [
      { provider: "anthropic", id: "claude-3-5-sonnet" },
      { provider: "openai", id: "gpt-4o" },
      { provider: "openai", id: "claude-3-5-sonnet" }, // duplicate id across provider for testing
      { provider: "google", id: "gemini-1.5-pro" }
    ],
    find(provider: string, id: string) {
      return this.models.find((m) => m.provider === provider && m.id === id);
    },
    getAll() {
      return this.models;
    }
  };

  it("resolves model by provider/id", () => {
    const model = resolvePiModel(fakeRegistry, "anthropic/claude-3-5-sonnet");
    expect(model).toEqual({ provider: "anthropic", id: "claude-3-5-sonnet" });
  });

  it("throws error for unknown provider/id model", () => {
    expect(() => resolvePiModel(fakeRegistry, "foo/bar")).toThrow('Unknown model "foo/bar"');
  });

  it("resolves model using inherited provider", () => {
    const model = resolvePiModel(fakeRegistry, "claude-3-5-sonnet", { provider: "anthropic", id: "claude-3-5-sonnet" });
    expect(model).toEqual({ provider: "anthropic", id: "claude-3-5-sonnet" });
  });

  it("resolves unique bare model id without inherited provider", () => {
    const model = resolvePiModel(fakeRegistry, "gemini-1.5-pro");
    expect(model).toEqual({ provider: "google", id: "gemini-1.5-pro" });
  });

  it("throws for ambiguous bare model id without matching inherited provider", () => {
    expect(() => resolvePiModel(fakeRegistry, "claude-3-5-sonnet")).toThrow(
      'Model "claude-3-5-sonnet" exists in multiple providers (anthropic, openai)'
    );
  });

  it("returns inherited model when no model hint given", () => {
    const model = resolvePiModel(fakeRegistry, undefined, { provider: "google", id: "gemini-1.5-pro" });
    expect(model).toEqual({ provider: "google", id: "gemini-1.5-pro" });
  });

  it("returns undefined when no model hint and no inherited model", () => {
    const model = resolvePiModel(fakeRegistry, undefined, undefined);
    expect(model).toBeUndefined();
  });

  it("maps thinking levels including max", () => {
    expect(mapThinkingLevel("max")).toBe("max");
    expect(mapThinkingLevel("high")).toBe("high");
    expect(mapThinkingLevel("off")).toBe("off");
    expect(mapThinkingLevel(undefined)).toBe("medium");
  });
});
