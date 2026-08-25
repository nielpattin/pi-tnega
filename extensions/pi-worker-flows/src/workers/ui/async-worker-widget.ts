import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Job } from "../domain.js";

export const ASYNC_WORKER_WIDGET_KEY = "workers-async-workers";

export interface AsyncWorkerStatusSummary {
   readonly running: number;
   readonly completed: number;
   readonly failed: number;
   readonly activeNames: ReadonlyArray<string>;
}

/** Count workers and the names of those still in flight. */
export function summarizeAsyncWorkerStatus(jobs: ReadonlyArray<Job>): AsyncWorkerStatusSummary {
   const running = jobs.filter((job) => job.status === "running" || job.status === "pending").length;
   const completed = jobs.filter((job) => job.status === "completed").length;
   const failed = jobs.filter((job) => job.status === "failed" || job.status === "cancelled").length;
   const activeNames = jobs
      .filter((job) => job.status === "running" || job.status === "pending")
      .map((job) => job.name)
      .filter((name): name is string => Boolean(name));
   return { running, completed, failed, activeNames };
}

/** Build a one-line above-editor widget factory for active workers. */
export function createAsyncWorkerWidget(jobs: ReadonlyArray<Job>): (tui: unknown, theme: Theme) => Component {
   const { running, completed, failed, activeNames } = summarizeAsyncWorkerStatus(jobs);

   return (_tui: unknown, theme: Theme): Component => {
      return {
         render(width: number): string[] {
            const parts: string[] = [];
            if (completed > 0) parts.push(`${completed} done`);
            if (running > 0) parts.push(`${running} running`);
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
