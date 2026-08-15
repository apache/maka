# Extension UI Contributions

UI is the second typed Extension contribution adapter. It is not a Tool view,
does not depend on Agent Graph, and may be the only contribution in a package.
Tool, UI, and future Hook adapters share only the Extension identity, immutable
Revision, Binding, Scope, current/candidate commit, recovery, and cleanup model.

## Product shape

The fixed Desktop bootstrap is deliberately thin:

```text
Theme + Runtime Host readiness + UI snapshot loader
  -> official Maka UI snapshot (trusted fallback)
     -> committed app.slot contributions at named official seats
  -> or one committed app.root Revision
  -> plus committed app.overlay contributions
```

The existing Maka `AppShell` is therefore a shipped UI snapshot, not an
unreplaceable product frame. An `app.root` Revision replaces the whole client
surface. Maka does not inject navigation, conversation, Composer, responsive
layout, or a workspace region around it. The selected root owns those product
decisions. The official snapshot remains only as the fail-open recovery surface.

The official snapshot exposes three typed composition seats in V1:

- `sidebar.footer`
- `conversation.header`
- `settings.content`

An `app.slot` contribution names exactly one seat and renders as an independent
opaque-origin iframe. Slot packages have their own immutable Revision and
Binding, so adding, updating, stopping, rolling back, or failing one slot does
not reload the official root or mutate sibling slots. Ordering is deterministic
by priority and contribution identity.

A custom `app.root` owns its complete document and does not inherit the official
snapshot's slots in V1. `inspect_ui` reports this compatibility boundary: the
official slot inventory is returned while the official root is active, and the
slot list is empty with an explicit reason while a dynamic root is active.

The snapshot digest is the identity of the admitted UI Composition: the exact
ordered committed Binding/Revision contribution set. The Renderer switches one
complete digest at a time and stamps it on the root host. A candidate Revision
is invisible until its Binding commits, so a failed candidate cannot partially
mutate the current Composition.
`Cmd/Ctrl+Shift+Backspace` enters renderer-local safe mode without mutating the
installed Binding.

## Package and isolation

A package may contain only `maka.ui.json`, or carry `maka.ui.json` and
`maka.tool.json` together. In the combined form, both manifests declare the
same Extension identity and the complete directory produces one content hash,
one immutable Revision and one lifecycle commit. UI and Tool remain typed,
independent contributions; separate Bindings may project that exact Revision
into the Desktop UI scope and a Session scope. Installation does not render or
execute package code.

Dynamic documents render in Chromium sandboxed iframes with an opaque origin.
They receive neither Electron APIs nor the Maka preload bridge. A Host-injected
CSP disables navigation, forms, objects, nested frames, and network by default;
the manifest may opt into bounded HTTPS/WSS reads. This provides arbitrary
HTML/CSS/client JavaScript freedom inside the UI document without executing
agent-authored code in Electron main or Maka's privileged renderer realm.

Packages that declare `permissions.hostState` receive a narrow `window.makaUI`
SDK. Its `getState`, `setState`, and `deleteState` calls cross a per-frame token,
the trusted Desktop message broker, strict Runtime Host protocol codecs, and an
active Binding/Revision check before reaching root-private durable state. The
iframe never chooses its Extension identity and a stale frame loses authority
immediately after update, stop, or rollback.

A complete root may additionally request `permissions.sessionAccess`. Import
confirmation and Agent definition expose this authority explicitly. The frame
then receives only `window.makaUI.sessions.list/send/stop`; the trusted parent
validates identities and prompt size, creates Turn ids, and returns a bounded
Session projection. This does not expose the Maka preload object, Runtime Host
protocol, paths, credentials, attachments, settings, or arbitrary Session APIs.
Overlay and slot contributions cannot exercise this capability.

