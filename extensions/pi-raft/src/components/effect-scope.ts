import type {
  RaftComponentDisposer,
  RaftComponentEffect,
  RaftComponentEffectInfo,
  RaftComponentEffectRegistration,
} from "./types.js";

interface RaftEffectFailure {
  label: string;
  error: string;
}

export interface RaftEffectCleanupReport {
  status: "disposed" | "quarantined";
  failures: RaftEffectFailure[];
}

export type RaftEffectGuard = () => boolean | Promise<boolean>;

export interface RaftEffectScopeOptions {
  guard?: RaftEffectGuard;
}

export interface RaftEffectLifecycleHooks {
  beforeCleanup?(): void;
}

export class RaftEffectDivertedError extends Error {
  readonly cleanupError: unknown;

  constructor(
    message = "Raft effect target changed at an iteration boundary",
    cleanupError?: unknown,
  ) {
    super(message);
    this.name = "RaftEffectDivertedError";
    this.cleanupError = cleanupError;
  }
}

interface EffectRecord {
  label: string;
  effect?: RaftComponentEffectInfo;
  disposers: RaftComponentDisposer[];
  setup: Promise<void>;
  dispose: () => Promise<void>;
  disposed: boolean;
  armed: boolean;
  cleanupStarted: boolean;
  beforeCleanup?: () => void;
}

interface EffectIterator {
  next(): IteratorResult<unknown> | Promise<IteratorResult<unknown>>;
  return?(): IteratorResult<unknown> | Promise<IteratorResult<unknown>>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof (value as { then?: unknown }).then === "function";

const isIterable = (value: unknown): value is Iterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.iterator in value &&
  typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

const collectDisposer = (value: unknown, disposers: RaftComponentDisposer[]): void => {
  if (value === undefined || value === null) return;
  if (typeof value !== "function") throw new TypeError("Raft effect yielded an invalid disposer");
  disposers.push(value as RaftComponentDisposer);
};

const normalizeRegistration = (
  registration: RaftComponentEffectRegistration | undefined,
  fallbackLabel: string,
): { label: string; effect?: RaftComponentEffectInfo } => {
  if (typeof registration === "string") return { label: registration };
  if (!registration) return { label: fallbackLabel };
  const resources = [
    ...new Set(
      (registration.resources ?? [])
        .filter(
          (resource): resource is string => typeof resource === "string" && resource.length > 0,
        )
        .map((resource) => resource.slice(0, 256)),
    ),
  ].slice(0, 64);
  const label = registration.label?.trim().slice(0, 256) || fallbackLabel;
  return {
    label,
    effect: {
      label,
      kind: registration.kind ?? "transactional",
      resources: resources.length > 0 ? resources : ["*"],
      ordering: registration.ordering ?? "unknown",
    },
  };
};

const beginCleanup = (record: EffectRecord): void => {
  if (record.cleanupStarted) return;
  record.cleanupStarted = true;
  record.beforeCleanup?.();
};

const closeIterator = async (
  iterator: EffectIterator,
  disposers: RaftComponentDisposer[],
): Promise<void> => {
  if (!iterator.return) return;
  let step = await iterator.return();
  while (!step.done) {
    collectDisposer(step.value, disposers);
    step = await iterator.next();
  }
};

const checkTarget = async (guard: RaftEffectGuard | undefined): Promise<void> => {
  if (guard && !(await guard())) throw new RaftEffectDivertedError();
};

const driveIterator = async (
  iterator: EffectIterator,
  record: EffectRecord,
  guard: RaftEffectGuard | undefined,
): Promise<void> => {
  try {
    for (;;) {
      if (!record.armed) {
        beginCleanup(record);
        await closeIterator(iterator, record.disposers);
        return;
      }
      await checkTarget(guard);
      const step = await iterator.next();
      if (!step.done) collectDisposer(step.value, record.disposers);
      if (!record.armed) {
        beginCleanup(record);
        await closeIterator(iterator, record.disposers);
        return;
      }
      if (step.done) {
        await checkTarget(guard);
        return;
      }
    }
  } catch (error) {
    if (error instanceof RaftEffectDivertedError) {
      try {
        beginCleanup(record);
        await closeIterator(iterator, record.disposers);
      } catch (closeError) {
        throw new RaftEffectDivertedError(
          "Raft effect target changed and iterator close failed",
          closeError,
        );
      }
    }
    throw error;
  }
};

const collectEffect = async (
  effect: RaftComponentEffect,
  record: EffectRecord,
  guard: RaftEffectGuard | undefined,
): Promise<void> => {
  const resolved = isPromiseLike(effect) ? await effect : effect;
  if (resolved === undefined || resolved === null || typeof resolved === "function") {
    collectDisposer(resolved, record.disposers);
    if (record.armed) await checkTarget(guard);
    return;
  }
  if (isAsyncIterable(resolved)) {
    await driveIterator(resolved[Symbol.asyncIterator](), record, guard);
    return;
  }
  if (isIterable(resolved)) {
    await driveIterator(resolved[Symbol.iterator](), record, guard);
    return;
  }
  throw new TypeError("Raft effect returned an unsupported value");
};

export class RaftEffectScope {
  readonly #records: EffectRecord[] = [];
  readonly #setupCleanupFailures: RaftEffectFailure[] = [];
  readonly #guard: RaftEffectGuard | undefined;
  #state: "open" | "disposing" | "disposed" = "open";
  #cleanup: Promise<RaftEffectCleanupReport> | undefined;

