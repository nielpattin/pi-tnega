---
description: Remove code or a feature completely, with a full test and reference audit
argument-hint: "<symbol or feature name> [scope]"
---

Remove the requested code or feature completely and leave the repository in a coherent state. Work through the requirements in order. Do not report completion until every one is satisfied.

## 1. Understand the removal

Map the target before any edit. Identify:

- The production behavior being removed.
- Every caller and dependency.
- Tests that exist only because of this behavior.
- Fixtures, mocks, factories, helpers, snapshots, test data, configuration, examples, and documentation that exist only for this behavior.

Do not assume every related test should be deleted.

## 2. Remove the implementation

Delete the obsolete implementation and every reference that is no longer valid. Do not introduce a compatibility shim solely to keep obsolete tests passing.

## 3. Audit every related test

Classify each affected test:

- `KEEP`: it tests behavior that still exists.
- `UPDATE`: it tests valid behavior but references the removed API or implementation.
- `DELETE`: it tests behavior that no longer exists.
- `INVESTIGATE`: it is unclear whether the test represents surviving behavior. Inspect the requirement and the surrounding code before deciding.

Delete the `DELETE` tests. Do not weaken an assertion, replace a meaningful assertion with a trivial one, or edit a test merely to make it pass. A test must represent current intended behavior, not historical implementation.

## 4. Clean obsolete test infrastructure

After the tests are settled, remove test-only artifacts that have no remaining consumer: fixtures, mocks, factories, helper functions, snapshots, test data, imports, configuration, and examples. Preserve anything still used by a surviving test or by production code.

## 5. Search for leftovers

Search the entire repository for the removed symbols, removed API names, removed feature names, old test names, obsolete imports, obsolete configuration, and references in documentation or examples. Remove the unintended leftovers.

## 6. Do not create a pointless removal test

Do not add a test whose only purpose is that a removed symbol no longer exists, unless the absence or rejection itself is an explicit product requirement. Verify repository cleanup through reference searches, compilation or type checking, linting, and the surviving behavioral tests.

## 7. Verify

Run the relevant tests, build or type checks, lint or static analysis, and the repository searches. A green test suite alone is not proof that the removal is correct.

## 8. Final review

Confirm each point before finishing:

- The requested behavior is actually gone.
- No unintended caller remains.
- Tests for removed behavior are gone.
- Tests for surviving behavior remain.
- No test was weakened just to pass.
- Obsolete test infrastructure is cleaned up.
- The diff contains no unnecessary compatibility code.

Report what was removed, which tests were kept, updated, or deleted, and which verification steps were run.

Target: $@