Packages may also declare an allowlist of Host method names and an ES module
that implements them. `window.makaUI.invoke(name, args)` crosses the same
per-frame broker and exact active Binding/Revision check. The selected handler
runs in a one-shot managed sandbox with no workspace access, no secrets, and
network disabled unless declared. Its JSON result returns to that frame only.
The UI document and Host service belong to the same content-addressed Revision,
so update, failed health check, rollback, stop, uninstall, and restart recovery
cannot mix frontend and backend versions.

## Commit boundary

`ExtensionUiContributionRegistry` retains both current and candidate activation
tokens. The Runtime Host projects only entries whose exact Binding Revision is
currently committed by `ExtensionLifecycleKernel`. A renderer query during a
candidate health check therefore continues to see the old document. Failed
candidates never become visible, and stop/remove/update cleanup retracts the
owned entries.

The Desktop renderer reads `extension.ui.snapshot` for the `desktop-ui` scope.
The snapshot includes a deterministic digest and complete committed documents;
the renderer keeps the prior snapshot when the Host is reconnecting.

## Agent flow

The built-in UI authoring surface is independent from Tool authoring:

```text
inspect_ui -> define_ui -> test_ui -> manage_ui activate/update/stop/delete
```

`test_ui` exercises the actual Extension lifecycle in an isolated preview
Scope without changing the Desktop Binding. `manage_ui update` uses the same
current/candidate and last-good recovery path as other Extension revisions.
`inspect_ui` also returns the currently available official slot names so an
Agent can select a supported seat before defining an `app.slot` contribution.

An Agent that uses a separate business Tool may call `publish_ui_state` with
that Tool's structured snapshot or patch. The Host resolves the currently
committed Desktop Binding and exact Revision before writing durable state; the
UI remains a passive projection and cannot use this path to invoke a Tool.

For an intentionally combined package, a Tool declaration may instead name a
`visualization.stateKey`. `invoke_tool` writes the successful structured result
to the matching active Desktop UI Revision automatically. The client remains
passive and the update is admitted only when the Tool owner and UI Binding have
the same Extension id and exact Revision.

## Current boundary

The shipped bridge provides typed durable Host state, declared request/response
Host methods, and the separately granted bounded Session surface, not arbitrary
Electron or Runtime Host access.
`publish_ui_state` remains the explicit seam for unrelated Tool and UI
Revisions. Same-Revision packages may opt into the declared visualization seam;
no arbitrary Tool can select or mutate an unrelated UI. Push event subscriptions
and DOM access to the official snapshot remain out of scope. The one-second UI
Composition refresh is also a temporary
transport seam; a future catalog-change subscription can replace it without
changing package or lifecycle semantics.

## Composition V1 acceptance

The implementation is judged by lifecycle and authoring outcomes, not by a
claim that slots increase the visual ceiling of `app.root`:

- one official root composes with at least five independently bound slots;
- 1,000 child Revision updates cause zero root Revision changes and preserve
  every sibling Binding;
- a failed child candidate preserves the current child, root, and all siblings;
- adding supported sidebar, conversation, or settings UI requires zero edits to
  the official root implementation;
- cold-start p95 may regress by at most 5%; and
- in a 20-run same-task Agent A/B, the component version targets at least 30%
  lower median model requests and tokens, at least 80% first-pass `test_ui`, and
  at least 25% lower median completion time.

The first three guarantees are deterministic system-test gates. Startup and
Agent-authoring targets require measured benchmark runs and are not inferred
from unit-test timing.

## Product entry points

The same package path is reachable in two ways:

- `扩展 → UI → 导入 UI 扩展` selects a local package directory, previews its
  identity and permissions, asks for confirmation, then installs and enables it.
- Agent authoring uses `inspect_ui → define_ui → test_ui → manage_ui` and may
  opt into the identical Host state bridge and package-private Host methods.

Both paths share immutable revisions, bindings, atomic updates, rollback,
restart recovery, sandboxing, and the same frontend-to-backend bridge.
