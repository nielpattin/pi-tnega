# Speculative programmatic tool calling

Raft can pre-launch eligible read calls while a `raft_exec` program is still streaming.
This overlaps generation with safe host reads without changing program semantics.

## Eligibility

Speculation is enabled for bounded, read-only calls whose descriptor has no effect and cannot
prompt for approval. The scanner accepts direct dotted calls with literal JSON-compatible
arguments. Dynamic expressions, ambiguous namespace bindings, and calls that can mutate data are skipped.

The gate checks the live descriptor and policy before launch. The normal call repeats
resolution, validation, approval, freshness, and audit checks before consuming a cached result.

## Freshness contract

A cached result is served only when:

1. the mutation epoch is unchanged;
2. the source freshness check still holds for path reads; and
3. the invocation and provider policy are still valid.

Serving removes the cached entry, so one speculative call cannot answer two occurrences. A
failed or unused speculative call is discarded and the real call executes normally. Resetting kernel or policy changes abort pending work and clear cached results.

## Supported kernels

The scanner supports checked TypeScript in QuickJS and sandboxed Python in Monty. Native
TypeScript and CPython bypass speculative warming because their ambient effects cannot be
bounded by guest epochs. Python scanning uses Python literals and the same host argument
normalization as ordinary calls.

## Observability

The structural trace marks a call served from speculation. Buffered side-channel previews and
argument updates are replayed into the real audit. A speculation miss is intentionally
uninteresting to the program: it is just a normal provider call.

## Configuration

`speculation.enabled` is the master switch. Concurrency, retained-entry, stream-buffer, and
entry-lifetime bounds limit resource use. An optional MCP allowlist may opt stable network reads
in; network results have no external-world freshness guarantee.

Speculation never applies to writes, execution, agent Tasks, or uncertain calls. It cannot
bypass approval or change the action surface.
