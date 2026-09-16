# Provider component calculus

The provider specialization applies the internal component calculus to built-in provider slices.

## Built-in slices

The host installs the MCP adapter, agent Task adapter, and memory adapter according to configuration.
through `ActionRegistry`; it cannot add undeclared refs during a call.

## Requirements

A provider definition names required action refs and optional capabilities before activation.
The supervisor resolves descriptor hashes and rejects invalid or missing required refs. A
provider replacement is staged as a new generation, then committed only after its effect and
capability checks pass.

## Safety properties

Provider effects carry risk and resource metadata. The registry applies validation, approval,
cancellation, result bounds, and trace recording to every generation. The supervisor retires
old generations only after active leases settle, so a reload cannot invalidate an in-flight
call or publish stale data.
