# Extension composition lifecycle

Maka's Extension lifecycle is a two-tree design derived from DSH/Cordis. There
is no persistent Revision, Binding, candidate record, or last-good object.

## The two trees

The **Composition Entry Tree** is the only durable control state. Each Entry
contains identity, optional package identity, enabled state, configuration,
dependency injection, isolation/interception declarations, children, and the
latest diagnostic. An Entry without a package is a structural group and does
not require a no-op Fiber.

The **Context/Fiber Tree** is a process-local projection. Executable Entries
create Contexts and Fibers below `profile`, `desktop-ui`, or `session:<id>`.
A Fiber owns its provided services, injected dependencies, children, and every
registered Tool, UI, Event, Listener, Service, and Timer effect.

Entry parentage determines runtime ownership, but the trees are intentionally
not isomorphic: structural Entries can be skipped, and Host/UI projections can
use separate runtime Contexts when their authorities differ.

## Mutation and replacement

Entry mutations are serialized and persisted atomically. The loader stages the
affected subtree in fresh Contexts, validates and activates it, then switches
the live projection. A failed candidate is disposed without replacing the
current Fiber. Successful replacement disposes the previous Fiber only after
the new projection is active. Unrelated Fibers retain identity and effects.

Reloading package bytes is a runtime projection change, not a new durable
package version. Only Entries using that package are reconciled. Multi-operation
edits restore and reproject the prior Entry snapshot when a later operation
fails.

## Dependencies and scope

Package dependencies resolve through Fiber Contexts. `inject`, `isolate`, and
`intercept` shape child Contexts rather than parallel maps. Missing required
providers prevent activation. Profile contributions can be inherited by
Session roots; Desktop UI uses a separate root because its authority and cleanup
boundary differ.

## Recovery and inspection

Startup reads the persisted Entry Tree, installs referenced package bytes, and
reconstructs the runtime projection. Fiber state is never restored from disk.
Failed Entries retain a bounded diagnostic while unrelated Entries recover.

Inspection reports both layers separately. Consumers must not treat Fiber
generations as durable identities.

## Required invariants

- The Entry Tree is the only durable composition authority.
- Structural Entries may exist without Fibers.
- Every live contribution is owned by exactly one Fiber lifecycle.
- Failed replacement preserves the current active Fiber.
- Disable/remove releases all effects and descendants.
- Restart reconstructs Fibers from Entries and package bytes.
- Session and Desktop UI scopes cannot leak into one another.
