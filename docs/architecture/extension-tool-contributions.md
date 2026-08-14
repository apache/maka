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
model request, pinning a larger Run composition, draining in-flight calls, persistence, an install
control plane, and isolated agent-authored code remain later decisions.

## Runtime Host ownership

`HostExtensionRuntime` is the in-process authority owned by the execution Runtime Host. It owns the
lifecycle kernel and Tool registry together, exposes the trusted-definition lifecycle seam for a
future control plane, and composes Session-scoped Extension Tools into both the model Backend and
the Host's available-Tool catalog.

The exact Tool snapshot selected at the beginning of `send()` is also written into the durable Run
Composition record. During Host drain, new Extension mutations are rejected while read-only Tool
resolution remains available to admitted work. The Extension authority closes after execution
domains, disposes every tracked Scope, and only then uninstalls its in-memory revisions.

This wiring does not define package discovery, persistence, restart restoration, or a remote
install/enable API. Those are control-plane concerns layered on this Host-owned authority.
