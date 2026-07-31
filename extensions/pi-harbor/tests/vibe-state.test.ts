import { describe, expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { Value } from "typebox/value";
import { isDirectorTool, restoreVibeState, VibeState } from "../src/services/VibeState.js";
import { VibeToolParamsSchema } from "../src/tools/vibe.js";

describe("VibeState & Director Mode Helpers", () => {
   it("identifies the single vibe tool and research tools as director tools", () => {
      const directorTools = [
         "vibe",
         "read",
         "describe_image",
         "web_search_exa",
         "deep_search_exa",
         "web_fetch_exa",
         "read_session",
         "workflow",
         "mcp",
         "mcp_server_tool"
      ];
      for (const name of directorTools) expect(isDirectorTool(name)).toBe(true);

      const nonDirectorTools = ["vibe_spawn", "vibe_send", "write", "edit", "bash", "task", "hub", "random_tool"];
      for (const name of nonDirectorTools) expect(isDirectorTool(name)).toBe(false);
   });

   it("restores the last saved non-Vibe tool catalog", () => {
      const registeredTools = ["read", "write", "edit", "grep", "find", "hub", "vibe"];
      const entries = [
         { customType: "vibe-state", data: { savedTools: ["read", "write"] } },
         { customType: "vibe-state", data: { savedTools: ["read", "write", "edit", "unknown_old_tool"] } }
      ];

      expect(restoreVibeState(entries, registeredTools)).toEqual(["read", "write", "edit"]);
   });

   it("falls back to all registered tools except Vibe tools", () => {
      expect(restoreVibeState([], ["read", "write", "vibe", "vibe_spawn"])).toEqual(["read", "write"]);
   });

   it("tracks Vibe active status", async () => {
      const runtime = ManagedRuntime.make(VibeState.layer);
      const status = await runtime.runPromise(
         VibeState.use((state) =>
            Effect.gen(function* () {
               yield* state.setVibeActive(true);
               return yield* state.isVibeActive;
            })
         )
      );
      expect(status).toBe(true);
   });

   it("accepts every operation through one discriminated vibe schema", () => {
      expect((VibeToolParamsSchema as any).type).toBe("object");
      const validInputs = [
         { op: "spawn", cli: "fast", prompt: "Investigate this" },
         { op: "send", session: "task-1", message: "Continue", mode: "followUp" },
         { op: "wait", sessions: ["task-1"], timeout: 1000 },
         { op: "kill", session: "task-1" },
         { op: "list" }
      ];
      for (const input of validInputs) expect(Value.Check(VibeToolParamsSchema, input)).toBe(true);
      expect(Value.Check(VibeToolParamsSchema, { op: "spawn", prompt: "Missing profile" })).toBe(false);
   });
});
