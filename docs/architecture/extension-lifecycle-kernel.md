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

## System verification

`extension-lifecycle-kernel.system.test.ts` treats the exported kernel as the test boundary. It does not replace lifecycle methods or assert mock call counts. The scenarios exercise:

- a real TCP server and persistent client through health check, dependency injection, provider stop, automatic consumer restart, scope disposal, and port release;
- real `EventEmitter` listeners and timers to detect resource leaks across stop, restart, and binding removal;
- a diamond dependency graph moving from one provider revision to another, including transitive stop and reactivation order;
- candidate, dependent, binding-removal, and scope-disposal cleanup failures with retained ownership and retry;
- invalid definitions, candidates, effect registration, dependency reads, binding conflicts, and missing objects through public error codes;
- deterministic revision/composition ordering and stable composition digests across generation changes;
- 2,000 seeded public lifecycle operations across four scopes, three dependent extensions, and two revisions while continuously checking public-state/composition agreement and exact live-resource counts.

The focused fault-matrix tests remain alongside these system scenarios. Coverage is collected from the compiled JavaScript with Node's test runner so the result measures the implementation that actually executes.
