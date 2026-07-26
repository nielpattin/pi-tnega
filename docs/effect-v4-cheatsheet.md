# Effect v4 Cheatsheet (Repo-Wide Guide)

> **Single Source of Truth** for Effect usage in this monorepo (`C:/Users/niel/.pi/agent`).
> **Version:** Pinned to `effect@4.0.0-beta.101` across all Effect-using packages.
> **Canonical idioms:** `repos/effect/LLMS.md` (vendored Effect source of truth). Prefer examples from that file and `repos/effect/ai-docs/**` over web search.
> **Note:** Older per-extension docs under `extensions/*/docs/` are obsolete for Effect patterns. Use this file.

---

## 1. What Effect Is Used For

Effect is the **async runtime core** for process lifecycle, fiber orchestration, concurrency caps, resource teardown, and typed errors.

| Package                           | Key Usage                                                                                                                                          |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/tasks`                | Task lifecycle, `Context.Service` manager, `Scope` per task, `Stream` event pump, `waitInterest` / `Effect.ensuring`, `ManagedRuntime` + `runTool` |
| `extensions/background-terminals` | Process supervision, `FiberSet` cleanup, `Deferred` settled signal, `Effect.callback` for child close, tree kill + `Scope` finalizers              |
| `extensions/copy-all`             | `Effect.callback` for clipboard process, `Data.TaggedError`                                                                                        |
| `extensions/ask-user`             | `Effect.tryPromise` + `runPromiseExit` for TUI prompts                                                                                             |
| `packages/pi-harbor` (planned)    | Unified `HarborLive` layer: jobs, processes, mail, vibe; same runtime boundary pattern                                                             |

### When NOT to Use Effect

- **TUI rendering**: `@earendil-works/pi-tui` stays sync/callback-driven.
- **Pure helpers**: formatting, path joins, pure transforms (no I/O, no fibers).

---

## 2. Environment & Version Pinning

```json
"dependencies": {
  "effect": "4.0.0-beta.101"
}
```

- Pin exact version (no `^` / `~`) while on v4 beta.
- TypeScript: project TS (do **not** install `@effect/tsgo`).
- Imports: from `"effect"` only (e.g. `import { Effect, Context, Layer, Schema, Stream } from "effect"`).

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

export class SomeError extends Schema.TaggedErrorClass<SomeError>()("SomeError", {
    message: Schema.String
}) {}

export const processItem = Effect.fn("processItem")(
    function* (n: number): Effect.fn.Return<string, SomeError> {
        yield* Effect.logInfo("Received number:", n);
        if (n < 0) {
            return yield* new SomeError({ message: "negative" });
        }
        return String(n);
    },
    Effect.catch((error) => Effect.logError(`failed: ${error}`))
);
// Pass extra combinators as extra args to Effect.fn — do NOT .pipe the Effect.fn result for those.
```

### 4.2 Creating effects

| Need                         | API                                                                 |
| :--------------------------- | :------------------------------------------------------------------ |
| Pure value                   | `Effect.succeed(a)` / `Effect.fail(e)`                              |
| Sync throw-prone             | `Effect.sync(() => ...)` / `Effect.try({ try, catch })`             |
| Promise                      | `Effect.tryPromise({ try, catch })` / `Effect.promise`              |
| Node callback / EventEmitter | `Effect.callback((resume) => { ...; return Effect.sync(cleanup) })` |
| Optional                     | `Effect.fromOption` / `Effect.fromNullable` patterns as needed      |

### 4.3 Error model

**Preferred for new code (LLMS.md):** `Schema.TaggedErrorClass`

```ts
import { Schema } from "effect";

export class SpawnError extends Schema.TaggedErrorClass<SpawnError>()("SpawnError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
}) {}
```

**Existing repo code often uses:** `Data.TaggedError` (tasks / background-terminals / copy-all). Keep that shape when editing those files; prefer `Schema.TaggedErrorClass` in **new** packages (harbor).

Catch:

```ts
effect.pipe(
    Effect.catchTag("SpawnError", (e) => Effect.succeed(fallback)),
    Effect.catch((e) => Effect.succeed(defaultValue))
);
```

### 4.4 Schema for domain + validation

All untrusted input validation goes through `Schema` (decode/encode). Avoid hand-rolled predicates for domain parsing.

```ts
import { Effect, Schema } from "effect";

export class User extends Schema.Class<User>("harbor/User")({
    id: Schema.String,
    name: Schema.NonEmptyString
}) {}

export const decodeUser = Schema.decodeUnknownEffect(User);
```

**Harbor note:** Pi tool _parameter_ schemas stay TypeBox (Pi SDK). Harbor _internal_ domain + `outputSchema` validation prefer Effect `Schema` where possible; TypeBox remains for tool JSON Schema surfaces.

### 4.5 Services: `Context.Service` + static `layer`

Canonical shape from LLMS.md and tasks:

```ts
import { Context, Effect, Layer } from "effect";

export interface JobRegistryShape {
    readonly get: (id: string) => Effect.Effect<Job | undefined>;
    readonly list: Effect.Effect<ReadonlyArray<Job>>;
}

export class JobRegistry extends Context.Service<JobRegistry, JobRegistryShape>()("harbor/JobRegistry") {
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
const HarborLive = TaskManager.layer.pipe(
    Layer.provide(JobRegistry.layer),
    Layer.provideMerge(ProcessSupervisor.layer)
);
```

