import { existsSync } from "node:fs";

/** Key for the transient watcher notice widget. */
export const WATCHER_WIDGET_KEY = "pi-cortex-watcher";

/** UI capability required to render the transient watcher notice. */
export interface WatcherWidgetUi {
   /** Set or clear a widget above or below the editor. */
   setWidget(
      key: string,
      content: string[] | undefined,
      options?: { readonly placement?: "aboveEditor" | "belowEditor" }
   ): void;
}

/** Operations for the current session's transient watcher notice. */
export interface WatcherWidget {
   /** Record a sidecar watcher event. */
   append(event: Record<string, unknown>): void;
   /** Mark the beginning of an agent loop. */
   agentStart(): void;
   /** Mark the end of an agent loop and show any pending update. */
   agentEnd(): void;
   /** Clear the notice and any pending update. */
   clear(): void;
}

const NOTICE_DURATION_MS = 5000;
const UPDATED_NOTICE = "Cortex index updated";
const FAILED_NOTICE = "Cortex index update failed";
type WatcherNotice = typeof UPDATED_NOTICE | typeof FAILED_NOTICE;

function noticeFor(event: Record<string, unknown>): WatcherNotice | undefined {
   switch (event.action) {
      case "reindexed":
      case "removed":
         return UPDATED_NOTICE;
      case "failed":
         return FAILED_NOTICE;
      default:
         return undefined;
   }
}

/**
 * Start a sidecar when a project database already exists.
 *
 * @param dbPath - Project database path.
 * @param startSidecar - Sidecar startup operation.
 * @returns `true` when startup was requested, otherwise `false`.
 */
export async function startSidecarIfIndexed(dbPath: string, startSidecar: () => Promise<void>): Promise<boolean> {
   if (!existsSync(dbPath)) return false;
   await startSidecar();
   return true;
}

/**
 * Create a transient watcher notice that is deferred until an agent loop ends.
 *
 * @param ui - Pi's widget UI capability.
 * @returns Controls for recording watcher events and managing the notice.
 */
export function createWatcherWidget(ui: WatcherWidgetUi): WatcherWidget {
   let agentRunning = false;
   let pendingNotice: WatcherNotice | undefined;
   let hideTimer: ReturnType<typeof setTimeout> | undefined;

   const hide = (): void => {
      hideTimer = undefined;
      ui.setWidget(WATCHER_WIDGET_KEY, undefined);
   };

   const show = (notice: WatcherNotice): void => {
      if (hideTimer !== undefined) clearTimeout(hideTimer);
      ui.setWidget(WATCHER_WIDGET_KEY, [notice], { placement: "aboveEditor" });
      hideTimer = setTimeout(hide, NOTICE_DURATION_MS);
   };

   return {
      append(event) {
         const notice = noticeFor(event);
         if (notice === undefined) return;
         if (notice === FAILED_NOTICE || pendingNotice === undefined) pendingNotice = notice;

         if (!agentRunning) {
            const nextNotice = pendingNotice;
            pendingNotice = undefined;
            if (nextNotice !== undefined) show(nextNotice);
         }
      },
      agentStart() {
         agentRunning = true;
      },
      agentEnd() {
         agentRunning = false;
         const nextNotice = pendingNotice;
         pendingNotice = undefined;
         if (nextNotice !== undefined) show(nextNotice);
      },
      clear() {
         if (hideTimer !== undefined) clearTimeout(hideTimer);
         hideTimer = undefined;
         pendingNotice = undefined;
         agentRunning = false;
         ui.setWidget(WATCHER_WIDGET_KEY, undefined);
      }
   };
}
