# Component calculus

The internal component calculus describes safe provider composition. It is an implementation
model, not a guest API.

## Declarations

A component has a stable identifier, a definition name, required capabilities, provided
namespaces, configuration, and an effect guarantee. Requirements are exact action refs. An
optional requirement may leave the component waiting; a required missing capability blocks
activation.

## Publication

The supervisor resolves a versioned capability view, validates the definition, and stages its
provider before publication. A publication is visible only after its requirements and effect
claims pass validation. Provider names remain unique within a registry generation.

## Effects and replacement

Effects are classified by their resource footprint. Independent effects may proceed in
parallel; overlapping or unknown revertible effects are serialized or rejected. Child scopes
unwind before their parent. Replacement retires the old generation, waits for active leases,
and runs inverses in LIFO order. Epoch checks prevent stale fibers from publishing results.

These rules support strict validation, atomic reload, automatic compaction hooks, and safe
provider dispatch without exposing lifecycle controls to guest code.
