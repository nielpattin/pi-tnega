# Effect v4 Cheatsheet (Repo-Wide Guide)

> **Single Source of Truth** for Effect usage in this monorepo (`C:/Users/niel/.pi/agent`).
> **Version:** Pinned to `effect@4.0.0-beta.104` across all Effect-using packages.
> **Canonical idioms:** `repos/effect/LLMS.md` (vendored Effect source of truth). Prefer examples from that file and `repos/effect/ai-docs/**` over web search.

---

## 1. What Effect Is Used For

Effect is the **async runtime core** for process lifecycle, fiber orchestration, concurrency caps, resource teardown, and typed errors.

| Package / script                  | Key Usage                                                                                                              |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `extensions/ask-user`             | `Effect.tryPromise` + `Effect.runPromiseExit` for TUI prompts                                                          |
| `extensions/copy-all`             | `Effect.callback` for clipboard processes, `Data.TaggedError`                                                          |
| `extensions/pi-worker-flows`      | `Context.Service`, `Layer`, `ManagedRuntime`, `Deferred`, `Effect.callback`, explicit `Scope`, and typed domain errors |
| `scripts/sync-reference-repos.ts` | Effect CLI, `Schema`, `FileSystem`, `Stream`, and `ChildProcessSpawner`                                                |

### When NOT to Use Effect

- **TUI rendering**: `@earendil-works/pi-tui` stays sync/callback-driven.
- **Pure helpers**: formatting, path joins, pure transforms (no I/O, no fibers).

---

## 2. Environment & Version Pinning

```json
"dependencies": {
  "effect": "4.0.0-beta.104"
},
"devDependencies": {
  "@effect/platform-node": "4.0.0-beta.104"
}
```

- Pin exact version (no `^` / `~`) while on v4 beta.
- TypeScript: project TS (do **not** install `@effect/tsgo`).
- Use `"effect"` for core APIs. Use documented subpaths such as `"effect/unstable/process"` and `"@effect/platform-node/..."` where required.

---

## 3. Core Type: `Effect<A, E, R>`

| Param | Meaning                     |
| :---- | :-------------------------- |
| `A`   | Success value               |
| `E`   | Expected (typed) failure    |
| `R`   | Required services / context |

---

## 4. Writing Effect Code (from `repos/effect/LLMS.md`)

### 4.1 Prefer `Effect.gen` + `Effect.fn("name")`

Use generator style. Attach behavior with combinators after the generator body.

**Do not** write `function foo() { return Effect.gen(...) }`. Use `Effect.fn` for named Effect-returning functions (better stack traces + automatic span).

```ts
import { Effect, Schema } from "effect";

export class SomeError extends Schema.TaggedError<SomeError>()("SomeError", {
    message: Schema.String
}) {}

export const processItem = Effect.fn("processItem")(function* (n: number): Effect.fn.Return<string, SomeError> {
    if (n < 0) {
        return yield* new SomeError({ message: "negative" });
    }
    return String(n);
});
```

### 4.2 Creating effects

| Need                         | API                                                                 |
| :--------------------------- | :------------------------------------------------------------------ |
| Pure value                   | `Effect.succeed(a)` / `Effect.fail(e)`                              |
| Sync throw-prone             | `Effect.sync(() => ...)` / `Effect.try({ try, catch })`             |
| Promise                      | `Effect.tryPromise({ try, catch })` / `Effect.promise`              |
| Node callback / EventEmitter | `Effect.callback((resume) => { ...; return Effect.sync(cleanup) })` |

### 4.3 Error model

**Preferred for new code (LLMS.md):** `Schema.TaggedError`

```ts
import { Schema } from "effect";

export class SpawnError extends Schema.TaggedError<SpawnError>()("SpawnError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
}) {}
```

**Existing repo code uses:** `Data.TaggedError` in `extensions/copy-all`; Workers and the sync script use `Schema.TaggedError`.

### 4.4 Schema for domain + validation

All untrusted input validation goes through `Schema` (decode/encode). Avoid hand-rolled predicates for domain parsing.

```ts
import { Schema } from "effect";

const JsonSource = Schema.fromJsonString(Schema.Unknown);
export const decodeJsonSource = Schema.decodeUnknownEffect(JsonSource);
```

**Workers note:** Pi tool _parameter_ schemas stay TypeBox (Pi SDK). Workers _internal_ domain + `outputSchema` validation prefer Effect `Schema` where possible; TypeBox remains for tool JSON Schema surfaces.

### 4.5 Services: `Context.Service` + static `layer`

Canonical shape for Workers services:

