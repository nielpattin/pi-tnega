import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWatcherWidget, startSidecarIfIndexed, WATCHER_WIDGET_KEY } from "./watcher.js";

afterEach(() => {
   vi.useRealTimers();
});

describe("watcher widget", () => {
   it("starts the sidecar only when the project has an index database", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-cortex-watcher-"));
      const dbPath = join(dir, "pi-cortex.db");
      let starts = 0;
      try {
         expect(await startSidecarIfIndexed(dbPath, async () => {
            starts++;
         })).toBe(false);
         expect(starts).toBe(0);

         writeFileSync(dbPath, "indexed");
         expect(await startSidecarIfIndexed(dbPath, async () => {
            starts++;
         })).toBe(true);
         expect(starts).toBe(1);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it("shows one concise update notice for five seconds", () => {
      vi.useFakeTimers();
      const widgets: Array<{ key: string; content: string[] | undefined }> = [];
      const ui = {
         setWidget(key: string, content: string[] | undefined) {
            widgets.push({ key, content });
         }
      };
      const watcher = createWatcherWidget(ui);

      watcher.append({ action: "reindexed", file: "src/main.ts", chunks: 3 });

      expect(widgets.at(-1)).toEqual({ key: WATCHER_WIDGET_KEY, content: ["Cortex index updated"] });
      vi.advanceTimersByTime(4999);
      expect(widgets.at(-1)).toEqual({ key: WATCHER_WIDGET_KEY, content: ["Cortex index updated"] });
      vi.advanceTimersByTime(1);
      expect(widgets.at(-1)).toEqual({ key: WATCHER_WIDGET_KEY, content: undefined });
   });

   it("waits until the agent loop ends before showing an update", () => {
      const widgets: Array<{ key: string; content: string[] | undefined }> = [];
      const ui = {
         setWidget(key: string, content: string[] | undefined) {
            widgets.push({ key, content });
         }
      };
      const watcher = createWatcherWidget(ui);

      watcher.agentStart();
      watcher.append({ action: "removed", file: "src/old.ts", chunks: 1 });
      expect(widgets).toHaveLength(0);

      watcher.agentEnd();

      expect(widgets.at(-1)).toEqual({ key: WATCHER_WIDGET_KEY, content: ["Cortex index updated"] });
   });

   it("clears the widget and pending update", () => {
      const widgets: Array<{ key: string; content: string[] | undefined }> = [];
      const ui = {
         setWidget(key: string, content: string[] | undefined) {
            widgets.push({ key, content });
         }
      };
      const watcher = createWatcherWidget(ui);

      watcher.agentStart();
      watcher.append({ action: "reindexed" });
      watcher.clear();
      watcher.agentEnd();

      expect(widgets).toEqual([{ key: WATCHER_WIDGET_KEY, content: undefined }]);
   });
});
