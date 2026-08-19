# Extension Tool contributions

Tool declarations are effects of an executable Composition Entry. The Entry
Tree persists configuration and enabled state; the runtime Fiber owns the
loaded handler and registry registration.

Activation validates names, descriptions, schemas, handler presence, and
configuration before exposure. Failed activation cannot partially publish
Tools. Disable, remove, or replacement releases registrations through Fiber
disposal.

Tool resolution is scope-aware. Installation alone never makes a Tool globally
callable. Each model turn captures an immutable Tool snapshot; an in-flight
handler remains valid until that turn releases its lease, while new turns
resolve the replacement Fiber. This requires no durable Revision/Binding model.

The core `maka.tools.execute` Event wraps real execution. `around` Listeners can
observe, transform, gate, or wrap the call. Tool visualization may publish a
successful result into Host-owned UI state using `visualization.stateKey`.

Tests cover validation, duplicate names, scope isolation, Hook ordering,
in-flight replacement, failed candidate preservation, restart recovery, and
exact cleanup after disable/remove.