- `Layer.provide`: hide deps, expose only outer service.
- `Layer.provideMerge`: expose outer + provided services.
- Root assembly: `ManagedRuntime.make(HarborLive)` in `runtime.ts`. Name the layer `HarborLive` (a `Layer`), not "ManagedRuntime".

### 4.6 Resources: `Scope`, `acquireRelease`, finalizers

```ts
yield * Effect.addFinalizer(() => Effect.sync(() => cleanup()));

const resource =
    yield *
    Effect.acquireRelease(
        Effect.sync(() => openThing()),
        (thing) => Effect.sync(() => thing.close())
    );
```

Per-job pattern (tasks / terminals): `Scope.make` per entry, `Scope.provide(Effect.forkScoped(work), scope)`, on settle `Scope.close(scope, Exit.void)`.

### 4.7 Reservation + interest (concurrency caps)

**Correct pattern (do not hold Mutex across async spawn):**

1. Synchronously check `running + reserved + n <= CAP` before first yield.
2. Increment `reserved` (sync).
3. Spawn async work.
4. On register success: `running++`, `reserved--`.
5. Always `reserved--` / interest release in `Effect.ensuring` (interrupt-safe).

Track `waitInterest` and `killInterest`. Prune only when both are 0 and status is not `running`.

```ts
const wait = Effect.gen(function* () {
    yield* incrementWaitInterest(ids);
    yield* Effect.ensuring(awaitSettlement(ids), decrementWaitInterest(ids));
});
```

### 4.8 Fibers, FiberSet, Deferred, Queue, Stream

| Primitive                 | Use                                        |
| :------------------------ | :----------------------------------------- |
| `Effect.forkScoped`       | Background pump tied to job `Scope`        |
| `FiberSet`                | Batch of cleanup fibers (terminals)        |
| `Deferred`                | One-shot "process settled" / wait cell     |
| `Queue`                   | Backend event buffers (`Stream.fromQueue`) |
| `Stream.runForEach`       | Consume child session events               |
| `Effect.runForkWith(ctx)` | Detached fork preserving manager services  |

### 4.9 PubSub (mail / change bus)

For multi-subscriber job-change or mail events:

```ts
import { Effect, Layer, PubSub, Stream, Context } from "effect";

const pubsub = yield * PubSub.bounded<JobEvent>({ capacity: 256, replay: 32 });
yield * Effect.addFinalizer(() => PubSub.shutdown(pubsub));
const subscribe = Stream.fromPubSub(pubsub);
```

MailBus can use per-recipient queues **or** PubSub + filter; prefer Effect primitives over raw `Set` of callbacks for new code.

### 4.10 Interrupt, timeout, result

```ts
yield * child.interrupt.pipe(Effect.timeout("2 seconds"), Effect.ignore);
const result = yield * work.pipe(Effect.result); // Result.success | Result.failure
// Effect v4: Either renamed to Result
import { Result } from "effect";
```

### 4.11 ManagedRuntime + tool boundary

Pi tools are plain `async` functions. Bridge once:

```ts
import { Cause, Exit, ManagedRuntime, type Effect } from "effect";

export function makeHarborRuntime() {
    return ManagedRuntime.make(HarborLive);
}

export async function runTool<A, E>(
    runtime: ReturnType<typeof makeHarborRuntime>,
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

### 4.12 Child processes

Repo pattern today: Node `spawn` + `Effect.callback` + tree kill helpers (copy from background-terminals).

Effect also documents `effect/unstable/process` + `ChildProcessSpawner` for Effect-native process APIs. Harbor Phase 1 copies the proven Node+callback pattern; Phase 3 may evaluate unstable process modules.

### 4.13 Logging / spans

```ts
yield * Effect.logInfo("spawn", { id });
// Effect.fn("name") attaches withSpan automatically
```

### 4.14 Testing

- Prefer `ManagedRuntime.make(testLayer)` + `runPromise` / `runPromiseExit` (matches tasks tests).
- Effect docs also show `@effect/vitest` `it.effect` — optional if added as a devDep later.
- Provide fake services with `Layer.succeed(Service, Service.of({...}))`.

### 4.15 Predicate module

Do not invent `isRecord` / `isString` helpers. Use `Predicate` from `effect`.

---

## 5. v3 → v4 deltas that matter here

1. Platform modules merged into core `effect` where applicable.
2. `Either` → `Result`.
3. Services: `Context.Service` (not old Tag-only style for new code).
4. Prefer `Schema.TaggedErrorClass` for new errors.
5. Prefer `Effect.fn("Name.method")` for service methods.

---

## 6. Harbor-Oriented Checklist

When implementing `packages/pi-harbor`, every service must:

1. Use `Context.Service<Name, Shape>()("harbor/Name")` with `static layer`.
2. Implement methods with `Effect.fn("Name.method")`.
3. Use `Schema.TaggedErrorClass` for domain errors.
4. Reserve slots sync; release with `Effect.ensuring`.
5. Use per-entry `Scope` + finalizers for children.
6. Expose one `HarborLive` layer + `makeHarborRuntime()` + `runTool`.
7. Keep TUI code outside Effect fibers (call into runtime only).

---

## 7. Verification

```bash
pnpm --filter tasks check
pnpm --filter background-terminals check
pnpm --filter copy-all check
pnpm --filter ask-user check
# after harbor exists:
pnpm --dir packages/pi-harbor check
pnpm --dir packages/pi-harbor test
```
