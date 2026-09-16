# Audit traces

Raft records a bounded structural trace for each `raft_exec` invocation and its nested host
calls. The trace preserves the exact ref, provider, action, operation order, outcome, failure
stage, and typed file facts when available.

## Validation boundary

An action attempt is recorded before reference resolution and authoritative schema validation,
so rejected calls remain diagnosable. Preparation, approval, provider invocation, result
middleware, cancellation, and deadline outcomes are represented as typed stages. Errors are
bounded and do not change the requested capability set.

## Privacy boundary

Trace projections retain structural identifiers and bounded operational facts. Arbitrary
arguments, provider payloads, secrets, and model prose are not copied into trace metadata.
Callers must keep credentials out of refs, paths, commands, payloads, and returned values.

## Reconstruction

Compaction and memory expansion consume normalized source entries and typed trace facts. They do
not infer operations from rendered prose. A valid source or lineage change invalidates a stale
pointer without silently shifting the selected record.
