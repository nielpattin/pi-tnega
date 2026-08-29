import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Task } from "../domain.js";

export const ASYNC_WORKER_WIDGET_KEY = "workers-async-workers";

export interface AsyncWorkerStatusSummary {
   readonly running: number;
   readonly completed: number;
   readonly failed: number;
   readonly recoverable: number;
   readonly activeNames: ReadonlyArray<string>;
}

/** Scope tasks to the current active runtime batches, excluding historical runs. */
export function scopeActiveRuntimeTasks(tasks: ReadonlyArray<Task>): ReadonlyArray<Task> {
   const activeTasks = tasks.filter((task) => task.status === "running" || task.status === "pending");
   if (activeTasks.length === 0) return [];
   const activeBatchIds = new Set(
      activeTasks
         .map((task) => task.batchId)
         .filter((batchId): batchId is string => typeof batchId === "string" && batchId.length > 0)
   );
   return tasks.filter(
      (task) =>
         (task.batchId !== undefined && activeBatchIds.has(task.batchId)) ||
         task.status === "running" ||
         task.status === "pending"
   );
}

/** Count workers and the names of those still in flight for the current runtime. */
export function summarizeAsyncWorkerStatus(tasks: ReadonlyArray<Task>): AsyncWorkerStatusSummary {
   const currentRuntimeTasks = scopeActiveRuntimeTasks(tasks);
   const running = currentRuntimeTasks.filter((task) => task.status === "running" || task.status === "pending").length;
   const completed = currentRuntimeTasks.filter((task) => task.status === "completed").length;
   const recoverable = currentRuntimeTasks.filter((task) => task.status === "recoverable").length;
   const failed = currentRuntimeTasks.filter((task) => task.status === "failed" || task.status === "cancelled").length;
   const activeNames = currentRuntimeTasks
      .filter((task) => task.status === "running" || task.status === "pending")
      .map((task) => task.name)
      .filter((name): name is string => Boolean(name));
   return { running, completed, failed, recoverable, activeNames };
}

/** Build a one-line above-editor widget factory for active workers. */
export function createAsyncWorkerWidget(tasks: ReadonlyArray<Task>): (tui: unknown, theme: Theme) => Component {
   const { running, completed, failed, recoverable, activeNames } = summarizeAsyncWorkerStatus(tasks);

   return (_tui: unknown, theme: Theme): Component => {
      return {
         render(width: number): string[] {
            const parts: string[] = [];
            if (completed > 0) parts.push(`${completed} done`);
            if (running > 0) parts.push(`${running} running`);
            if (recoverable > 0) parts.push(`${recoverable} recoverable`);
            if (failed > 0) parts.push(`${failed} failed`);
            if (parts.length === 0) parts.push("workers idle");

            let line = theme.fg("warning", "● ") + theme.fg("text", `workers ${parts.join(" · ")}`);
            const separator = " · ";
            const budget = width - visibleWidth(line) - visibleWidth(separator) - 1;

            if (activeNames.length > 0 && budget > 4) {
               const joined = activeNames.join(", ");
               const names = visibleWidth(joined) > budget ? truncateToWidth(joined, budget, "…", false) : joined;
               if (names.length > 0) {
                  line += theme.fg("dim", `${separator}${names}`);
               }
            }

            return [line];
         },
         invalidate() {}
      };
   };
}