```ts
import { Context, Effect, Layer } from "effect";

export interface JobRegistryShape {
    readonly get: (id: string) => Effect.Effect<Job | undefined>;
    readonly list: Effect.Effect<ReadonlyArray<Job>>;
}

export class JobRegistry extends Context.Service<JobRegistry, JobRegistryShape>()("workers/JobRegistry") {
    static readonly layer = Layer.effect(
        JobRegistry,
        Effect.gen(function* () {
            const get = Effect.fn("JobRegistry.get")(function* (id: string) {
                return undefined as Job | undefined;
            });
            return JobRegistry.of({
                get,
                list: Effect.succeed([])
            });
        })
    );
}

export type JobRegistryService = JobRegistry["Service"];
```

Compose layers:

```ts
const WorkersLive = WorkerManager.layer.pipe(Layer.provide(JobRegistry.layer));
```

- `Layer.provide`: hide deps, expose only outer service.
- `Layer.provideMerge`: expose outer + provided services.
- Root assembly: `ManagedRuntime.make(WorkersLive)` in `runtime.ts`. Name the layer `WorkersLive` (a `Layer`), not "ManagedRuntime".

### 4.6 Resources: explicit `Scope`

The pi-worker-flows worker feature creates an explicit scope for each external agent process, provides that scope to its polling effects, and closes it when the process settles or is cancelled.

```ts
const scope = yield * Scope.make();
yield * Scope.provide(work, scope);
yield * Scope.close(scope, undefined as any);
```

Use `Effect.forkScoped` for work that must follow the lifetime of an enclosing scope.

### 4.7 Reservation + interest (concurrency caps)

WorkerManager reserves capacity before spawning work:

1. Check the current running count plus the incoming count before spawning.
2. Increment the reservation synchronously.
3. Spawn the async work.
4. Convert the reservation into a running entry on success.
5. Release the reservation in `Effect.ensuring` on every exit path.

Track `waitInterest` and `killInterest`. Prune only when both are 0 and status is not `running`.

```ts
const wait = Effect.gen(function* () {
    yield* incrementWaitInterest(ids);
    yield* Effect.ensuring(awaitSettlement(ids), decrementWaitInterest(ids));
});
```

### 4.8 Fibers, Deferred, and streams

| Primitive           | Current use                                                                |
| :------------------ | :------------------------------------------------------------------------- |
| `Effect.forkScoped` | Background decoding work tied to a Workers scope                           |
| `Deferred`          | Worker job settlement signals                                              |
| `Effect.runFork`    | Completing settlement deferreds from synchronous listener callbacks        |
| `Stream`            | Concurrently collecting child-process stdout and stderr in the sync script |

### 4.9 Interrupts and timeouts

```ts
yield * work.pipe(Effect.timeout("2000 millis"), Effect.ignore);

const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined);
```

### 4.10 ManagedRuntime + tool boundary

Pi tools are plain `async` functions. Bridge once:

```ts
import { Cause, Exit, ManagedRuntime, type Effect } from "effect";

export function makeWorkersRuntime() {
    return ManagedRuntime.make(WorkersLive);
}

export async function runTool<A, E>(
    runtime: ReturnType<typeof makeWorkersRuntime>,
    effect: Effect.Effect<A, E>,
    options: { signal?: AbortSignal; interruptMessage?: string } = {}
) {
    const exit = await runtime.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined);
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterruptsOnly(exit.cause)) {
        throw new Error(options.interruptMessage ?? "Operation was aborted.");
    }
    const [first] = Cause.prettyErrors(exit.cause);
    throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
```

### 4.11 Child processes

The pi-worker-flows worker feature runs child Pi sessions through the shared agent runner. OS process supervision belongs to `pi-processes`. The repository sync script uses `effect/unstable/process` and `ChildProcessSpawner` for Git subprocesses.

### 4.12 Logging

Use `Console.log` for CLI output in `scripts/sync-reference-repos.ts`. Keep Effect orchestration and process lifecycle inside the Effect program.

---

## 5. Current repo conventions

1. Use `Context.Service` with a static `layer` for Workers services.
2. Use `Schema.TaggedError` for Workers and script domain errors.
3. Use `Data.TaggedError` only where existing `copy-all` code already uses it.
4. Prefer `Effect.fn("Name.method")` for named Effect functions.

---

## 6. Workers-Oriented Checklist

When implementing the worker feature in `extensions/pi-worker-flows`, every service must:

1. Use `Context.Service<Name, Shape>()("workers/Name")` with `static layer`.
2. Implement methods with `Effect.fn("Name.method")`.
3. Use `Schema.TaggedError` for domain errors.
4. Reserve slots sync; release with `Effect.ensuring`.
5. Use an explicit per-entry `Scope` and close it when the child settles.
6. Expose one `WorkersLive` layer + `makeWorkersRuntime()` + `runTool`.
7. Keep TUI code outside Effect fibers (call into runtime only).

---

## 7. Verification

```bash
pnpm typecheck
pnpm lint
pnpm fmt
pnpm --dir extensions/ask-user check
pnpm --dir extensions/copy-all check
pnpm --dir extensions/pi-worker-flows check
pnpm sync:repos --dry-run
```
