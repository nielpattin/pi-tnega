import { Context, Effect, Layer } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveChildSessionDirectory } from "../../shared/child-session-dir.ts";
import { ManifestPersistenceError, ManifestSerializationError, type Task } from "../domain.js";
import {
   WORKERS_TASK_MANIFEST_VERSION,
   WORKERS_TASK_MANIFEST_LIMITS,
   buildPersistedIndex,
   parsePersistedIndex,
   type WorkersTaskIndex
} from "./workers-task-manifest.js";

export const WORKERS_TASKS_FILE = "workers-tasks.json";
/** Legacy manifest name still read for migration from earlier versions. */
export const WORKERS_LEGACY_TASKS_FILE = "workers-jobs.json";
export { WORKERS_TASK_MANIFEST_VERSION as WORKERS_TASKS_VERSION };
export { WORKERS_TASK_MANIFEST_LIMITS };
export { computeReservedTaskSeq as computeNextTaskSeq } from "./workers-task-manifest.js";

const RESTART_INTERRUPTED_ERROR =
   "Workers parent session restarted before this Task settled. The Task was left recoverable; resume it with worker_recover.";

const MAX_REPLACE_ATTEMPTS = 5;
const RETRY_BASE_MS = 5;
const RETRY_MAX_MS = 80;

/** Narrow filesystem capability used by Workers Task persistence. */
export interface WorkersFileSystem {
   readonly mkdir: (dir: string) => Promise<void>;
   readonly readdir: (dir: string) => Promise<ReadonlyArray<string>>;
   readonly readFile: (path: string) => Promise<string | undefined>;
   readonly writeFile: (path: string, data: string, options?: { readonly flag?: "w" | "wx" }) => Promise<void>;
   readonly rename: (oldPath: string, newPath: string) => Promise<void>;
   readonly unlink: (path: string) => Promise<void>;
   /** Best-effort durability flush for a file. Implementations may no-op when unsupported. */
   readonly sync: (path: string) => Promise<void>;
   /** Best-effort durability flush for a directory. Implementations may no-op when unsupported. */
   readonly syncDir: (dir: string) => Promise<void>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
   return error instanceof Error && "code" in error && typeof error.code === "string";
}