  constructor(options: RaftEffectScopeOptions = {}) {
    this.#guard = options.guard;
  }

  get state(): "open" | "disposing" | "disposed" {
    return this.#state;
  }

  footprint(limit = Number.POSITIVE_INFINITY): RaftComponentEffectInfo[] {
    const effects: RaftComponentEffectInfo[] = [];
    for (const record of this.#records) {
      if (effects.length >= limit) break;
      if (!record.disposed && record.effect) {
        effects.push({ ...record.effect, resources: [...record.effect.resources] });
      }
    }
    return effects;
  }

  async effect(
    setup: () => RaftComponentEffect,
    registration: RaftComponentEffectRegistration = "anonymous",
    hooks: RaftEffectLifecycleHooks = {},
  ): Promise<RaftComponentDisposer> {
    if (this.#state !== "open") {
      throw new Error("Cannot create an effect on a disposing Raft scope");
    }

    const normalized = normalizeRegistration(registration, "anonymous");
    const record: EffectRecord = {
      label: normalized.label,
      ...(normalized.effect ? { effect: normalized.effect } : {}),
      disposers: [],
      setup: Promise.resolve(),
      dispose: async () => {},
      disposed: false,
      armed: true,
      cleanupStarted: false,
      ...(hooks.beforeCleanup ? { beforeCleanup: () => hooks.beforeCleanup!() } : {}),
    };
    const cleanupDisposers = async (): Promise<void> => {
      beginCleanup(record);
      const failures: unknown[] = [];
      for (const disposer of record.disposers.splice(0).reverse()) {
        try {
          await disposer();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Raft effect cleanup failed: ${record.label}`);
      }
    };

    let disposal: Promise<void> | undefined;
    record.dispose = async () => {
      if (record.disposed) return disposal;
      record.disposed = true;
      record.armed = false;
      disposal = (async () => {
        await record.setup.catch(() => undefined);
        await cleanupDisposers();
      })();
      return disposal;
    };

    this.#records.push(record);
    record.setup = (async () => {
      try {
        if (this.#guard) await checkTarget(this.#guard);
        if (!record.armed) return;
        await collectEffect(setup(), record, this.#guard);
      } catch (error) {
        try {
          await cleanupDisposers();
        } catch (cleanupError) {
          const failures =
            cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
          for (const failure of failures) {
            this.#setupCleanupFailures.push({ label: record.label, error: errorMessage(failure) });
          }
          const failure = new AggregateError(
            [error, cleanupError],
            `Raft effect setup and rollback failed: ${record.label}`,
            { cause: cleanupError },
          );
          throw failure;
        }
        throw error;
      }
    })();

    try {
      await record.setup;
      if (this.#state === "open") {
        const index = this.#records.indexOf(record);
        if (index >= 0 && index !== this.#records.length - 1) {
          this.#records.splice(index, 1);
          this.#records.push(record);
        }
      }
    } catch (error) {
      const index = this.#records.indexOf(record);
      if (index >= 0) this.#records.splice(index, 1);
      throw error;
    }
    return record.dispose;
  }

  defer(
    disposer: RaftComponentDisposer,
    registration: RaftComponentEffectRegistration = "deferred",
  ): RaftComponentDisposer {
    if (this.#state !== "open") {
      throw new Error("Cannot defer cleanup on a disposing Raft scope");
    }
    const normalized = normalizeRegistration(registration, "deferred");
    const record: EffectRecord = {
      label: normalized.label,
      ...(normalized.effect ? { effect: normalized.effect } : {}),
      disposers: [disposer],
      setup: Promise.resolve(),
      dispose: async () => {},
      disposed: false,
      armed: true,
      cleanupStarted: false,
    };
    let disposal: Promise<void> | undefined;
    record.dispose = async () => {
      if (record.disposed) return disposal;
      record.disposed = true;
      record.armed = false;
      disposal = (async () => {
        const failures: unknown[] = [];
        for (const cleanup of record.disposers.splice(0).reverse()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `Raft effect cleanup failed: ${record.label}`);
        }
      })();
      return disposal;
    };
    this.#records.push(record);
    return record.dispose;
  }

  dispose(): Promise<RaftEffectCleanupReport> {
    if (this.#cleanup) return this.#cleanup;
    this.#state = "disposing";
    this.#cleanup = (async () => {
      const failures: RaftEffectFailure[] = this.#setupCleanupFailures.splice(0);
      for (const record of this.#records.splice(0).reverse()) {
        try {
          await record.dispose();
        } catch (error) {
          if (error instanceof AggregateError) {
            for (const nested of error.errors) {
              failures.push({ label: record.label, error: errorMessage(nested) });
            }
          } else {
            failures.push({ label: record.label, error: errorMessage(error) });
          }
        }
      }
      this.#state = "disposed";
      return { status: failures.length > 0 ? "quarantined" : "disposed", failures };
    })();
    return this.#cleanup;
  }
}
