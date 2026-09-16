# Internal component supervisor

Raft uses an internal `ComponentSupervisor` to manage provider definitions. It is not a guest
action namespace.

A component declares a stable id, provisions, requirements, effect guarantee, and activation
configuration. The supervisor validates these declarations, stages activation, waits for
required capabilities, and publishes the resulting provider slice atomically.

Replacement creates a new generation, retires the old one, and waits for active calls and child
fibers to unwind before disposal. Effect scopes run inverse operations in reverse order. Epochs
prevent stale work from publishing after a replacement, and conflicting revertible effects are
reported without silent reordering.

The supervisor is host infrastructure for `ActionRegistry`, automatic provider installation,
strict validation, and safe reload. Guest programs use the published action namespaces, not
component lifecycle controls.