function isRetryableError(error: unknown): boolean {
   if (!isNodeError(error)) return false;
   const code = error.code;
   return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function backoffMs(attempt: number): number {
   return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

const nodeFileSystem: WorkersFileSystem = {
   mkdir: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
   },
   readdir: async (dir) => fs.readdir(dir),
   readFile: async (filePath) => {
      try {
         return await fs.readFile(filePath, "utf8");
      } catch (error) {
         if (isNodeError(error) && error.code === "ENOENT") return undefined;
         throw error;
      }
   },
   writeFile: async (filePath, data, options) => {
      await fs.writeFile(filePath, data, { encoding: "utf8", flag: options?.flag });
   },
   rename: async (oldPath, newPath) => {
      await fs.rename(oldPath, newPath);
   },
   unlink: async (filePath) => {
      await fs.unlink(filePath);
   },
   sync: async (filePath) => {
      try {
         const fd = await fs.open(filePath, "r");
         try {
            await fd.sync();
         } finally {
            await fd.close();
         }
      } catch {
         // fsync is optional; some platforms or filesystems do not support it.
      }
   },
   syncDir: async (dir) => {
      try {
         const fd = await fs.open(dir, "r");
         try {
            await fd.sync();
         } finally {
            await fd.close();
         }
      } catch {
         // Directory fsync is optional; some platforms or filesystems do not support it.
      }
   }
};

export interface WorkersTaskPersistenceShape {
   readonly configure: (parentSessionFile: string | undefined | null) => Effect.Effect<void, ManifestPersistenceError>;
   readonly currentTarget: () => Effect.Effect<string | undefined>;
   readonly currentDir: () => Effect.Effect<string | undefined>;
   readonly takeChangeListener: () => Effect.Effect<(() => void) | undefined>;
   readonly setChangeListener: (unsubscribe: (() => void) | undefined) => Effect.Effect<void>;
   readonly takeChangeWriter: () => Effect.Effect<RegistryChangeWriter | undefined>;
   readonly setChangeWriter: (writer: RegistryChangeWriter | undefined) => Effect.Effect<void>;
   readonly load: () => Effect.Effect<WorkersTaskIndex, ManifestPersistenceError>;
   readonly persist: (
      jobs: ReadonlyArray<Task>
   ) => Effect.Effect<void, ManifestSerializationError | ManifestPersistenceError>;
   readonly flush: () => Effect.Effect<void, ManifestPersistenceError>;
}

export class WorkersTaskPersistence extends Context.Service<WorkersTaskPersistence, WorkersTaskPersistenceShape>()(
   "workers/services/WorkersTaskPersistence"
) {
   static readonly layer = Layer.effect(
      WorkersTaskPersistence,
      Effect.sync(() => makeWorkersTaskPersistenceShape(nodeFileSystem))
   );

   static layerWith(fileSystem: WorkersFileSystem): Layer.Layer<WorkersTaskPersistence> {
      return Layer.effect(
         WorkersTaskPersistence,
         Effect.sync(() => makeWorkersTaskPersistenceShape(fileSystem))
      );
   }
}

export interface RegistryChangeWriter {
   readonly schedule: (jobs: ReadonlyArray<Task>) => void;
   readonly flush: () => Promise<void>;
}

function makeWorkersTaskPersistenceShape(fileSystem: WorkersFileSystem): WorkersTaskPersistenceShape {
   let indexDir: string | undefined;
   let configuredParentSessionFile: string | undefined;
   let changeListenerUnsubscribe: (() => void) | undefined;
   let changeWriter: RegistryChangeWriter | undefined;
   let writeLock = Promise.resolve<void>(undefined);

   const resolveFinalPath = (): string | undefined => {
      if (!indexDir) return undefined;
      return path.join(indexDir, WORKERS_TASKS_FILE);
   };

   const resolveLegacyFinalPath = (): string | undefined => {
      if (!indexDir) return undefined;
      return path.join(indexDir, WORKERS_LEGACY_TASKS_FILE);
   };

   const makeArtifactPath = (finalPath: string, suffix: "tmp" | "bak" | "corrupt"): string => {
      const dir = path.dirname(finalPath);
      const base = path.basename(finalPath);
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      return path.join(dir, `${base}.${suffix}-${nonce}`);
   };

   const fileExists = async (filePath: string): Promise<boolean> => {
      try {
         const content = await fileSystem.readFile(filePath);
         return content !== undefined;
      } catch {
         return false;
      }
   };

   /**
    * Atomically replace finalPath with the contents of a freshly written temp file.
    *
    * Algorithm:
    * 1. Create a temp file in the same directory with an exclusive flag so a
    *    crash-leftover temp with the same name cannot be silently overwritten.
    * 2. Sync the temp file when the filesystem supports it.
    * 3. Attempt to rename temp -> final. On POSIX this replaces the target
    *    atomically. On Windows this can fail with EPERM/EBUSY when another
    *    process holds the destination open.
    * 4. If the direct rename fails with a retryable sharing/permission error and
    *    the destination exists, perform a Windows-safe replacement: rename the
    *    existing destination to a backup path, then rename the temp file into
    *    place. If the temp -> final rename fails, restore the backup so the
    *    manifest is never left absent.
    * 5. Retry the whole attempt up to MAX_REPLACE_ATTEMPTS with exponential
    *    backoff capped at RETRY_MAX_MS for EPERM/EACCES/EBUSY.
    * 6. Clean up temp files and, on success, backup files in a finally block.
    *    If replacement ultimately fails and the backup could not be restored,
    *    the backup file is preserved as the last known good manifest.
    */
   const atomicReplace = async (finalPath: string, data: string): Promise<void> => {
      let lastError: unknown = new Error("Atomic manifest replacement did not complete.");

      async function tryReplace(attempt: number): Promise<boolean> {
         if (attempt > MAX_REPLACE_ATTEMPTS) return false;
         const tmpPath = makeArtifactPath(finalPath, "tmp");
         const backupPath = makeArtifactPath(finalPath, "bak");
         let wroteTemp = false;
         let wroteBackup = false;
         let attemptError: unknown;

         try {
            await fileSystem.writeFile(tmpPath, data, { flag: "wx" });
            wroteTemp = true;
            await fileSystem.sync(tmpPath).catch(() => {});

            try {
               await fileSystem.rename(tmpPath, finalPath);
            } catch (directErr) {
               const finalExists = await fileExists(finalPath);
               if (!isRetryableError(directErr) || !finalExists) {
                  throw directErr;
               }

               let backupMade = false;
               await fileSystem.rename(finalPath, backupPath);
               await fileSystem.syncDir(path.dirname(finalPath)).catch(() => {});
               wroteBackup = true;
               backupMade = true;

               try {
                  await fileSystem.rename(tmpPath, finalPath);
               } catch (innerErr) {
                  if (backupMade) {
                     try {
                        await fileSystem.rename(backupPath, finalPath);
                        wroteBackup = false;
                     } catch {
                        // Leave backup in place as the last known good manifest.
                     }
                  }
                  throw innerErr;
               }
            }
            // Fsync the directory after temp->final or backup->final renames
            // so the new manifest is committed before cleanup removes artifacts.
            await fileSystem.syncDir(path.dirname(finalPath)).catch(() => {});
         } catch (error) {
            attemptError = error;
         } finally {
            if (wroteTemp) {
               await fileSystem.unlink(tmpPath).catch(() => {});
            }
            if (wroteBackup) {
               // Only clean up the backup if the original manifest was successfully
               // restored. If restoration failed, preserve the backup as the last
               // known good manifest.
               const finalExists = await fileExists(finalPath);
               if (finalExists) {
                  await fileSystem.unlink(backupPath).catch(() => {});
               }
            }
         }

         if (attemptError === undefined) return true;
         lastError = attemptError;
         if (attempt < MAX_REPLACE_ATTEMPTS && isRetryableError(attemptError)) {
            await sleep(backoffMs(attempt));
            return tryReplace(attempt + 1);
         }
         return false;
      }

      const succeeded = await tryReplace(1);
      if (!succeeded) throw lastError;
   };

   const isTempArtifact = (entry: string): boolean =>
      entry.startsWith(`${WORKERS_TASKS_FILE}.tmp-`) || entry.startsWith(`${WORKERS_TASKS_FILE}.bak-`);
   const isBackupArtifact = (entry: string): boolean => entry.startsWith(`${WORKERS_TASKS_FILE}.bak-`);

   const cleanupTempArtifacts = async (dir: string): Promise<void> => {
      const entries = await fileSystem.readdir(dir).catch((): ReadonlyArray<string> => []);
      await Promise.all(
         entries
            .filter((entry) => isTempArtifact(entry))
            .map((entry) => fileSystem.unlink(path.join(dir, entry)).catch(() => {}))
      );
   };

   const quarantineFile = async (filePath: string) => {
      try {
         if ((await fileSystem.readFile(filePath)) === undefined) return;
         const preservedPath = makeArtifactPath(filePath, "corrupt");
         await fileSystem.rename(filePath, preservedPath);
      } catch {
         // File does not exist or is unreadable; nothing to preserve.
      }
   };

   const backupTimestamp = (entry: string): number => {
      const prefix = `${WORKERS_TASKS_FILE}.bak-`;
      const rest = entry.slice(prefix.length);
      const dash = rest.indexOf("-");
      const ts = dash >= 0 ? rest.slice(0, dash) : rest;
      const n = Number(ts);
      return Number.isFinite(n) ? n : 0;
   };

   const syncDirectory = async (dir: string): Promise<void> => {
      await fileSystem.syncDir(dir).catch(() => {});
   };

   /**
    * Reconcile backup artifacts when a parent session is configured. Never
    * blindly delete backups: if the final manifest is missing or invalid, find
    * the newest valid backup and restore it; quarantine invalid backup
    * candidates. If the final manifest is already valid, the backups are stale
    * and can be removed.
    */
   const reconcileBackupsAtConfigure = async (dir: string): Promise<void> => {
      const finalPath = resolveFinalPath();
      if (!finalPath) return;

      const entries = await fileSystem.readdir(dir).catch((): ReadonlyArray<string> => []);
      const backups = entries.filter(isBackupArtifact);
      // Newest backup first (timestamps are embedded in the filename by makeArtifactPath).
      backups.sort((a, b) => backupTimestamp(b) - backupTimestamp(a));

      const finalIndex = await readIndexFromDisk(finalPath);

      if (finalIndex) {
         // Final is valid: stale backups can be cleaned up safely.
         await Promise.all(backups.map((entry) => fileSystem.unlink(path.join(dir, entry)).catch(() => {})));
         await syncDirectory(dir);
         return;
      }

      // Final is missing or structurally invalid: quarantine it and look for a
      // last-known-good backup.
      await quarantineFile(finalPath);

      const backupChecks = await Promise.all(
         backups.map(async (entry) => {
            const backupPath = path.join(dir, entry);
            const backupIndex = await readIndexFromDisk(backupPath);
            return { backupPath, backupIndex };
         })
      );

      let newestValidBackupPath: string | undefined;
      const olderBackupPaths: string[] = [];
      const invalidBackupPaths: string[] = [];
      for (const { backupPath, backupIndex } of backupChecks) {
         if (backupIndex) {
            if (newestValidBackupPath === undefined) {
               newestValidBackupPath = backupPath;
            } else {
               // Older valid backups are stale once the newest valid one is chosen.
               olderBackupPaths.push(backupPath);
            }
         } else {
            invalidBackupPaths.push(backupPath);
         }
      }
      await Promise.all(invalidBackupPaths.map((backupPath) => quarantineFile(backupPath)));
      await Promise.all(olderBackupPaths.map((backupPath) => fileSystem.unlink(backupPath).catch(() => {})));

      if (newestValidBackupPath) {
         await fileSystem.rename(newestValidBackupPath, finalPath);
      }

      await syncDirectory(dir);
   };

   const readIndexFromDisk = async (filePath: string): Promise<WorkersTaskIndex | undefined> => {
      try {
         const text = await fileSystem.readFile(filePath);
         if (text === undefined) return undefined;
         if (Buffer.byteLength(text, "utf8") > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedManifestBytes) return undefined;
         const parsed = JSON.parse(text) as unknown;
         if (!parsed || typeof parsed !== "object") return undefined;
         return parsePersistedIndex(parsed as Record<string, unknown>);
      } catch {
         return undefined;
      }
   };

   /**
    * Migrate a legacy workers-jobs.json manifest into the new tasks file.
    *
    * The legacy parser accepts both `agent`/`worker` fields and legacy ids,
    * so the persisted records are already normalized. When the legacy file is
    * the only manifest, promote it and keep the old file as a backup.
    */
   const migrateLegacyManifestIfNeeded = async (dir: string): Promise<void> => {
      const finalPath = resolveFinalPath();
      if (!finalPath) return;
      const legacyPath = resolveLegacyFinalPath();
      if (!legacyPath) return;

      const legacyText = await fileSystem.readFile(legacyPath);
      if (legacyText !== undefined) {
         const finalText = await fileSystem.readFile(finalPath);
         if (finalText === undefined) {
            try {
               await fileSystem.rename(legacyPath, finalPath);
               await syncDirectory(dir);
            } catch {
               // Keep both files; configure/load falls back to the legacy path.
            }
         }
      }
   };

   const configure: WorkersTaskPersistenceShape["configure"] = Effect.fn("WorkersTaskPersistence.configure")(
      (parentSessionFile) =>
         Effect.gen(function* () {
            // A configure call always replaces the previous target, including when
            // the new parent is ephemeral or malformed. Clear first so an invalid
            // truthy path can never continue writing into the previous parent.
            indexDir = undefined;
            configuredParentSessionFile = undefined;

            if (!parentSessionFile) return;
            const dir = deriveChildSessionDirectory(parentSessionFile);
            if (!dir) return;
            yield* Effect.promise(() => fileSystem.mkdir(dir));
            yield* Effect.promise(() => cleanupTempArtifacts(dir));
            yield* Effect.promise(() => migrateLegacyManifestIfNeeded(dir));
            indexDir = dir;
            configuredParentSessionFile = parentSessionFile;
            yield* Effect.promise(() => reconcileBackupsAtConfigure(dir));
         })
   );

   const currentTarget: WorkersTaskPersistenceShape["currentTarget"] = Effect.fn(
      "WorkersTaskPersistence.currentTarget"
   )(() => Effect.succeed(configuredParentSessionFile));

   const takeChangeListener: WorkersTaskPersistenceShape["takeChangeListener"] = Effect.fn(
      "WorkersTaskPersistence.takeChangeListener"
   )(() =>
      Effect.sync(() => {
         const unsub = changeListenerUnsubscribe;
         changeListenerUnsubscribe = undefined;
         return unsub;
      })
   );

   const setChangeListener: WorkersTaskPersistenceShape["setChangeListener"] = Effect.fn(
      "WorkersTaskPersistence.setChangeListener"
   )((unsubscribe: (() => void) | undefined) =>
      Effect.sync(() => {
         changeListenerUnsubscribe = unsubscribe;
      })
   );

   const takeChangeWriter: WorkersTaskPersistenceShape["takeChangeWriter"] = Effect.fn(
      "WorkersTaskPersistence.takeChangeWriter"
   )(() =>
      Effect.sync(() => {
         const writer = changeWriter;
         changeWriter = undefined;
         return writer;
      })
   );

   const setChangeWriter: WorkersTaskPersistenceShape["setChangeWriter"] = Effect.fn(
      "WorkersTaskPersistence.setChangeWriter"
   )((writer: RegistryChangeWriter | undefined) =>
      Effect.sync(() => {
         changeWriter = writer;
      })
   );

   const currentDir: WorkersTaskPersistenceShape["currentDir"] = Effect.fn("WorkersTaskPersistence.currentDir")(() =>
      Effect.succeed(indexDir)
   );

   const load: WorkersTaskPersistenceShape["load"] = Effect.fn("WorkersTaskPersistence.load")(() =>
      Effect.gen(function* () {
         const finalPath = resolveFinalPath();
         const legacyPath = resolveLegacyFinalPath();
         if (!finalPath) {
            return { version: WORKERS_TASK_MANIFEST_VERSION, jobs: [] as Task[] };
         }

         const parsed = yield* Effect.promise(() => readIndexFromDisk(finalPath));
         if (parsed) return parsed;

         // Fall back to the legacy manifest, which parsePersistedIndex accepts.
         if (legacyPath) {
            const legacyParsed = yield* Effect.promise(() => readIndexFromDisk(legacyPath));
            if (legacyParsed) return legacyParsed;
         }

         // Missing or structurally invalid index: quarantine any existing bytes
         // before returning an empty recovery set.
         yield* Effect.promise(() => quarantineFile(finalPath));
         const dir = path.dirname(finalPath);
         yield* Effect.promise(() => syncDirectory(dir));
         return { version: WORKERS_TASK_MANIFEST_VERSION, source: "missing", jobs: [] as Task[] };
      })
   );

   const persist: WorkersTaskPersistenceShape["persist"] = Effect.fn("WorkersTaskPersistence.persist")((jobs) =>
      Effect.gen(function* () {
         const finalPath = resolveFinalPath();
         if (!finalPath) return yield* Effect.void;

         let data: string;
         try {
            const { index } = buildPersistedIndex(jobs, configuredParentSessionFile);
            data = JSON.stringify(index, undefined, 2);
            if (Buffer.byteLength(data, "utf8") > WORKERS_TASK_MANIFEST_LIMITS.maxPersistedManifestBytes) {
               throw new Error("Serialized workers jobs manifest exceeds maxPersistedManifestBytes");
            }
         } catch (error) {
            return yield* new ManifestSerializationError({
               message:
                  error instanceof Error
                     ? `Failed to serialize workers jobs manifest: ${error.message}`
                     : "Failed to serialize workers jobs manifest",
               cause: error
            });
         }

         // Serialize writes through a promise chain so concurrent transitions
         // queue rather than interleave on disk.
         const runWrite = async () => {
            await atomicReplace(finalPath, data);
         };

         const next = writeLock.then(runWrite, runWrite);
         writeLock = next;
         yield* Effect.tryPromise({
            try: () => next,
            catch: (error) =>
               new ManifestPersistenceError({
                  message:
                     error instanceof Error
                        ? `Failed to persist workers jobs manifest: ${error.message}`
                        : "Failed to persist workers jobs manifest",
                  cause: error
               })
         });
         return yield* Effect.void;
      })
   );

   const flush: WorkersTaskPersistenceShape["flush"] = Effect.fn("WorkersTaskPersistence.flush")(() =>
      Effect.gen(function* () {
         yield* Effect.tryPromise({
            try: () => writeLock,
            catch: (error) =>
               new ManifestPersistenceError({
                  message:
                     error instanceof Error
                        ? `Failed to flush workers jobs manifest: ${error.message}`
                        : "Failed to flush workers jobs manifest",
                  cause: error
               })
         });
      })
   );

   return WorkersTaskPersistence.of({
      configure,
      currentTarget,
      currentDir,
      takeChangeListener,
      setChangeListener,
      takeChangeWriter,
      setChangeWriter,
      load,
      persist,
      flush
   });
}

/**
 * Create a coalescing writer for registry-change events.
 *
 * Most metadata updates are debounced so rapid changes do not hammer the
 * filesystem. Newly registered jobs and terminal transitions are persisted
 * immediately so register/complete/fail/cancel
 * events survive a crash. Call {@link RegistryChangeWriter.flush} during
 * session shutdown to guarantee any pending debounced write lands on disk.
 */
export function createRegistryChangeWriter(persistence: WorkersTaskPersistenceShape): RegistryChangeWriter {
   let lastSnapshot: ReadonlyArray<Task> | undefined;
   let pending: { jobs: ReadonlyArray<Task>; immediate: boolean } | undefined;
   let timer: ReturnType<typeof setTimeout> | undefined;
   let inFlight: Promise<void> | undefined;
   let flushWaiters: Array<() => void> = [];

   const isTerminal = (task: Task) =>
      task.status === "completed" || task.status === "failed" || task.status === "cancelled";

   const snapshotContains = (snapshot: ReadonlyArray<Task>, id: string) => snapshot.some((task) => task.id === id);

   const logPersistError = (error: unknown) => {
      try {
         const message = error instanceof Error ? error.message : String(error);
         console.error(`[workers] failed to persist Task manifest: ${message}`);
      } catch {
         // Logging must not break registry change delivery.
      }
   };

   const scheduleWrite = (jobs: ReadonlyArray<Task>, immediate: boolean) => {
      pending = { jobs, immediate };
      if (timer !== undefined) {
         clearTimeout(timer);
         timer = undefined;
      }

      const execute = () => {
         timer = undefined;
         const toWrite = pending;
         pending = undefined;
         if (!toWrite) return;

         inFlight = Effect.runPromise(persistence.persist(toWrite.jobs))
            .catch(logPersistError)
            .then(() => {
               inFlight = undefined;
               const waiters = flushWaiters;
               flushWaiters = [];
               for (const waiter of waiters) waiter();
            });
      };

      if (immediate) {
         // Immediate writes still yield to the event loop so several synchronous
         // transitions in the same worker collapse into a single disk write.
         timer = setTimeout(execute, 0);
      } else {
         timer = setTimeout(execute, WORKERS_TASK_MANIFEST_LIMITS.persistDebounceMs);
      }
   };

   const schedule: RegistryChangeWriter["schedule"] = (jobs) => {
      const previous = lastSnapshot;
      lastSnapshot = jobs;

      if (previous === undefined) {
         scheduleWrite(jobs, true);
         return;
      }

      const hasNewJob = jobs.some((task) => !snapshotContains(previous, task.id));
      const hasTerminalTransition = jobs.some(
         (task) =>
            isTerminal(task) &&
            !previous.some((previousTask) => previousTask.id === task.id && isTerminal(previousTask))
      );

      if (hasNewJob || hasTerminalTransition) {
         scheduleWrite(jobs, true);
      } else {
         scheduleWrite(jobs, false);
      }
   };

   const flush: RegistryChangeWriter["flush"] = async () => {
      if (timer !== undefined) {
         clearTimeout(timer);
         timer = undefined;
      }
      const toWrite = pending;
      pending = undefined;
      if (toWrite) {
         await Effect.runPromise(persistence.persist(toWrite.jobs)).catch(logPersistError);
      } else if (inFlight) {
         await inFlight;
      }
   };

   return { schedule, flush };
}

export function convertInterruptedTask(stored: Task): Task {
   // A task that was still in flight when the parent restarted keeps its
   // session file so the main session can resume it in place.
   if (typeof stored.sessionFile === "string" && stored.sessionFile.length > 0) {
      return {
         ...stored,
         status: "recoverable",
         resultData: undefined,
         errorText: RESTART_INTERRUPTED_ERROR,
         settledAt: Date.now()
      };
   }
   return {
      ...stored,
      status: "failed",
      resultData: undefined,
      errorText: RESTART_INTERRUPTED_ERROR,
      settledAt: Date.now()
   };
}
