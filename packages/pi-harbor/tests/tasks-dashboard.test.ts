import { describe, expect, it } from "vitest";
import {
   createTasksDashboardState,
   reduceTasksDashboardKey,
   requestControl,
   type DashboardContext,
   type TasksDashboardState
} from "../src/ui/tasks-dashboard.js";

describe("Tasks Dashboard Pure State Machine", () => {
   it("creates default state", () => {
      const state = createTasksDashboardState();
      expect(state.activeTab).toBe("jobs");
      expect(state.selectedIndex).toBe(0);
      expect(state.isOpen).toBe(true);
      expect(state.takeoverJobId).toBeUndefined();
      expect(state.logProcessName).toBeUndefined();
   });

   it("cycles tabs with Tab and Shift+Tab", () => {
      let state = createTasksDashboardState();
      
      // Tab forward
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("bash");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("processes");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("logs");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("takeover");
      ({ state } = reduceTasksDashboardKey(state, { key: "tab" }));
      expect(state.activeTab).toBe("jobs");

      // Shift+Tab backward
      ({ state } = reduceTasksDashboardKey(state, { key: "tab", shift: true }));
      expect(state.activeTab).toBe("takeover");
   });

   it("navigates selection with j/k and down/up", () => {
      let state = createTasksDashboardState();
      const ctx: DashboardContext = { itemCount: 5 };

      ({ state } = reduceTasksDashboardKey(state, { key: "down" }, ctx));
      expect(state.selectedIndex).toBe(1);

      ({ state } = reduceTasksDashboardKey(state, { key: "j" }, ctx));
      expect(state.selectedIndex).toBe(2);

      ({ state } = reduceTasksDashboardKey(state, { key: "up" }, ctx));
      expect(state.selectedIndex).toBe(1);

      ({ state } = reduceTasksDashboardKey(state, { key: "k" }, ctx));
      expect(state.selectedIndex).toBe(0);

      // Clamp at top
      ({ state } = reduceTasksDashboardKey(state, { key: "up" }, ctx));
      expect(state.selectedIndex).toBe(0);

      // Clamp at bottom
      state.selectedIndex = 4;
      ({ state } = reduceTasksDashboardKey(state, { key: "down" }, ctx));
      expect(state.selectedIndex).toBe(4);
   });

   it("Enter on jobs tab opens takeover tab for selected job", () => {
      const state = createTasksDashboardState({ activeTab: "jobs", selectedIndex: 1 });
      const ctx: DashboardContext = { jobs: [{ id: "task-1" }, { id: "task-2" }] };

      const result = reduceTasksDashboardKey(state, { key: "enter" }, ctx);
      expect(result.state.activeTab).toBe("takeover");
      expect(result.state.takeoverJobId).toBe("task-2");
   });

   it("Enter on processes tab opens logs tab for selected process", () => {
      const state = createTasksDashboardState({ activeTab: "processes", selectedIndex: 0 });
      const ctx: DashboardContext = { processes: [{ name: "api-server" }] };

      const result = reduceTasksDashboardKey(state, { key: "enter" }, ctx);
      expect(result.state.activeTab).toBe("logs");
      expect(result.state.logProcessName).toBe("api-server");
   });

   it("Alt+Enter on jobs tab emits followUp control intent for selected job", () => {
      const state = createTasksDashboardState({ activeTab: "jobs", selectedIndex: 0 });
      const ctx: DashboardContext = {
         jobs: [{ id: "task-1" }],
         inputText: "check status"
      };

      const result = reduceTasksDashboardKey(state, { key: "enter", alt: true }, ctx);
      expect(result.intent).toEqual({
         type: "takeover_control",
         id: "task-1",
         text: "check status",
         mode: "followUp"
      });
   });

   it("Enter on takeover tab emits steer control intent for takeoverJobId", () => {
      const state = createTasksDashboardState({
         activeTab: "takeover",
         takeoverJobId: "task-1",
         takeoverInput: "steer target"
      });

      const result = reduceTasksDashboardKey(state, { key: "enter" });
      expect(result.intent).toEqual({
         type: "takeover_control",
         id: "task-1",
         text: "steer target",
         mode: "steer"
      });
   });

   it("requestControl helper returns structured control request", () => {
      const req = requestControl("task-5", "cancel step", "steer");
      expect(req).toEqual({ id: "task-5", text: "cancel step", mode: "steer" });
   });

   it("'c' cancels job on jobs tab and stops process on processes tab", () => {
      // Jobs tab cancel
      let state = createTasksDashboardState({ activeTab: "jobs", selectedIndex: 0 });
      let ctx: DashboardContext = { jobs: [{ id: "task-10" }] };
      let res = reduceTasksDashboardKey(state, { key: "c" }, ctx);
      expect(res.intent).toEqual({ type: "cancel_job", id: "task-10" });

      // Processes tab stop
      state = createTasksDashboardState({ activeTab: "processes", selectedIndex: 0 });
      ctx = { processes: [{ name: "worker-1" }] };
      res = reduceTasksDashboardKey(state, { key: "c" }, ctx);
      expect(res.intent).toEqual({ type: "stop_process", name: "worker-1" });
   });

   it("'r' restarts process on processes tab", () => {
      const state = createTasksDashboardState({ activeTab: "processes", selectedIndex: 0 });
      const ctx: DashboardContext = { processes: [{ name: "worker-1" }] };
      const res = reduceTasksDashboardKey(state, { key: "r" }, ctx);
      expect(res.intent).toEqual({ type: "restart_process", name: "worker-1" });
   });

   it("Esc or q closes the dashboard", () => {
      const state = createTasksDashboardState();
      const resEsc = reduceTasksDashboardKey(state, { key: "escape" });
      expect(resEsc.state.isOpen).toBe(false);
      expect(resEsc.intent).toEqual({ type: "close" });

      const resQ = reduceTasksDashboardKey(state, { key: "q" });
      expect(resQ.state.isOpen).toBe(false);
      expect(resQ.intent).toEqual({ type: "close" });
   });
});
