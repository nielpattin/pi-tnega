import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Job } from "../domain.js";

export const ASYNC_TASK_WIDGET_KEY = "harbor-async-tasks";

export interface AsyncTaskStatusSummary {
   readonly running: number;
   readonly completed: number;
   readonly failed: number;
   readonly activeNames: ReadonlyArray<string>;
}

/** Count async jobs and the names of those still in flight. */
export function summarizeAsyncTaskStatus(jobs: ReadonlyArray<Job>): AsyncTaskStatusSummary {
   const asyncJobs = jobs.filter((job) => job.async === true);
   const running = asyncJobs.filter((job) => job.status === "running" || job.status === "pending").length;
   const completed = asyncJobs.filter((job) => job.status === "completed").length;
   const failed = asyncJobs.filter((job) => job.status === "failed" || job.status === "cancelled").length;
   const activeNames = asyncJobs
      .filter((job) => job.status === "running" || job.status === "pending")
      .map((job) => job.name)
      .filter((name): name is string => Boolean(name));
   return { running, completed, failed, activeNames };
}

/** Build a one-line above-editor widget factory for active async task jobs. */
export function createAsyncTaskWidget(jobs: ReadonlyArray<Job>): (tui: unknown, theme: Theme) => Component {
   const { running, completed, failed, activeNames } = summarizeAsyncTaskStatus(jobs);

   return (_tui: unknown, theme: Theme): Component => {
      return {
         render(width: number): string[] {
            const parts: string[] = [`tasks ${running} running`];
            if (completed > 0) parts.push(`${completed} completed`);
            if (failed > 0) parts.push(`${failed} failed`);

            let line = theme.fg("warning", "● ") + theme.fg("text", parts.join(" · "));
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
