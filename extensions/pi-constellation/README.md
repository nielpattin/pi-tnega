# pi-constellation

Deterministic, zero-LLM compaction for Pi.

## Behavior

The extension registers `session_before_compact` and the `session_inspect` tool. When Pi compacts a session, it replaces model-generated summarization with bounded structural extraction from the messages Pi selected for removal. The inspection tool navigates the persisted source session incrementally by overview, branch, message, surrounding context, or search. Its Pi TUI renderer keeps results collapsed to a one-line summary until the tool expansion key reveals the full result.

It does not:

- prune or rewrite context during normal requests
- queue tool results
- load an entire session into model context
- display status, cache, or history UI
- call a model

Pi keeps the recent tail selected by `firstKeptEntryId` verbatim. Original session history remains in the session JSONL. Compaction still changes the historical prompt prefix, so the first request after compaction may rebuild the provider cache.

## Summary sections

When source material exists, the deterministic summary includes bounded sections for:

- Goal
- Constraints and Preferences
- Files and Changes
- Decisions and Progress
- Errors and Blockers
- Next Actions
- Chronological Brief

Previous deterministic summaries are parsed and carried forward without an LLM.

Extracted facts include stable source references such as `[u:1700000000000]`, `[a:response-id:p0]`, and `[r:tool-call-id]`. The bundled `session_inspect` tool accepts these references for `message` and `around` navigation, so an agent can verify compacted facts against the persisted session.

Compaction details report input tokens, estimated checkpoint tokens, retained sections, and estimated reduction percentage.

## Scope

This extension adopts Blackhole's structured checkpoint, provenance, and recall guidance without copying its observational-memory workers, model fallback pipeline, automatic mid-run compaction patch, or second recall implementation.

## Configuration

Configuration lives at:

```text
~/.pi/agent/.ext-config/pi-constellation.json
```

```json
{
    "enabled": true,
    "compaction": {
        "maxChars": 12000,
        "maxItemsPerSection": 12,
        "maxBriefLines": 80,
        "maxRecentTailChars": 4000
    }
}
```

Removed pruning settings in older configuration files are ignored.

## Verification

```text
node --test tests/pi-constellation-compaction-only.mjs tests/pi-constellation-compaction.mjs
pnpm lint extensions/pi-constellation
pnpm --dir extensions/pi-constellation check
pnpm typecheck
pnpm fmt extensions/pi-constellation
```
