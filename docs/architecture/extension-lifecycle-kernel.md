# Extension Lifecycle Kernel (Phase 1)

This module implements the product-independent lifecycle and revision semantics from issue #2973. It deliberately does not register Tools, UI, hooks, or execute dynamic scripts.

## Authority and objects

- An **Extension** is a stable identity.
- A **Revision** is immutable after `install`. Installing a revision never executes extension code.
- A **Binding** selects one exact revision for one scope. Only one binding for an extension may exist in a scope.
- A **Candidate** owns everything allocated by `prepare`, `healthCheck`, and `activate` until it either becomes current or is rolled back.
- A **Current Activation** owns its exposed dependency value and every registered effect.
- A **Composition Snapshot** is an immutable, deterministic view of the active revisions and contribution descriptors in a scope.

## Lifecycle

```text
install revision (no effects)
  -> enable binding
  -> wait for same-scope dependencies
  -> prepare candidate
  -> health check
  -> activate
  -> commit current
  -> stop / remove binding / uninstall revision
```

Updates use current/candidate semantics:

```text
current remains active
  -> prepare + health-check candidate
  -> stop active dependents
  -> activate candidate
  -> commit candidate as current
  -> dispose old current
  -> reactivate dependents against the new dependency value
```

If preparation, health checking, or activation fails, the candidate is disposed in reverse effect-registration order and current remains committed. If candidate activation had already stopped dependents, they are reconciled back against the old current.

## Invariants

- All mutations are serialized by the kernel.
- Dependencies resolve only inside the binding's scope.
- Missing dependencies produce `waiting`; activating the provider reconciles waiting consumers.
- Stopping a provider stops transitive dependents before the provider.
- Dependency cycles fail without executing extension code.
- Effects are disposed in reverse registration order; failed disposers remain inspectable and retryable.
- A revision cannot be uninstalled while any binding, current activation, or candidate references it.
- Previously returned composition snapshots never mutate.

## Adapter boundary

Future contribution adapters register their reversible work through `ExtensionActivationContext.ownEffect`. A Tool adapter, for example, will own the Tool registry entry's disposer. The kernel does not bypass Maka's existing Runtime, permission, sandbox, or Run-composition authorities; those integrations belong to later phases.
