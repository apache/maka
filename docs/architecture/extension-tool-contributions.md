# Extension Tool Contributions (Phase 2)

This vertical slice connects the Extension lifecycle authority to Maka's real Tool execution
path. It supports trusted static Tool revisions; it does not load arbitrary packages or scripts.

## Completion contract

Phase 2 is complete when all of these statements are true:

- installing a revision remains effect-free;
- activating an entry publishes its declared Tools into that entry's scope;
- the next Backend `send()` sees Core and active Extension Tools through one catalog;
- an Extension Tool call settles through the existing `ToolRuntime` rather than a parallel
  executor;
- Tool availability, argument validation, permissions, sandbox boundaries, durable settlement,
  and product routing remain authoritative;
- updating an entry switches the complete Tool surface transactionally, and a failed candidate
  restores the prior surface;
- stopping, removing, or disposing the entry retracts every Tool registration;
- Extension Tools cannot shadow Core Tools, Runtime protocol names, other extensions, or claim a
  provider-native protocol;
- an empty Extension registry produces the same Core Tool surface as before.

## Registration model

`ExtensionToolContributionRegistry` is a typed resource registry. A trusted Tool revision publishes
through `contributeExtensionTool`, which immediately hands the matching unregister function to
`ExtensionActivationContext.ownEffect`.

Candidate replacement is transactional. A candidate from the same entry may temporarily replace
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
path or executes user-authored code. The local owner can use `extension.composition.query` and
`extension.composition.mutate` to list, enable, disable, update, and remove entries. These operations
are deliberately absent from the remote-owner grant list.

`HostExtensionController` persists one Composition Entry tree containing package identity,
revision, configuration, enabled state, hierarchy, and the latest diagnostic in the root-private
Host control directory. The Controller has no parallel entry-state or configuration map. Desired tree
changes are committed before Runtime convergence so a process crash can resume from the same
authority. At startup it:

1. reads the persisted Composition Entry tree and installs revisions referenced by enabled entries;
2. projects the snapshot into the Runtime Context/Fiber tree through the Composition Loader;
3. retries entries individually when whole-snapshot activation fails and records diagnostics on the
   corresponding persisted entry;
4. restores Tool, UI, Hook, Event, Listener, Service, and Timer contributions from the same revision;
5. leaves the rest of Runtime Host available when Extension state cannot be recovered.

This completes the trusted in-process package lifecycle: a local administrator or Agent can install
one immutable package revision, control its Composition entries through the Runtime Host protocol,
and recover the same hierarchy and contributions after restart. Installed code is trusted with
application-level authority; manifest permissions remain approval and audit metadata rather than a
malicious-code isolation boundary.
