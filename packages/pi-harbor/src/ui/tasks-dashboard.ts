/**
 * Pure state machine and reducer for /tasks TUI dashboard overlay.
 */

export type DashboardTab = "jobs" | "bash" | "processes" | "logs" | "takeover";

export interface TasksDashboardState {
   activeTab: DashboardTab;
   selectedIndex: number;
   isOpen: boolean;
   takeoverJobId?: string;
   logProcessName?: string;
   takeoverInput?: string;
}

export interface KeyInput {
   key: string;
   shift?: boolean;
   alt?: boolean;
   ctrl?: boolean;
}

export interface DashboardContext {
   itemCount?: number;
   jobs?: Array<{ id: string; [key: string]: any }>;
   processes?: Array<{ name: string; [key: string]: any }>;
   inputText?: string;
}

export type DashboardIntent =
   | { type: "takeover_control"; id: string; text: string; mode: "steer" | "followUp" }
   | { type: "cancel_job"; id: string }
   | { type: "stop_process"; name: string }
   | { type: "restart_process"; name: string }
   | { type: "close" }
   | { type: "none" };

export const DASHBOARD_TABS: DashboardTab[] = ["jobs", "bash", "processes", "logs", "takeover"];

export function createTasksDashboardState(initial?: Partial<TasksDashboardState>): TasksDashboardState {
   return {
      activeTab: "jobs",
      selectedIndex: 0,
      isOpen: true,
      ...initial
   };
}

export function requestControl(id: string, text: string, mode: "steer" | "followUp") {
   return { id, text, mode };
}

export function reduceTasksDashboardKey(
   state: TasksDashboardState,
   input: KeyInput,
   context?: DashboardContext
): { state: TasksDashboardState; intent?: DashboardIntent } {
   const key = input.key.toLowerCase();

   if (key === "escape" || key === "q") {
      return {
         state: { ...state, isOpen: false },
         intent: { type: "close" }
      };
   }

   if (key === "tab") {
      const idx = DASHBOARD_TABS.indexOf(state.activeTab);
      let nextIdx: number;
      if (input.shift) {
         nextIdx = (idx - 1 + DASHBOARD_TABS.length) % DASHBOARD_TABS.length;
      } else {
         nextIdx = (idx + 1) % DASHBOARD_TABS.length;
      }
      return {
         state: {
            ...state,
            activeTab: DASHBOARD_TABS[nextIdx],
            selectedIndex: 0
         }
      };
   }

   if (key === "down" || key === "j") {
      let maxCount = context?.itemCount;
      if (maxCount === undefined) {
         if (state.activeTab === "jobs" && context?.jobs) {
            maxCount = context.jobs.length;
         } else if ((state.activeTab === "processes" || state.activeTab === "bash") && context?.processes) {
            maxCount = context.processes.length;
         }
      }
      const nextIndex =
         maxCount !== undefined && maxCount > 0
            ? Math.min(state.selectedIndex + 1, maxCount - 1)
            : state.selectedIndex + 1;
      return {
         state: { ...state, selectedIndex: nextIndex }
      };
   }

   if (key === "up" || key === "k") {
      return {
         state: { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) }
      };
   }

   if (key === "enter") {
      if (input.alt) {
         if (state.activeTab === "jobs" && context?.jobs && context.jobs[state.selectedIndex]) {
            const job = context.jobs[state.selectedIndex];
            return {
               state,
               intent: {
                  type: "takeover_control",
                  id: job.id,
                  text: context.inputText ?? state.takeoverInput ?? "",
                  mode: "followUp"
               }
            };
         }
      } else {
         if (state.activeTab === "jobs") {
            const job = context?.jobs?.[state.selectedIndex];
            if (job) {
               return {
                  state: {
                     ...state,
                     activeTab: "takeover",
                     takeoverJobId: job.id
                  }
               };
            }
         } else if (state.activeTab === "processes" || state.activeTab === "bash") {
            const proc = context?.processes?.[state.selectedIndex];
            if (proc) {
               return {
                  state: {
                     ...state,
                     activeTab: "logs",
                     logProcessName: proc.name
                  }
               };
            }
         } else if (state.activeTab === "takeover") {
            const jobId = state.takeoverJobId;
            const text = context?.inputText ?? state.takeoverInput ?? "";
            if (jobId) {
               return {
                  state,
                  intent: {
                     type: "takeover_control",
                     id: jobId,
                     text,
                     mode: "steer"
                  }
               };
            }
         }
      }
   }

   if (key === "c") {
      if (state.activeTab === "jobs" && context?.jobs && context.jobs[state.selectedIndex]) {
         return {
            state,
            intent: { type: "cancel_job", id: context.jobs[state.selectedIndex].id }
         };
      }
      if (
         (state.activeTab === "processes" || state.activeTab === "bash") &&
         context?.processes &&
         context.processes[state.selectedIndex]
      ) {
         return {
            state,
            intent: { type: "stop_process", name: context.processes[state.selectedIndex].name }
         };
      }
   }

   if (key === "r") {
      if (
         (state.activeTab === "processes" || state.activeTab === "bash") &&
         context?.processes &&
         context.processes[state.selectedIndex]
      ) {
         return {
            state,
            intent: { type: "restart_process", name: context.processes[state.selectedIndex].name }
         };
      }
   }

   return { state };
}
