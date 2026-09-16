# Automatic compaction

Raft performs deterministic automatic compaction at safe settled boundaries. It rewrites older
session context into a bounded summary and retains a recent raw tail for continuity. The
compactor uses normalized session entries and typed trace facts; it does not infer meaning from rendered prose.

## Configuration

```json
{ "lifecycle": { "compaction": { "engine": "raft", "targetContextRatio": 0.65 } } }
```

The Raft engine is the default. Set `engine` to `"pi"` to defer to Pi's native compactor.
`targetContextRatio` is a bounded occupancy ceiling, not a target to fill: the compacted context
must fit under `contextWindow × ratio`, together with the reserve, reduction, and continuity
ceilings, and the tightest one wins. The raw continuity tail comes from Pi's own
`keepRecentTokens` compaction setting, not from `raft.json`. Per-model thresholds, when
configured, are clamped and evaluated only at a safe boundary.

## Deterministic summary

Compaction preserves user and assistant continuity, files, errors, Task outcomes, provider
facts, and operation order as bounded typed sections. It omits arbitrary oversized payloads and
marks omitted collections with counts or ranges where possible. Branch summaries are consumed
only when their typed envelope validates; prose does not become executable fact.

The active branch is compacted independently from abandoned branches. Source and lineage
identifiers remain stable for memory expansion, while a changed source invalidates an old
pointer without silently selecting a different entry.

## Verification and hooks

The host records compaction as part of the structural trace. A later compaction can use prior
typed facts without reparsing output text. Pi extension ordering still applies: another handler
may replace a non-cancelling result, and a cancellation stops the public dispatch. Raft does
not patch Pi's private runner.

Compaction is host-managed and automatic. Guest programs do not request, cancel, or control a
compaction operation.
