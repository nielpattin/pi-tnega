import * as path from "node:path";
import { mkdirSync } from "node:fs";
import {
   DefaultResourceLoader,
   getAgentDir,
   ProjectTrustStore,
   SessionManager,
   SettingsManager,
   type SessionShutdownEvent
} from "@earendil-works/pi-coding-agent";
import { ensureAutoCompactionEnabled } from "./compaction.ts";
import { deriveChildSessionDirectory } from "./child-session-dir.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless workflow children must not receive. */
export const CHILD_EXCLUDED_TOOL_NAMES = ["workflow", "ask_user"] as const;

/** Build the denylist for headless workflow children. */
export function childToolPolicy() {
   return { excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES] };
}

/** Options used to create resources for one isolated child session. */
export interface ChildResourceOptions {
   /** Working directory visible to the child. */
   readonly cwd: string;
   /** Whether the parent has trusted the working directory. */
   readonly projectTrusted: boolean;
   /** Optional system instructions appended to the child prompt. */
   readonly appendSystemPrompt?: ReadonlyArray<string>;
   /** Optional Pi agent directory override. */
   readonly agentDir?: string;
}

/**
 * Load child resources without executing ambient workspace extensions.
 *
 * @param options - Resource loading and trust options.
 * @returns The child resource loader and settings manager.
 */
export async function createChildResources(options: ChildResourceOptions) {
   const agentDir = options.agentDir ?? getAgentDir();
   const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: options.projectTrusted
   });
   ensureAutoCompactionEnabled(settingsManager);
   const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      ...(options.appendSystemPrompt ? { appendSystemPrompt: [...options.appendSystemPrompt] } : {})
   });
   await loader.reload();
   return { loader, settingsManager };
}

/**
 * Create a child session manager scoped to the parent Pi session when possible.
 *
 * Persistent parents receive a sibling child directory and an append-only Pi
 * session file. Ephemeral parents retain the in-memory fallback.
 *
 * @param cwd - Child working directory.
 * @param parentSessionFile - Persisted parent session file, when available.
 * @param sessionDirectory - Optional explicit child directory for tests or callers.
 * @returns A persistent or in-memory child session manager.
 */
export function createChildSessionManager(
   cwd: string,
   parentSessionFile: string | undefined,
   sessionDirectory?: string
): SessionManager {
   const childDirectory = sessionDirectory ?? deriveChildSessionDirectory(parentSessionFile);
   if (!childDirectory) return SessionManager.inMemory(cwd);
   mkdirSync(path.resolve(childDirectory), { recursive: true });
   return SessionManager.create(
      cwd,
      childDirectory,
      parentSessionFile ? { parentSession: path.resolve(parentSessionFile) } : undefined
   );
}

/**
 * Resolve trust for a standalone child working directory.
 *
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it.
 *
 * @param options - Parent and child trust context.
 * @returns Whether the child may use the alternate working directory.
 */
export function resolveStandaloneChildProjectTrust(options: {
   readonly parentCwd: string;
   readonly childCwd: string;
   readonly parentTrusted: boolean;
   readonly agentDir?: string;
}) {
   if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
      return options.parentTrusted;
   }
   try {
      const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
      return trustStore.get(options.childCwd) === true;
   } catch {
      return false;
   }
}

interface ChildExtensionRunner {
   hasHandlers(eventType: string): boolean;
   emit(event: SessionShutdownEvent): Promise<unknown>;
}

/** A child session that can be shut down and disposed safely. */
export interface DisposableChildSession {
   readonly extensionRunner: ChildExtensionRunner;
   dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
   let timer: ReturnType<typeof setTimeout> | undefined;
   const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
   });
   return Promise.race([
      operation.then(
         () => undefined,
         () => undefined
      ),
      timeout
   ])
      .catch(() => {})
      .finally(() => {
         if (timer) clearTimeout(timer);
      });
}

/**
 * Emit child shutdown once, then dispose once.
 *
 * @param session - The child session to shut down.
 * @param options - Optional shutdown timeout.
 * @returns A promise that settles after bounded cleanup.
 */
export function shutdownAndDisposeChildSession(
   session: DisposableChildSession,
   options: { readonly timeoutMs?: number } = {}
) {
   const existing = childShutdowns.get(session);
   if (existing) return existing;

   const shutdown = (async () => {
      try {
         if (session.extensionRunner.hasHandlers("session_shutdown")) {
            await waitBounded(
               session.extensionRunner.emit({
                  type: "session_shutdown",
                  reason: "quit"
               }),
               options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS
            );
         }
      } catch {
         // Cleanup is best effort and disposal must remain terminal.
      } finally {
         try {
            session.dispose();
         } catch {
            // Disposal is idempotent at the session boundary.
         }
      }
   })();

   childShutdowns.set(session, shutdown);
   return shutdown;
}
