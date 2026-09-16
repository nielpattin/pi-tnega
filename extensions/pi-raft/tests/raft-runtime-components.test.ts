import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeRaftConfig } from "../src/config.js";
import { RaftRuntimeState } from "../src/raft-runtime-state.js";
import { RAFT_COMPONENT_DISCOVER_EVENT, type RaftComponentDiscovery } from "../src/protocol.js";

describe("Raft runtime provider components", () => {
  it("activates every enabled built-in component before execution and discovery", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-raft-runtime-components-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_RAFT_PROJECT_ROOT", cwd);

    let runtime!: RaftRuntimeState;
    const discoverySnapshots: Array<{ initialized: boolean; active: string[] }> = [];
    let componentDiscovery: RaftComponentDiscovery | undefined;
    const pi = {
      events: {
        emit: vi.fn((event: string, payload: unknown) => {
          if (event === RAFT_COMPONENT_DISCOVER_EVENT) {
            discoverySnapshots.push({
              initialized: runtime.initialized,
              active: runtime
                .componentGraph()
                .components.filter((component) => component.state === "active")
                .map((component) => component.id)
                .sort(),
            });
            componentDiscovery = payload as RaftComponentDiscovery;
            componentDiscovery.register({
              name: "guidance-only",
              guarantee: "revertible",
              activate(component) {
                component.guide({
                  label: "deepseek-profile",
                  models: ["deepseek/*"],
                  content: "Use the DeepSeek profile.",
                });
              },
            });
          }
        }),
      },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: {
        getSessionId: () => "runtime-components-session",
        getSessionFile: () => undefined,
        getBranch: () => [],
        getLeafId: () => undefined,
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeRaftConfig({
      execution: { executor: { kernel: "typescript" } },
      tools: { mcp: { cache: { enabled: false } } },
      components: [{ id: "guidance-only", component: "guidance-only" }],
      memory: { enabled: true },
      agents: { enabled: false },
      residency: { enabled: false },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    runtime = new RaftRuntimeState(pi, {});

    try {
      await runtime.initialize(context, config);

      expect(discoverySnapshots).toEqual([
        {
          initialized: true,
          active: ["raft.provider.agents", "raft.provider.mcp", "raft.provider.memory"],
        },
      ]);
      const discovery = componentDiscovery;
      if (!discovery) throw new Error("Expected component discovery");
      expect(() =>
        discovery.register({ name: "raft.provider.mcp", activate() {} }, { overwrite: true }),
      ).toThrow("Reserved Raft component name: raft.provider.mcp");
      const builtins = runtime
        .componentGraph()
        .components.filter((component) => component.id.startsWith("raft.provider."));
      expect(builtins).toEqual(
        expect.arrayContaining(
          ["mcp", "agents", "memory"].map((name) =>
            expect.objectContaining({ id: `raft.provider.${name}`, state: "active" }),
          ),
        ),
      );
      expect(
        builtins.flatMap(
          (component) => component.effects?.flatMap((effect) => effect.resources) ?? [],
        ),
      ).not.toContain("*");
      expect(builtins.find((component) => component.id === "raft.provider.mcp")?.effects).toEqual([
        {
          label: "provider-component:mcp:holder",
          kind: "transactional",
          resources: ["raft:provider:mcp:holder"],
          ordering: "ordered",
        },
      ]);

      const guidance = runtime
        .componentGraph()
        .components.find((component) => component.id === "guidance-only");
      expect(guidance).toMatchObject({ state: "active" });
      expect(guidance?.effectConflicts).toBeUndefined();
      expect(runtime.modelGuidance()).toContainEqual(
        expect.objectContaining({ componentId: "guidance-only", label: "deepseek-profile" }),
      );
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
