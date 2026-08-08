---
name: tdd
description: Local node:test scratch tests for this repo's extensions, run with `node tests/<file>.mjs`. TDD for verifying extension behavior: write the failing test first for new code, characterization-probe existing extension output. Tests live in the gitignored tests/ folder and are never committed.
---

# Local Extension Tests (tests/)

## What this is

- Scratch tests for **local verification only**. `tests/` at the repo root, gitignored, never committed.
- **node:test** (built into Node). No vitest, no jest. Run with `node tests/<file>.mjs`.
- Extension code is imported through **jiti** (the same loader pi uses): TS parameter properties, `.js` → `.ts` specifiers, and extension deps all work.
- **Core principle:** if you didn't watch the test fail, you don't know it tests the right thing. Violating the letter is violating the spirit.

## When to Use

- Extension output is a mystery — you need to see what it actually produces before trusting it.
- About to change an extension: lock in current behavior first, then prove the change.
- Bug found in an extension: reproduce it with a failing test, then fix.
- Refactoring: tests prove behavior didn't change.
- New logic: strict RED first.

## When NOT to Test

- Needs pi's live runtime (`ExtensionContext`, `ExtensionAPI`, tool registration, UI): can't run standalone. Test only the pure logic behind it. If important logic is buried in the runtime-coupled shell, that's a signal to extract it — ask before restructuring.
- Real side effects (network, OAuth handshakes, writing the real agent dir, spawning processes): mock at the boundary or use the in-memory variant. Never let a test mutate real state.
- Extension entries (`index.ts`): they run registration code at load. Import `src/` leaves instead.
- Trivial one-line passthroughs, generated code, config files: nothing to lock in.
- Nondeterministic code (time, randomness) without injection: flaky tests. Inject the clock/RNG or skip.
- Throwaway prototypes: explore freely; tests come when the behavior matters.

You can't test everything. When unsure whether a behavior earns a test, ask.

## Setup (first use)

1. `tests/` must be in the root `.gitignore` (already added).
2. Copy `assets/_bootstrap.mjs` (next to this SKILL.md) to `tests/_bootstrap.mjs`.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it, start over. No "keep as reference", no "adapt it while writing tests".

## Red → Green → Refactor

**RED** — one minimal test, one behavior, clear name, real code:

```js
// tests/pi-acks-storage.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "./_bootstrap.mjs";

const { InMemoryAccountStorageBackend } = await loadExtension("extensions/pi-acks/src/storage.ts");

test("in-memory storage persists writes", () => {
  const backend = new InMemoryAccountStorageBackend();
  backend.withLock(() => ({ result: null, next: "saved" }));
  assert.equal(backend.read((v) => v), "saved");
});
```

**Verify RED (mandatory):** run `node tests/<file>.mjs`. It must fail for the right reason — behavior missing, not a typo or import error. It passes already? You're testing existing behavior; fix the test.

**GREEN** — minimal code to pass. Nothing speculative, no features beyond the test.

**Verify GREEN (mandatory):** it passes, output is pristine, other tests still pass.

**REFACTOR** — only while green: remove duplication, extract helpers, deepen modules. No new behavior.

## Vertical Slices, Not Horizontal

One test → one implementation → repeat. Never write all tests first and all code after: you end up testing imagined shapes, and tests pass while behavior breaks. Each cycle responds to what the last one taught you.

## Seams

Test at the public boundary, never internals. Import through `loadExtension` and the extension's public API only. Prefer `src/` leaf modules over extension entries (`index.ts` may run registration code at load). Confirm which behaviors matter before writing tests — you can't test everything.

## Characterization Mode (existing code only)

Extensions have no tests and their output is unknown. This is the sanctioned exception you asked for: probe first, then assert.

1. Write a probe that logs the actual output via `loadExtension`.
2. Run it. Observe.
3. Lock in what you saw with assertions. If the output is wrong, that's a discovered bug — fix it via TDD (failing test first).

This exception never applies to new code. New code: strict RED first.

## Reuse & Keep Fresh

Tests persist in `tests/` and import live source via jiti — re-running them anytime reflects current extension code, not stale builds. They rot only if nothing re-runs them.

- **Run everything:** `node --test "tests/*.mjs"`
- **Name by extension:** `tests/<ext>-<subject>.mjs` (e.g. `pi-acks-storage.mjs`) so tests are findable when you touch that extension again.
- **Before changing an extension, re-run its tests.** A failing test means behavior changed — confirm it's intended, then update the assertion.
- **Lifecycle:** reuse and update the existing file when re-touching the same extension. Delete tests whose assertions no longer describe intended behavior — a stale test is misleading. Keep the ones that still guard real behavior.
- **Graduation:** a test that caught a real regression or encodes tricky logic is worth more than scratch. That's the signal to promote it into a committed suite — ask first, it's a bigger setup.

## Rules

- One behavior per file, clear name. "and" in a name? Split it.
- Assert on output, not on how it was produced. No tautologies: the expected value must not be computed the same way the code computes it.
- Mocks only at system boundaries (network, time). Never mock your own code.
- Never add test-only methods to extension code.
- Never fix a bug without a failing test that reproduces it.

## Red Flags

Code before test · test passes immediately · didn't watch it fail · "too simple to test" · "I'll add tests later" · "keep as reference" · "already manually tested" · mocking your own code · tautological assertions.

## Checklist

- [ ] Every function changed has a test; each was watched fail first
- [ ] Failures were real behavior gaps, not import errors
- [ ] Tests use public interfaces; mocks only at boundaries
- [ ] Extension code untouched (unless fixing a discovered bug)
- [ ] `tests/` still gitignored; `git status` shows nothing from `tests/`
