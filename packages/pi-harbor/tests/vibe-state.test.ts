import { describe, it, expect } from "vitest";
import { isDirectorTool, restoreVibeState, VibeState } from "../src/services/VibeState.js";
import { VibeSpawnParamsSchema, VibeSendParamsSchema, VibeWaitParamsSchema, VibeKillParamsSchema, VibeListParamsSchema } from "../src/tools/vibe.js";
import { ManagedRuntime, Effect } from "effect";

describe("VibeState & Director Mode Helpers", () => {
  it("correctly identifies director tools with isDirectorTool predicate", () => {
    const directorTools = [
      "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list",
      "read", "describe_image", "web_search_exa", "deep_search_exa",
      "web_fetch_exa", "read_session", "workflow", "mcp", "mcp_server_tool"
    ];
    for (const name of directorTools) {
      expect(isDirectorTool(name)).toBe(true);
    }

    const nonDirectorTools = ["write", "edit", "bash", "task", "hub", "random_tool"];
    for (const name of nonDirectorTools) {
      expect(isDirectorTool(name)).toBe(false);
    }
  });

  it("restores tool catalog from LAST vibe-state session entry intersected with registered tools", () => {
    const registeredTools = ["read", "write", "edit", "grep", "find", "hub", "vibe_spawn"];
    const entries = [
      { customType: "vibe-state", data: { savedTools: ["read", "write"] } },
      { customType: "vibe-state", data: { savedTools: ["read", "write", "edit", "unknown_old_tool"] } }
    ];

    const restored = restoreVibeState(entries, registeredTools);
    expect(restored).toEqual(["read", "write", "edit"]);
  });

  it("falls back to all non-vibe registered tools if no vibe-state entry exists", () => {
    const registeredTools = ["read", "write", "vibe_spawn", "vibe_send"];
    const restored = restoreVibeState([], registeredTools);
    expect(restored).toEqual(["read", "write"]);
  });

  it("VibeState service tracks vibe active status", async () => {
    const runtime = ManagedRuntime.make(VibeState.layer);
    const status = await runtime.runPromise(
      VibeState.use((vs) =>
        Effect.gen(function* () {
          yield* vs.setVibeActive(true);
          return yield* vs.isVibeActive;
        })
      )
    );
    expect(status).toBe(true);
  });

  it("exports valid TypeBox schemas for vibe tools", () => {
    expect(VibeSpawnParamsSchema).toBeDefined();
    expect(VibeSendParamsSchema).toBeDefined();
    expect(VibeWaitParamsSchema).toBeDefined();
    expect(VibeKillParamsSchema).toBeDefined();
    expect(VibeListParamsSchema).toBeDefined();
  });
});
