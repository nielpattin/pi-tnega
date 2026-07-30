import { Effect, Layer } from "effect";
import * as path from "node:path";
import {
   HarborJobPersistence,
   HARBOR_JOBS_FILE,
   type HarborJobPersistenceShape,
   type RegistryChangeWriter
} from "../../src/services/HarborJobPersistence.js";
import { ManifestPersistenceError, type Job } from "../../src/domain.js";
import { deriveChildSessionDirectory } from "../../src/utils/child-session-dir.js";
import type { HarborJobIndex } from "../../src/services/HarborJobManifest.js";

export type PersistenceFailurePhase = "configure" | "load" | "persist";

export interface InjectedPersistenceOptions {
   /** Activation phase that should fail with an actionable error. */
   failAt?: PersistenceFailurePhase;
   /** Restrict the injected failure to a specific parent session file. */
   failAtParentFile?: string;
   /** Message attached to the injected failure. */
   message?: string;
   /** Pre-populate the in-memory store with jobs keyed by parent session file. */
   initialIndexes?: Record<string, ReadonlyArray<Job>>;
}

/**
 * Build an in-memory HarborJobPersistence layer that supports failure injection
 * during parent-session activation. The returned shape is otherwise fully
 * functional so that successful activation, listener writes, and later retry
 * can be exercised without touching the real filesystem.
 */
export function makeInjectedPersistenceLayer(options: InjectedPersistenceOptions = {}): Layer.Layer<HarborJobPersistence> {
   return Layer.effect(
      HarborJobPersistence,
      Effect.sync(() => {
         const storage = new Map<string, HarborJobIndex>();
         for (const [parentFile, jobs] of Object.entries(options.initialIndexes ?? {})) {
            const dir = deriveChildSessionDirectory(parentFile);
            if (dir) {
               storage.set(path.join(dir, HARBOR_JOBS_FILE), {
                  version: 1,
                  parentSessionFile: parentFile,
                  writtenAt: Date.now(),
                  source: "valid",
                  jobs
               });
            }
         }
         let indexDir: string | undefined;
         let configuredParentSessionFile: string | undefined;
         let changeListenerUnsubscribe: (() => void) | undefined;
         let changeWriter: RegistryChangeWriter | undefined;

         const resolveFinalPath = (): string | undefined =>
            indexDir ? path.join(indexDir, HARBOR_JOBS_FILE) : undefined;

         const shouldFail = (phase: PersistenceFailurePhase, parentFile: string | undefined) => {
            if (options.failAt !== phase) return false;
            if (!options.failAtParentFile) return true;
            return options.failAtParentFile === parentFile;
         };

         const makeError = (phase: PersistenceFailurePhase) =>
            new ManifestPersistenceError({
               message: options.message ?? `Injected ${phase} failure`,
               cause: new Error(options.message ?? `Injected ${phase} failure`)
            });

         const configure: HarborJobPersistenceShape["configure"] = Effect.fn("HarborJobPersistence.configure")(
            (parentSessionFile) =>
               Effect.gen(function* () {
                  const file = parentSessionFile || undefined;
                  indexDir = undefined;
                  configuredParentSessionFile = undefined;
                  if (!file) return;
                  if (shouldFail("configure", file)) return yield* Effect.fail(makeError("configure"));
                  const dir = deriveChildSessionDirectory(file);
                  if (!dir) return;
                  indexDir = dir;
                  configuredParentSessionFile = file;
               })
         );

         const currentTarget: HarborJobPersistenceShape["currentTarget"] = Effect.fn(
            "HarborJobPersistence.currentTarget"
         )(() => Effect.succeed(configuredParentSessionFile));

         const takeChangeListener: HarborJobPersistenceShape["takeChangeListener"] = Effect.fn(
            "HarborJobPersistence.takeChangeListener"
         )(() =>
            Effect.sync(() => {
               const unsub = changeListenerUnsubscribe;
               changeListenerUnsubscribe = undefined;
               return unsub;
            })
         );

         const setChangeListener: HarborJobPersistenceShape["setChangeListener"] = Effect.fn(
            "HarborJobPersistence.setChangeListener"
         )((unsubscribe) =>
            Effect.sync(() => {
               changeListenerUnsubscribe = unsubscribe;
            })
         );

         const takeChangeWriter: HarborJobPersistenceShape["takeChangeWriter"] = Effect.fn(
            "HarborJobPersistence.takeChangeWriter"
         )(() =>
            Effect.sync(() => {
               const writer = changeWriter;
               changeWriter = undefined;
               return writer;
            })
         );

         const setChangeWriter: HarborJobPersistenceShape["setChangeWriter"] = Effect.fn(
            "HarborJobPersistence.setChangeWriter"
         )((writer) =>
            Effect.sync(() => {
               changeWriter = writer;
            })
         );

         const currentDir: HarborJobPersistenceShape["currentDir"] = Effect.fn("HarborJobPersistence.currentDir")(() =>
            Effect.succeed(indexDir)
         );

         const load: HarborJobPersistenceShape["load"] = Effect.fn("HarborJobPersistence.load")(() =>
            Effect.gen(function* () {
               if (shouldFail("load", configuredParentSessionFile))
                  return yield* Effect.fail(makeError("load"));
               const finalPath = resolveFinalPath();
               if (!finalPath) {
                  return { version: 1, source: "missing" as const, jobs: [] as Job[] };
               }
               const stored = storage.get(finalPath);
               if (stored) {
                  return { ...stored, source: "valid" as const };
               }
               return { version: 1, source: "missing" as const, jobs: [] as Job[] };
            })
         );

         const persist: HarborJobPersistenceShape["persist"] = Effect.fn("HarborJobPersistence.persist")((jobs) =>
            Effect.gen(function* () {
               const finalPath = resolveFinalPath();
               if (!finalPath) return;
               if (shouldFail("persist", configuredParentSessionFile))
                  return yield* Effect.fail(makeError("persist"));
               const index: HarborJobIndex = {
                  version: 1,
                  parentSessionFile: configuredParentSessionFile,
                  writtenAt: Date.now(),
                  source: "valid",
                  jobs: [...jobs]
               };
               storage.set(finalPath, index);
            })
         );

         const flush: HarborJobPersistenceShape["flush"] = Effect.fn("HarborJobPersistence.flush")(() => Effect.void);

         return HarborJobPersistence.of({
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
      })
   );
}
