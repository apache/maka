# Extension UI contributions

Extension UI is projected into the `desktop-ui` runtime root. UI may use a
separate Context/Fiber from Host runtime code because renderer authority,
failure, and cleanup boundaries differ. Maka does not create a shared Fiber
solely to make both trees look isomorphic.

## Surfaces and isolation

The trusted renderer owns Maka's native shell. Extensions may declare allowed
root, overlay, or named-slot surfaces. Nested slots do not grant DOM access to
Maka or sibling frames. Ordering is deterministic.

Each document runs in a sandboxed opaque-origin iframe. A token-bound bridge
provides declared configuration, Host state, RPC, optional Session access, and
safe-mode escape. Every request is checked against the active Entry, Fiber
generation, contribution identity, and permissions.

## Lifecycle

Documents are package bytes; enabled state, configuration, hierarchy, and
diagnostics live only in the Entry Tree. Candidate UI is invisible until
activation succeeds. Success switches the complete runtime snapshot; failure
leaves the active Fiber and frames current.

Disable/remove destroys frames and revokes bridge tokens. Restart reconstructs
the `desktop-ui` projection from the Entry Tree. Host-owned UI state may survive
frame reloads, but is not composition state and does not select package
versions.

Tool visualization writes structured results to Host state, allowing real Tool
execution to update sandboxed UI without renderer DOM authority.

Tests cover surface ordering, sandbox and bridge permissions, state/config,
nested slots, safe mode, failed replacement, cleanup, and Electron restart.
