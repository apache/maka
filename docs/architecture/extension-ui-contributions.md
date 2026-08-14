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
  -> plus committed app.overlay contributions
```

The existing Maka `AppShell` is therefore a shipped UI snapshot, not an
unreplaceable collection of small slots. A UI Extension may replace the whole
`app.root`; the official snapshot remains available as the fail-open recovery
surface. `Cmd/Ctrl+Shift+Backspace` enters renderer-local safe mode without
mutating the installed Binding.

## Package and isolation

A client-only package contains `maka.ui.json` and one or more immutable HTML
documents. Installation validates, hashes, and copies the package into the
root-private `ui-packages-v1` Store without rendering or executing it.

Dynamic documents render in Chromium sandboxed iframes with an opaque origin.
They receive neither Electron APIs nor the Maka preload bridge. A Host-injected
CSP disables navigation, forms, objects, nested frames, and network by default;
the manifest may opt into bounded HTTPS/WSS reads. This provides arbitrary
HTML/CSS/client JavaScript freedom inside the UI document without executing
agent-authored code in Electron main or Maka's privileged renderer realm.

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

## Current boundary

This slice intentionally has no package-private Host RPC, shared state service,
DOM access to the official snapshot, or cross-contribution dependency on Tools.
Those can be added later as separate typed capabilities. The one-second Desktop
snapshot refresh is also a temporary transport seam; a future catalog-change
subscription can replace it without changing package or lifecycle semantics.
