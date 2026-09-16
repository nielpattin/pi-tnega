import { describe, expect, it, vi } from "vitest";
import {
  createProviderComponent,
  type RaftProviderComponentManifest,
} from "../src/components/provider-component.js";
import { normalizeRaftConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { RuntimeStateBuiltins } from "../src/runtime-state-builtins.js";

const fixture = () => {
  const manifest = { install: vi.fn(async () => {}), assertActive: vi.fn() };
  const onInstalled = vi.fn();
  const registry = new ActionRegistry();
  const builtins = new RuntimeStateBuiltins(
    manifest as unknown as RaftProviderComponentManifest,
    registry,
    onInstalled,
  );
  return { manifest, onInstalled, registry, builtins };
};

describe("runtime built-in installation policy", () => {
  it.each([
    { memory: { enabled: false }, expected: ["mcp", "agents"] },
    { memory: { enabled: true }, expected: ["mcp", "agents", "memory"] },
  ])("asserts the protected provider surface for %j", ({ expected, ...options }) => {
    const { builtins, manifest, registry } = fixture();
    builtins.assertActive(normalizeRaftConfig(options));
    const [names, actualRegistry] = manifest.assertActive.mock.calls[0] as unknown as [
      Set<string>,
      ActionRegistry,
    ];
    expect([...names]).toEqual(expected);
    expect(actualRegistry).toBe(registry);
  });

  it("records ownership only after successful activation", async () => {
    const { builtins, manifest, onInstalled } = fixture();
    const component = createProviderComponent({
      provider: "fixture",
      description: "Fixture",
      create: () => ({
        name: "fixture",
        description: "Fixture",
        async list() {
          return [];
        },
        async describe() {
          return undefined;
        },
        async invoke() {
          return undefined;
        },
      }),
    });
    manifest.install.mockRejectedValueOnce(new Error("activation failed"));
    await expect(builtins.install(component)).rejects.toThrow("activation failed");
    expect(onInstalled).not.toHaveBeenCalled();
    await builtins.install(component);
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith("raft.provider.fixture");
  });
});
