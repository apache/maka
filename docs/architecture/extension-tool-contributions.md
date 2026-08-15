# Extension Tool Contributions (Phase 2)

This vertical slice connects the Extension lifecycle authority to Maka's real Tool execution
path. It supports trusted static Tool revisions; it does not load arbitrary packages or scripts.

## Completion contract

Phase 2 is complete when all of these statements are true:

- installing a revision remains effect-free;
- activating a binding publishes its declared Tools into that binding's scope;
- the next Backend `send()` sees Core and active Extension Tools through one catalog;
- an Extension Tool call settles through the existing `ToolRuntime` rather than a parallel
  executor;
- Tool availability, argument validation, permissions, sandbox boundaries, durable settlement,
  and product routing remain authoritative;
- updating a binding switches the complete Tool surface transactionally, and a failed candidate
  restores the prior surface;
- stopping, removing, or disposing the binding retracts every Tool registration;
- Extension Tools cannot shadow Core Tools, Runtime protocol names, other extensions, or claim a
  provider-native protocol;
- an empty Extension registry produces the same Core Tool surface as before.

## Registration model

`ExtensionToolContributionRegistry` is a typed resource registry. A trusted Tool revision publishes
through `contributeExtensionTool`, which immediately hands the matching unregister function to
`ExtensionActivationContext.ownEffect`.

Candidate replacement is transactional. A candidate from the same binding may temporarily replace
its current Tool name while activating. Candidate cleanup restores the old entry; after commit, old
activation cleanup retires the replaced entry so a later stop cannot resurrect it.

Core Tool names should be supplied through `protectedToolNames` so conflicts fail during activation.
`compose` checks again when producing the execution snapshot, which catches changes in the Core
catalog between activation and admission.

## Runtime boundary

`AiSdkBackendInput.resolveTools` is an optional trusted reader for the full Core + Extension Tool
catalog. The Backend snapshots it once at the beginning of each `send()` and then routes that
snapshot through the same apply-patch projection, `ToolAvailabilityRuntime`, provider schema,
repair path, and `ToolRuntime` dispatch used by Core Tools.

This phase intentionally chooses the existing `send()`/Turn boundary. Refreshing at every physical
model request, pinning a larger Run composition, draining in-flight calls, and isolated
agent-authored code remain later decisions.

## Runtime Host ownership

`HostExtensionRuntime` is the in-process authority owned by the execution Runtime Host. It owns the
lifecycle kernel and Tool registry together and composes Session-scoped Extension Tools into both
the model Backend and the Host's available-Tool catalog.

The exact Tool snapshot selected at the beginning of `send()` is also written into the durable Run
Composition record. During Host drain, new Extension mutations are rejected while read-only Tool
resolution remains available to admitted work. The Extension authority closes after execution
domains, disposes every tracked Scope, and only then uninstalls its in-memory revisions.

## Trusted control plane and restart recovery

The Runtime Host composition may register a bounded catalog of trusted static Tool revisions.
`StaticTrustedToolExtensionLoader` resolves only those definitions; it never imports a workspace
path or executes user-authored code. The local owner can use `extension.catalog.query` and
`extension.catalog.mutate` to list, enable, disable, update, and remove bindings. These operations
are deliberately absent from the remote-owner grant list.

`HostExtensionController` persists desired bindings, enabled state, last-good revision, and the
latest diagnostic in the root-private Host control directory. Desired state is committed before
enable, update, and disable convergence so a process crash can resume the command. At startup it:

1. loads every available last-good and desired revision without activating code during install;
2. restores last-good bindings first;
3. attempts the desired upgrade through the lifecycle candidate transaction;
4. retains last-good Tools and records a diagnostic when loading, health check, or activation
   fails;
5. leaves the rest of Runtime Host available when Extension state cannot be recovered.

This completes the minimum trusted-static product slice: a Host integrator registers Tool
revisions, a local administrator controls them through the Runtime Host protocol, and enabled
bindings survive process restart. Manifest/npm discovery, third-party code isolation, UI, an Agent
authoring Tools, and model-call-level hot swapping remain outside this trust boundary.
