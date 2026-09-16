import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";

// Pi exposes no public accessor for the live ExtensionRunner, but nested Raft
// results must replay Pi's tool_result middleware (see RaftToolResultProxy).
// The only seam that yields the instance is the host's own
// getAllRegisteredTools() call site, so the prototype is patched to observe it.
//
// pi >= 0.84.3 loads the CLI from dist/bundle/cli.js, whose rollup chunks carry
// their own ExtensionRunner class identity — patching the library-level export
// alone never fires because the live host runner is an instance of the bundle's
// copy. Importing each chunk inside the running CLI is a Node module-cache hit,
// so scanning the bundle is free and yields the class the host actually runs.

const OBSERVER_SYMBOL = Symbol.for("pi-raft.extension-runner-observer.v1");

type ExtensionRunnerConstructor = { prototype: ExtensionRunner };

interface RunnerObserver {
  listeners: Set<(runner: ExtensionRunner) => void>;
}

const isExtensionRunnerConstructor = (value: unknown): value is ExtensionRunnerConstructor =>
  typeof value === "function" &&
  typeof (value as { prototype?: unknown }).prototype === "object" &&
  typeof (value as { prototype: Record<string, unknown> }).prototype.getAllRegisteredTools ===
    "function";

const bundleExtensionRunnerConstructors = async (
  bundleDir: string,
): Promise<ExtensionRunnerConstructor[]> => {
  const chunksDir = path.join(bundleDir, "chunks");
  if (!existsSync(chunksDir)) return [];
  let files: string[];
  try {
    files = readdirSync(chunksDir);
  } catch {
    return [];
  }
  const constructors = new Set<ExtensionRunnerConstructor>();
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    try {
      const module = (await import(pathToFileURL(path.join(chunksDir, file)).href)) as Record<
        string,
        unknown
      >;
      for (const exported of Object.values(module)) {
        if (isExtensionRunnerConstructor(exported)) constructors.add(exported);
      }
    } catch {
      // Chunk not importable in this realm (worker entries, natives); skip.
    }
  }
  return [...constructors];
};

const observeRunner = (Runner: ExtensionRunnerConstructor): RunnerObserver => {
  const prototype = Runner.prototype as ExtensionRunner & Record<PropertyKey, unknown>;
  const existing = prototype[OBSERVER_SYMBOL] as RunnerObserver | undefined;
  if (existing) return existing;

  // Kept as a prototype reference; the patched method re-attaches `this`.
  const original = Object.getOwnPropertyDescriptor(prototype, "getAllRegisteredTools")?.value as
    | ((this: ExtensionRunner) => ReturnType<ExtensionRunner["getAllRegisteredTools"]>)
    | undefined;
  if (typeof original !== "function") {
    throw new Error("Pi Raft could not observe ExtensionRunner.getAllRegisteredTools");
  }

  const observer: RunnerObserver = { listeners: new Set() };
  Object.defineProperty(prototype, OBSERVER_SYMBOL, {
    value: observer,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  prototype.getAllRegisteredTools = function getRaftObservedTools(this: ExtensionRunner) {
    for (const listener of observer.listeners) listener(this);
    return original.call(this);
  };
  return observer;
};

const hostPackageRoot = (): string | undefined => {
  const cliPath = process.argv[1];
  if (!cliPath) return undefined;
  let directory: string;
  try {
    directory = path.dirname(realpathSync(cliPath));
  } catch {
    return undefined;
  }
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
      } catch {
        // Unreadable or invalid manifest; keep searching.
      }
    }
    directory = path.dirname(directory);
  }
  return undefined;
};

const extensionRunnerConstructors = async (): Promise<ExtensionRunnerConstructor[]> => {
  const constructors = new Set<ExtensionRunnerConstructor>();
  const packageRoots = new Set(
    [process.env.PI_PACKAGE_DIR, hostPackageRoot()].filter(
      (root): root is string => typeof root === "string" && Boolean(root),
    ),
  );
  for (const packageRoot of packageRoots) {
    try {
      const hostEntry = path.join(packageRoot, "dist", "index.js");
      const hostModule = (await import(pathToFileURL(hostEntry).href)) as {
        ExtensionRunner?: ExtensionRunnerConstructor;
      };
      if (hostModule.ExtensionRunner) constructors.add(hostModule.ExtensionRunner);
    } catch {
      // Host entry not importable; skip.
    }
    for (const Runner of await bundleExtensionRunnerConstructors(
      path.join(packageRoot, "dist", "bundle"),
    )) {
      constructors.add(Runner);
    }
  }
  // No module-realm fallback: importing the host package here would pull it
  // into the lazy settings/UI graph (see assert:lazy-graph). Discovery through
  // the running CLI above is the only supported path; in tests, embeds, or
  // future layouts observation stays empty and tool results pass through
  // unproxied instead.
  return [...constructors];
};

let observedRunner: ExtensionRunner | undefined;

/**
 * Installs an observer for the live host ExtensionRunner and returns the most
 * recently observed instance. Shared across callers: a second observe must not
 * start from an empty closure or settings/tool listing will miss extension tools.
 * Errors are contained: an unobservable host leaves nested Raft results
 * unproxied rather than failing the session.
 */
export const observeHostExtensionRunner = async (): Promise<{
  current: () => ExtensionRunner | undefined;
}> => {
  try {
    for (const Runner of await extensionRunnerConstructors()) {
      observeRunner(Runner).listeners.add((observed) => {
        observedRunner = observed;
      });
    }
  } catch {
    // Observation is best-effort; nested results still return their value.
  }
  return { current: () => observedRunner };
};

/** Names of tools currently registered on the live host runner. */
export const registeredToolNames = (
  runner: { getAllRegisteredTools(): Array<{ definition: { name: string } }> } | undefined,
): string[] => {
  if (!runner) return [];
  const names: string[] = [];
  for (const tool of runner.getAllRegisteredTools()) {
    const name = tool.definition.name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
};
