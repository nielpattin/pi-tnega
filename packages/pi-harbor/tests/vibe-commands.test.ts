import { describe, expect, it, vi } from "vitest";
import { handleVibeCommand, type PiVibeFacade } from "../src/commands/vibe.js";

describe("/vibe Command Orchestration (Algorithm D)", () => {
   const mockAllTools = [
      "read",
      "write",
      "edit",
      "grep",
      "vibe_spawn",
      "vibe_send",
      "vibe_wait",
      "vibe_kill",
      "vibe_list",
      "custom_tool"
   ];

   function createMockFacade(opts?: {
      activeTools?: string[];
      entries?: any[];
   }) {
      let activeTools = opts?.activeTools ?? ["read", "write", "edit", "custom_tool", "vibe_spawn"];
      const entries: any[] = opts?.entries ?? [];
      let widgetText: string | undefined = undefined;

      const getActiveTools = vi.fn(() => [...activeTools]);
      const setActiveTools = vi.fn((tools: string[]) => {
         activeTools = [...tools];
      });
      const getAllTools = vi.fn(() => [...mockAllTools]);
      const appendEntry = vi.fn((type: string, data: any) => {
         entries.push({ customType: type, data });
      });
      const getEntries = vi.fn(() => [...entries]);
      const setStatusWidget = vi.fn((text?: string) => {
         widgetText = text;
      });

      return {
         facade: {
            getActiveTools,
            setActiveTools,
            getAllTools,
            appendEntry,
            getEntries,
            setStatusWidget
         } as PiVibeFacade,
         getActiveTools,
         setActiveTools,
         getAllTools,
         appendEntry,
         getEntries,
         setStatusWidget,
         getWidgetText: () => widgetText
      };
   }

   function createMockVibeState(initialActive = false) {
      let active = initialActive;
      const setVibeActive = vi.fn((val: boolean) => {
         active = val;
      });
      const terminateVibeSessions = vi.fn(() => {});

      return {
         state: {
            isVibeActive: () => active,
            setVibeActive,
            terminateVibeSessions
         },
         setVibeActive,
         terminateVibeSessions
      };
   }

   it("ENTER: saves baseline without vibe_ tools, sets director tools, enables guard, sets widget", () => {
      const mockF = createMockFacade();
      const mockVS = createMockVibeState(false);

      const result = handleVibeCommand(mockF.facade, mockVS.state);

      expect(result).toBe("Vibe mode activated");
      expect(mockF.getActiveTools).toHaveBeenCalledTimes(1);
      expect(mockF.appendEntry).toHaveBeenCalledWith("vibe-state", {
         savedTools: ["read", "write", "edit", "custom_tool"],
         timestamp: expect.any(Number)
      });
      expect(mockVS.setVibeActive).toHaveBeenCalledWith(true);
      expect(mockF.setStatusWidget).toHaveBeenCalledWith("🎬 vibe");

      // setActiveTools called with director tools
      expect(mockF.setActiveTools).toHaveBeenCalledWith(
         expect.arrayContaining(["read", "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"])
      );
      const setTools = mockF.setActiveTools.mock.calls[0][0];
      expect(setTools).not.toContain("write");
      expect(setTools).not.toContain("custom_tool");
   });

   it("LEAVE: restores from last vibe-state entry, NEVER calls getActiveTools, clears widget", () => {
      const mockF = createMockFacade({
         entries: [
            { customType: "vibe-state", data: { savedTools: ["read", "write", "custom_tool"] } }
         ]
      });
      const mockVS = createMockVibeState(true);

      const result = handleVibeCommand(mockF.facade, mockVS.state);

      expect(result).toBe("Vibe mode deactivated");
      expect(mockF.getActiveTools).not.toHaveBeenCalled(); // NEVER getActiveTools on restore
      expect(mockF.getEntries).toHaveBeenCalledTimes(1);
      expect(mockVS.setVibeActive).toHaveBeenCalledWith(false);
      expect(mockVS.terminateVibeSessions).toHaveBeenCalledTimes(1);
      expect(mockF.setStatusWidget).toHaveBeenCalledWith(undefined);

      expect(mockF.setActiveTools).toHaveBeenCalledWith(["read", "write", "custom_tool"]);
   });

   it("LEAVE without snapshot: falls back to all non-vibe tools from getAllTools", () => {
      const mockF = createMockFacade({ entries: [] });
      const mockVS = createMockVibeState(true);

      handleVibeCommand(mockF.facade, mockVS.state);

      expect(mockF.getActiveTools).not.toHaveBeenCalled();
      expect(mockF.setActiveTools).toHaveBeenCalledWith([
         "read",
         "write",
         "edit",
         "grep",
         "custom_tool"
      ]);
   });
});
