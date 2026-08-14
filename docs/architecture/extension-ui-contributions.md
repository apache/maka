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
  -> or one committed app.root contribution
  -> plus committed app.panel sidecars inside the official window
  -> plus committed app.overlay contributions
```

The existing Maka `AppShell` is therefore a shipped UI snapshot, not an
unreplaceable collection of small slots. A UI Extension may replace the whole
`app.root`, or use `app.panel` to appear as a sidecar window while the trusted
Maka conversation and Composer remain visible and operable. The official
snapshot remains available as the fail-open recovery surface.
`Cmd/Ctrl+Shift+Backspace` enters renderer-local safe mode without mutating the
installed Binding.

## Package and isolation

A UI package contains `maka.ui.json`, one or more immutable HTML documents, and
may include an optional package-private Host service. Installation validates,
hashes, and copies the entire package into the root-private `ui-packages-v1`
Store without rendering or executing it.

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

An Agent that uses a separate business Tool may call `publish_ui_state` with
that Tool's structured snapshot or patch. The Host resolves the currently
committed Desktop Binding and exact Revision before writing durable state; the
UI remains a passive projection and cannot use this path to invoke a Tool.

## Current boundary

The shipped bridge provides typed durable Host state and declared
request/response Host methods, not arbitrary Electron or Runtime Host access.
`publish_ui_state` is an explicit Agent orchestration seam, not an implicit
cross-contribution dependency: a business Tool cannot mutate UI state by
itself. Push event subscriptions and DOM access to the official snapshot remain
out of scope. The one-second Desktop snapshot refresh is also a temporary
transport seam; a future catalog-change subscription can replace it without
changing package or lifecycle semantics.

## Product entry points

The same package path is reachable in two ways:

- `扩展 → UI → 导入 UI 扩展` selects a local package directory, previews its
  identity and permissions, asks for confirmation, then installs and enables it.
- Agent authoring uses `inspect_ui → define_ui → test_ui → manage_ui` and may
  opt into the identical Host state bridge and package-private Host methods.

Both paths share immutable revisions, bindings, atomic updates, rollback,
restart recovery, sandboxing, and the same frontend-to-backend bridge.
