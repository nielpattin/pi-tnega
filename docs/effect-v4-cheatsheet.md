# Effect v4 Cheatsheet (Repo-Wide Guide)

> **Single Source of Truth** for Effect usage in this monorepo (`C:/Users/niel/.pi/agent`).  
> **Version:** Pinned to `effect@4.0.0-beta.101` across all Effect-using extensions.  
> **Note:** Any older per-extension docs under `extensions/*/docs/` are obsolete reference notes — refer to this file for current monorepo patterns.

---

## 1. What Effect is Used For in This Monorepo

Effect is used as the **async runtime core** for background processes, fiber orchestration, concurrency limiting, resource lifecycle management, and typed error handling.

| Package | Key Usage |
| :--- | :--- |
| `extensions/subagents` | Subagent process lifecycle, background fibers, steering queue, event streaming (`Stream`), backend registry (`Context.Service`), concurrency caps. |
| `extensions/background-terminals` | Background terminal shell processes, process tree SIGTERM/SIGKILL escalation (`Scope` + `Effect.addFinalizer`), output buffer streaming, `TerminalManager` service layer. |
| `extensions/copy-all` | Async clipboard command execution, process exit code handling with `Effect.callback`, typed error wrapping (`Data.TaggedError`). |
| `extensions/ask-user` | TUI popup prompt execution, interrupt signal handling with `Effect.tryPromise` & `Effect.runPromiseExit`. |

### When NOT to Use Effect
- **TUI & UI Rendering**: `@earendil-works/pi-tui` components, widgets, and synchronous render loops. Imperative TUI classes must remain synchronous and callback-driven.
- **Pure Helpers**: String formatting, text wrapping, date formatting, pure state calculations.

---

## 2. Environment & Version Pinning

```json
// package.json in extensions using effect (ask-user, background-terminals, copy-all, subagents)
"dependencies": {
   "effect": "4.0.0-beta.101"
}
```

- **Exact Pin**: Always pin exact version (no `^` or `~`) while on v4 beta/rc.
- **TypeScript**: TS v7 (`typescript@^7.0.2`). Do **NOT** install `@effect/tsgo`.
- **Imports**: Import directly from `"effect"` (e.g. `import { Effect, Context, Layer, Cause, Exit, Data } from "effect"`).

---

## 3. Core Concept: `Effect<A, E, R>`

- **`A`** — **Success value** type.
- **`E`** — **Expected error** type (typed failures).
- **`R`** — **Context requirements** (services/environment dependencies).

---

## 4. Key Patterns Used in This Repo

### 4.1 `Context.Service` & `Layer` (Service Architecture)

Effect v4 defines services using `Context.Service`:

```ts
import { Context, Effect, Layer } from "effect";

// 1. Define Service Tag & Interface
export interface TerminalManagerShape {
   readonly start: (cmd: string) => Effect.Effect<string, Error>;
   readonly disposeAll: Effect.Effect<void>;
}

export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
   "background-terminals/TerminalManager"
) {}

// 2. Implementation Generator
const makeManager = Effect.gen(function* () {
   yield* Effect.addFinalizer(() => Effect.log("Cleaning up terminals..."));
   return TerminalManager.of({
      start: (cmd) => Effect.succeed(`Started ${cmd}`),
      disposeAll: Effect.void
   });
});

// 3. Construct Live Layer
export const TerminalManagerLive: Layer.Layer<TerminalManager> = Layer.effect(TerminalManager, makeManager);
```

### 4.2 ManagedRuntime & `runTool` (Async Tool Boundary)

Tool handlers in `pi-coding-agent` are standard async JavaScript functions. The bridge into Effect is a shared `ManagedRuntime`:

```ts
import { Cause, Exit, ManagedRuntime, type Effect } from "effect";
import { TerminalManagerLive } from "./manager.ts";

export function createTerminalRuntime() {
   return ManagedRuntime.make(TerminalManagerLive);
}

export type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;

export async function runTool<A, E>(
   runtime: TerminalRuntime,
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

### 4.3 `Data.TaggedError` (Typed Errors)

Define structured domain errors with `Data.TaggedError`:

```ts
import { Data } from "effect";

export class ClipboardError extends Data.TaggedError("ClipboardError")<{
   readonly message: string;
   readonly cause: Error;
}> {}
```

### 4.4 `Effect.callback` (Node Process / Callback Wrapper)

Wrap Node.js callback-based async operations and register finalizers:

```ts
import { spawn } from "node:child_process";
import { Effect } from "effect";

export function executeCommand(cmd: string, args: string[]) {
   return Effect.callback<void, Error>((resume) => {
      const child = spawn(cmd, args);
      
      child.on("error", (err) => resume(Effect.fail(err)));
      child.on("close", (code) => {
         if (code === 0) resume(Effect.void);
         else resume(Effect.fail(new Error(`Exited with code ${code}`)));
      });

      // Teardown logic if the effect fiber is interrupted
      return Effect.sync(() => {
         if (child.exitCode === null) child.kill();
      });
   });
}
```

### 4.5 `Scope` & Finalizers (Resource Teardown)

Ensure child processes or file streams are closed on scope exit:

```ts
import { Effect, Scope } from "effect";

const scopedProcess = Effect.gen(function* () {
   const scope = yield* Scope.make();
   
   yield* Effect.addFinalizer(() => Effect.sync(() => console.log("Scope closed")));
   
   return scope;
});
```

### 4.6 `Result` (Effect v4 Renamed `Either` -> `Result`)

In Effect v4, `Either` is renamed to `Result`:

```ts
import { Result } from "effect";

const success = Result.success(42);
const failure = Result.fail("error");

if (Result.isSuccess(success)) {
   console.log(success.value);
}
```

---

## 5. Summary of Key Effect v3 → v4 Changes

1. **`@effect/platform` Merged into `effect` Core**:
   - `FileSystem`, `Path`, `Terminal` are inside core `effect`.
2. **`Either` Renamed to `Result`**:
   - Use `Result.success()`, `Result.fail()`, `Result.isSuccess()`, etc.
3. **`Context.Service` Syntax**:
   - `export class MyService extends Context.Service<MyService, Shape>()("ServiceId") {}`
4. **`Effect.gen`**:
   - Generator functions yield effects (`yield* Effect(...)`).

---

## 6. Verification Commands

Run from the root or within specific extension folders:

```bash
# Typecheck Effect-using extensions
pnpm --filter subagents check
pnpm --filter background-terminals check
pnpm --filter copy-all check
pnpm --filter ask-user check

# Run test suites
pnpm --filter subagents test
pnpm --filter background-terminals test
```
