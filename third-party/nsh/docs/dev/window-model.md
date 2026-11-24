# The window model: app host and app windows (design)

Status: implemented in code, 2026-11-17 (major-version change); the native
window lifecycles are 待平台验证 on macOS and Linux. On Windows the crate's
tests ran in this delivery; the real-host window behaviours are still
待平台验证. The macOS host fixtures and native tests are updated; running them
needs macOS and Linux.
This replaces the privileged main window with an app host and first-class app
windows.

Delivered: the invisible host; per-window roots, owners, key scopes,
placement and close policy; the window registry and explicit `<Window>`
scenes; `Application.setQuitMode`, `on("reopen")` and
`on("lastWindowClosed")`; nsh.json `application.quitMode`;
window-scoped and app-scoped `keymap.bind` (JS and Rust); the headless model
with zero, one and N windows; and the macOS/Windows/Linux backends' window
lifecycles.

Not delivered in this version (recorded, not hidden):
**per-window menu bars** on Windows and Linux (`<MenuBar>` /
`WindowRef.setMenuBar(items)`) are not implemented; `Menu.setApplicationMenu`
belongs to the hidden app host and is not shown on the platforms' own bars,
so an app that needs a visible menu bar uses its own controls and shortcuts.
**Menu roles** (Close, Minimize, Zoom) on Windows and Linux still act on the
host's window rather than the focused window; macOS's responder chain acts on
the key window. **GPUI** is not migrated: its host and Linux window behavior
follow the old model. **`windowSize()`/`pixelRatio()`** report the host
surface and the host display, not the calling window's, except on Windows,
Linux and macOS, where they follow the app's primary window (the first of
its own windows still open) as the user resizes or moves it, and the host's
only while it shows none. On Linux the FPS panel (`--fps`) shows in that
window too, and counts its frames, as it does on macOS (#2866). **`defaultVisible`**
no longer applies: the host never shows, and an app that starts without a
window opens none; the key is still parsed but has no effect.

Rust app roots have no implicit window: a Rust root that returns a plain
view renders into the hidden host, invisible on the desktops, and
`current_window()` there is [`main_window`] (the app root's ref). A
cross-platform Rust app declares `element::desktop::window()` there; it
renders its content off the desktops. The Rust `main_window()` ref remains for
app-root commands and is not a user window: its window requests (`show`,
`hide`, `focus`, `close`, `minimize`, `restore`, modes and bounds) do
nothing, though attributes and `request_attention` still reach the app
(the page title, the Dock icon or the launcher entry; the hidden host has no
taskbar button on Windows), and `quit()` ends the app. `current_window()`
in the app root is that ref, as `currentWindow()` is the main window's there.

## Summary

The model this replaces had one engine root: the main window was the root
view tree and every app-owned window was a dialog root inserted into that
tree. Closing the main window ended the app and closed every other window;
menus, menu roles and keyboard bindings were app-level and main-centric.

That model fit single-window apps, mobile apps and apps whose extra windows
are tools. It did not fit document-based desktop apps: a project manager that
opens one window per project, a launcher that gives way to a document, or any
app where "closing this window" must not mean "quit and close everything".

This design makes the top-level window the first-class object:

- an invisible **app host** owns the event loop, application state, quit
  policy and application menu;
- every visible window has its own root view tree, title bar, menu bar (on
  Windows and Linux), keyboard scope, placement and close policy;
- `"main"` is a conventional first-window id, not a privileged window;
- closing any window destroys only that window; the app quits when the last
  window closes (policy), or when the app calls `Application.quit()`.

The design keeps one app JS context, as Qt and AppKit keep one application
process. Window isolation comes from one root tree and one reactive owner per
window, not from one JS VM per window.

## What the model replaced

- `Core` creates one root view (`ROOT_ID`, `crates/nsh-core/src/core/mod.rs`)
  and lays out the app in it.
- The main window is that root. Its platform window is the surface
  (`Surface` on macOS, Windows, Linux and GPUI; `NshView` on Android).
- `Window.open` and `<Window>` create a **dialog root** (a modal node) and
  insert it into the main root
  (`crates/nsh-js/src/window.rs`, `crates/nsh-core/src/element/desktop.rs`).
  The platform shows that root in a native window.
- Closing the main window ends the runner and closes every app window
  (`crates/nsh-platform-macos/src/app.rs` `windowWillClose`,
  `crates/nsh-platform-windows/src/window.rs` `PostQuitMessage`,
  `crates/nsh-platform-linux/src/window.rs`).
- Closing the last app-owned window does not quit while the main window exists.
- The application menu is the main window's menu bar on Windows and Linux and
  the system menu bar on macOS. Window roles (`close`, `minimize`, `zoom`)
  target the main window on Windows and Linux
  (`crates/nsh-platform-windows/src/chrome.rs`,
  `crates/nsh-platform-linux/src/chrome.rs`); macOS uses the responder chain.
- `keymap.bind` builds one app-wide table with no window field
  (`crates/nsh-js/src/keymap.rs`). The core's `KeyBinding::window` and
  `Keymap::find_in` already support a window scope, and the Rust `on_key`
  already uses it.
- All windows share one JS context, one reactive graph and one engine thread.

The last point is not a defect by itself. Qt, AppKit and WinUI also keep one
application process. The defect for document apps is the privileged root and
the main-centric lifecycle, menus and keys.

## Goals

1. Top-level windows are equal. A window can be opened, closed, hidden,
   focused, minimized and restored independently of every other window.
2. The application lifecycle belongs to the app host, not to a window:
   closing a window does not implicitly quit; the last window closes according
   to an explicit policy; `Application.quit()` always quits.
3. Each window has its own root view tree, layout, reactive owner and
   disposal. App-level state lives in the app root and survives windows.
4. Each window has its own keyboard scope. App-level shortcuts are explicit.
5. Windows and Linux can give any window its own menu bar; macOS keeps the
   global application menu and a Window menu generated from the registry.
   (Per-window menu bars are not implemented in this delivery.)
6. Window roles, menu accelerators and focus resolve to the focused or owning
   window, never to a hidden "main" window. (Windows and Linux roles still
   target the host in this delivery; macOS follows the key window.)
7. Every app declares its windows explicitly with `<Window>`; NSH does not
   create or wrap an implicit window. Migrating an existing app is a
   major-version change.
8. The model works on macOS, Windows, Linux and the headless desktop model;
   iOS, Android and the web keep one surface, where `<Window>` renders its
   content and the window APIs report no window.

## Non-goals

- One JS VM per window. One app context with per-window roots is the target,
  as Qt and AppKit keep one process. Per-window VMs are a separate isolation
  feature, not a requirement for native window behavior.
- Multi-process windows (Electron-style renderer processes).
- OS-level document restoration (`NSWindow` restoration, Windows Restart
  apps). The app restores its own windows from `WindowPlacement` and app
  state.
- Changing the mobile and web single-window model.
- Replacing the native view, layout, text, input or canvas architecture.

## Target model

```
Application Host (invisible)
├─ event loop, app environment, Storage, capabilities
├─ Application: quit mode, quitRequest/quit, reopen, openFiles,
│                secondInstance, launch at login, tray, global shortcuts
├─ Application menu (macOS; the system menu bar)
├─ WindowRegistry: id -> AppWindow
│   ├─ Window "main"        normal window: root tree, title bar, menu bar,
│   │                       key scope, placement, close policy
│   ├─ Window "document:a"  normal window: the same
│   └─ Window "settings"    dialog/panel: the same, owned if it has a parent
└─ One app JS context
    ├─ app root: app-level components, signals and effects
    └─ window roots: one reactive owner and one view tree per window
```

### App host

The app host is not a user window. It owns:

- the platform event loop and the engine thread;
- application-level environment and `Storage`;
- `Application` events and the quit mode;
- the application menu on macOS (the system menu bar) and the default
  application menu on Windows and Linux;
- the window registry and focus;
- tray, global shortcuts, single-instance and file-open routing.

On Windows the host's dispatcher is a message-only window (`HWND_MESSAGE`)
and the engine surface is a hidden top-level window; on Linux the host is the
`GtkApplication`; on macOS it is the `NSApplication` delegate. None of them is
a visible top-level window.

### App root

`mount(App)` renders an app-level root tree. It has no native surface and no
layout of its own for the platform; it exists so app-level components,
signals, effects, menus and window declarations survive while windows open
and close.

`<Window>` elements in that tree are **scenes**: they are not mounted into a
parent view. Each one creates a window root. A `<Window>` declared inside
another window's content is a scene of that window (it closes with it), not
a view. A normal view returned by `mount` outside a `<Window>` is a released
app's main window: `mount` wraps it in an implicit first window (`id`
`"main"`, as `<Window id="main">` declares) unless the root turns out to
declare `<Window>` scenes of its own. The implicit window's content is the
views and text the root returned; an empty root gets an empty window, as the
old main window was. It opens with what the root set and asked of it
(`set`, `setMode`, `hide`, ...), `titleBar()` and `windowState()` read it,
and `capabilities.windows` does not gate it: it is the main window the app
always had. A `<Window>` that starts closed still makes the root a window
app, so no implicit window opens for it.

`currentWindow()` is valid while rendering inside a `<Window>`, and in the
app root it is the main window's ref (the implicit first window, or the
app's one surface off the desktops); it throws only when called outside a
render. Components that may be used in either place take a `WindowRef` as a
prop.

Off the desktops (iOS, Android, the web and a terminal app) there are no
windows: a `<Window>` renders its content, while open, as part of the app's one
surface; `currentWindow()` is the app's one surface, as the old main window
was, and `windows()` lists only it; `focusedWindow()` is `null`,
`windowState()` is `null` and `titleBar()` is all 0.

### Window roots

A window root is a top-level view tree:

- it has its own layout root, measurement, commit and mount batch;
- it has its own reactive owner; unmounting the window disposes it;
- it has its own native window (HWND, NSWindow, GTK window, or a headless
  model window), title bar, attributes, placement and close policy;
- its platform events (`closePress`, `close`, `focusChange`, `boundsChange`,
  `displayChange`) are unchanged;
- a dialog/panel with an explicit `parent` is owned by that window: it stays
  above it and closes with it. A normal window has no parent by default and
  is independent.

Multiple window roots share the engine thread and the JS context. A commit
that changes one window produces a mount batch for that window; other windows
are not remounted. Heavy JS work still blocks every window because there is
one engine thread, exactly as heavy work in one Qt window blocks the app.

Implementation note: the existing modal roots are already independent layout
roots laid out at the size their window reports. Window model v2 reuses that
machinery: the main root becomes the hidden app host, and modal roots become
the registry's app windows. This avoids a second rendering model.

## Lifecycle

### Opening

- Declarative: `<Window id open ...>` in the app root. While `open` holds and
  the user has not closed it, the window exists; it closes when the element
  unmounts or `open` becomes false.
- Imperative: `Window.open(Component, options)` creates a window root and
  returns its `WindowRef`. The open window of the same id is returned; the
  call focuses it.
- `Window.get(id)`, `windows()` and `focusedWindow()` read the registry.
- A window can open before any other window and while no window is visible.
  The app host does not depend on a visible window.

### Closing

- A close press reports `closePress` on the window. With `closeOnPress` (the
  default) the window closes after the app's handlers run, as today.
- Closing a window destroys its root tree and disposes its owner. No other
  window is touched.
- Owned dialog/panel windows close with their parent (`ParentClose`).
- A window's close does not stop the engine and does not run the app's
  process-level cleanup.

### Quit mode

`nsh.json` gains an application block:

```json
"application": {
  "quitMode": "platform"
}
```

- `"platform"` (the default): macOS keeps the app running with no windows;
  Windows and Linux quit when the last window closes.
- `"lastWindowClosed"`: every platform quits when the last window closes.
- `"explicit"`: the app decides. The app host stays alive with no windows; the
  app opens a window, shows a tray menu, or calls `Application.quit()`.

The same mode is settable at run time, from TSX and from Rust
(`nsh_core::desktop::set_quit_mode`):

```ts
Application.setQuitMode("explicit");
```

Events:

- `Application.on("lastWindowClosed", () => { ... })` runs after the last
  window is gone. Rust listeners run before the quit mode acts; JS listeners
  run in a later commit, after the decision.
- `Application.on("reopen", () => { ... })` runs when the OS asks the app to
  show itself: a macOS Dock or Finder reopen, or a second launch on
  Windows/Linux. The app opens the window it wants. There is no implicit
  "show the main window" step.
- `Application.on("quitRequest")` keeps its meaning: while a listener exists,
  the Quit item and the platform quit key ask the app instead of quitting.
- `Application.on("quit")` remains a best-effort cleanup hook with the
  existing bounded budget; real saving belongs in `quitRequest`.
- `Application.quit()` ends the app; it is not a per-window close sequence,
  and its windows' `onOpenChange` may not run. The process exit releases OS
  locks. Apps that must save per-window state do it in `quitRequest`, where
  the windows still exist.

### Startup

- The app host starts before any window.
- `nsh.json`'s `"window"` block supplies optional launch defaults for the
  first window (size, position, title bar) before JS runs; it does not create
  a window. The app declares the window explicitly.
- An app can start with zero visible windows (macOS), one window, or several
  windows created from app-level code.
- `defaultVisible` is retired: it is still parsed but has no effect. The host
  is never visible, and an app that starts without a window opens none.

## Window registry and focus

The registry is the source of truth for:

- `windows()`: the open windows in opening order;
- `focusedWindow()`: the window with the keyboard focus, or null while
  another app has it;
- `Window.get(id)`;
- the Window menu;
- "open in this app" checks (a window already open is focused, not
  duplicated);
- quit coordination: `quitRequest` lets the app save every window;
  `quit` itself ends the app without a per-window close path (a window's
  `onOpenChange` may not run).

Each entry carries the id, title, kind, parent, `WindowRef`, state and
placement. Window ids are stable and app-chosen. `"main"` is the first
window's conventional id (the id is required) and has no special meaning. `restoreBounds` keeps a
placement per id and fits it on the displays present; the app saves the set of
open windows if it wants session restoration.

## Menus

### macOS

- `Menu.setApplicationMenu(items)` sets the system menu bar. It belongs to the
  app host, not to a window.
- The first submenu containing a window role becomes the Window menu; macOS
  appends the open windows by title (the registry keeps titles current).
- Window roles run through the responder chain: Close, Minimize and Zoom act on
  the key window.
- A per-window menu bar is not a macOS convention; `<MenuBar>` renders nothing
  there and apps use the application menu.

### Windows and Linux (design target; not implemented in this delivery)

- Every window can have its own menu bar. Declarative form:

  ```tsx
  <Window id="document:1">
    <MenuBar items={items} />
    <DocumentPage />
  </Window>
  ```

  Imperative form: `windowRef.setMenuBar(items)` (the final name is subject
  to `api-naming.md`).
- The menu bar is drawn in the client area, so it works with a hidden system
  title bar. It uses the platform's native popup menus.
- `Menu.setApplicationMenu(items)` remains the default menu for windows that
  do not set their own, for compatibility and for apps that want the same bar
  everywhere.
- Window roles target the window that owns the menu bar. For the application
  menu (no owning window), they target the focused window. Edit roles target
  the focused text field in that window.
- The existing `Menu.setMenuBar(mode)` ("shown" / "autoHide") remains the
  visibility mode; the per-window items API gets a distinct name.

## Keyboard

One application keymap table, as today, with a window field per binding:

- a binding made inside a window component defaults to that window;
- a binding made in the app root is application-wide;
- `keymap.bind(keystroke, handler, { scope: "window" | "app" })` makes the
  choice explicit; `"window"` uses the window the binding is made in;
- the core matches a key against the window root the platform reports
  (`Keymap::find_in`, already implemented);
- menu accelerators are application-level; their handlers resolve the focused
  window when they act on a window;
- reserved keys (Cmd+Q, Ctrl+Q, Alt+F4, …) are still rejected by `bind`, and
  Quit goes through the menu role and `quitRequest`.

The Rust `on_key`/`on_key_with` API gets the same explicit scope option; its
current default (the window the component renders in) stays.

## State and reactivity

- One JS context and one reactive graph, shared by the app root and every
  window root.
- The app root's signals and effects live until the app quits. They are the
  place for application state: settings, the project catalog, the window
  registry, menus and session state.
- A window component's signals and effects live until that window closes.
  They are the place for per-window state: document session, camera, scene,
  selection, composer, search.
- Module-level signals are application-level by definition. The documentation
  and examples say so; a per-window module singleton is an app bug, not a
  framework feature.
- `currentWindow()` inside a window returns that window's `WindowRef`.
  A Rust component inside a JS `<Window>` (one the app's TSX uses) gets that window too: with no Rust
  component above it, the core renders it under an owner per window that provides a `WindowRef` for that window's
  node, whose state and title bar area follow what the platform reports of it (`Core::js_window_owner`), so
  `current_window().title_bar()` there is the window's, not the hidden host's.
  `focusedWindow()` and `windows()` work in the app root and in any window.
- A `<Window>` unmount disposes its owner, its effects and its bindings; the
  app root is not disposed.

This matches the state model of Qt and AppKit: one process, one global
namespace, and objects owned by windows or by the application.

## Platform behavior

| Area | macOS | Windows | Linux | Headless | iOS/Android/Web |
|---|---|---|---|---|---|
| App host | NSApplication delegate | message-only dispatcher + hidden surface | GtkApplication | engine + window model | app host |
| Visible windows | NSWindows | HWNDs | GtkWindows | model windows | the app surface; `<Window>` renders its content |
| Closing a normal window | removes that window | destroys that HWND | destroys that GtkWindow | removes that window | n/a |
| Last window | app stays (default) | quits (default) | quits (default) | policy is testable | app lifecycle |
| Application menu | system menu bar | host only, not shown | host only, not shown | model | none |
| Per-window menu bar | not rendered | not implemented | not implemented | model | none |
| Window roles | key window (responder chain) | host (deviation) | host (deviation) | model | none |
| Reopen | Dock/Finder `reopen` | second launch shows? app decides | second launch shows? app decides | no | n/a |
| Session end | system quit request | WM_QUERYENDSESSION | SIGTERM/quit request | n/a | n/a |
| Placement | `restoreBounds` per id | same | same | model | n/a |

Windows and Linux do not show a menu bar for a window that has none. The
default application menu is a convenience, not a native menu attached to a
window. GPUI is not migrated: it still shows
the host as a window on Linux and has no app-window roots. This delivery
marks the native macOS/Windows/Linux behavior 待平台验证; the headless model
and the TSX/Rust API are covered.

## API

### TSX

```tsx
import { Application, mount } from "nsh";
import { Window } from "nsh/desktop";

function App() {
  const library = createLibrary(); // app root state
  const open = library.openDocuments();

  Application.setQuitMode("explicit");
  Application.on("reopen", () => library.showLauncher());

  return (
    <>
      <Window id="launcher" title="Library" open={library.launcherOpen()}>
        <LibraryPage ... />
      </Window>
      <Each of={open()} key={(d) => d.id}>
        {(d) => (
          <Window id={`document:${d().id}`} title={d().title} closeOnPress={false}>
            <DocumentPage document={d()} />
          </Window>
        )}
      </Each>
      <Window id="settings" kind="dialog" open={settingsOpen()}>
        <SettingsPage />
      </Window>
    </>
  );
}

mount(App);
```

- `<Window>` is a scene. `open` controls it; `defaultOpen` is allowed.
- `<MenuBar>` and `WindowRef.setMenuBar(items)` are design targets for
  Windows and Linux, not available in this delivery; apps that need a visible
  bar draw their own controls.
- `Application` is an imperative module, not a JSX element:
  `Application.setQuitMode(...)`, `Application.on(...)` and
  `Application.quit()`.
- `Window.open`, `Window.get`, `windows()`, `focusedWindow()`,
  `currentWindow()`, `keymap.bind` keep their names, with the changes above.

### nsh.json

```json
{
  "window": {
    "defaultSize": { "width": 1040, "height": 720 },
    "defaultPosition": "center",
    "titleBar": { "style": "hidden", "height": 32 }
  },
  "application": {
    "quitMode": "platform"
  }
}
```

`"window"` supplies launch defaults for the first window; it does not create
one. A JS app declares its windows with `<Window>`; an app that returns a
normal view tree (or no `<Window>` at all) gets the implicit first window, in
which its content renders as the old main window's. A Rust app root has no
implicit window: it renders into the hidden host, so a Rust desktop app must
declare `element::desktop::window()`.

### The implicit first window (compatibility)

Window model v2 is a major-version break for apps that declare windows, but
released apps keep running: `mount` gives a plain root the implicit first
window, `currentWindow()` in the app root is its ref, and root keymap
bindings stay app-wide as they were. Apps that declare `<Window>` scenes do
not get it (the runtime drops it unshown). The first window inherits the
`"window"` launch defaults; its `<Window>` attributes override them. An app
that needs the old "quit when the first window closes" behavior sets
`quitMode: "lastWindowClosed"`.

## Compatibility and migration

This is a major version. The migration is mechanical but the behavior changes
are real:

| Today | Window model v2 |
|---|---|
| Main window is the engine root; closing it quits | App host is the root; the first window is ordinary; quitting follows policy |
| App windows are dialog roots; close with main | App windows have their own roots; normal windows are independent |
| Closing the last app window leaves the app running | Last-window policy decides; macOS stays, Windows/Linux quit by default |
| Application menu is the main window's | macOS global menu; Windows/Linux host-only in this version (per-window bars deferred) |
| Menu roles target the main window on Windows/Linux | Target the owning/focused window (macOS); Windows/Linux still target the host in this version |
| `keymap.bind` is application-wide | Defaults to the current window; `scope: "app"` is explicit |
| `Window.open` with an open id returns it without focus | Focuses the open window |
| `currentWindow()` outside a window means main | Still the main window's ref in the app root; components inside `<Window>` get that window |
| Off the desktops `<Window>` rendered nothing and `currentWindow()` was main | `<Window>` renders its content in the app's one surface; `currentWindow()` is the app's one surface, and `windows()` lists it |
| `mount(App)` renders the main window | `mount` renders the app root; a plain root gets the implicit first window, and apps that declare `<Window>` scenes get those |
| `defaultVisible` only for the main window | Retired; no effect |
| `"main"` is reserved and privileged | `"main"` is a conventional first-window id, with no special behavior |

Documentation, types, examples, `tests/compat/` and the website need the same
pass. There is no compatibility wrapper: every app migrates to explicit
`<Window>` scenes. The keymap default and the main-close semantics are
intentional breaking changes and need release notes. Application-specific
migrations are documented by the app; this page records only the NSH contract.

## Performance and size

- One engine, one JS context, one reactive graph; N window roots add layout,
  text and mount work only for the windows that change.
- The platform applies one mount batch per changed window; a change in project
  A does not redraw project B.
- The app host is a message-only dispatcher plus a hidden surface on Windows
  and a hidden NSWindow on macOS; it adds no visible window and no taskbar
  entry.
- The optional per-window menu bar (not implemented in this delivery) is a
  native popup menu plus a small in-content bar; it costs nothing in apps
  that do not use it.
- Per-window JS VMs are not part of this design, so the binary and start-up
  cost do not grow with the window count.

## Testing

- Core unit tests: window registry, root lifecycle, parent/child close,
  last-window policy, quitRequest, menu role resolution, keymap scope,
  placement, current/focused window.
- Headless desktop tests: app host with zero, one and N windows; close any
  window; close the first window while others stay; last-window policy; app
  root state surviving window closure; per-window keymaps; per-window menu
  models; an app that declares no top-level `<Window>` fails with a clear
  error.
- macOS native tests: updated in this delivery (the host fixtures declare
  `<Window>`, and the native quit and title-bar tests expect app windows) but
  待平台验证: independent NSWindows, key-window menu roles, Window menu, Dock
  reopen, last-window behavior, Cmd+W and Cmd+Q need a macOS run.
- Windows native tests: the crate's unit tests ran on Windows in this
  delivery. The message-only dispatcher, N HWNDs, taskbar entries, Alt+F4,
  last-window policy, session end and second instance still need a real-host
  Windows run; per-window menu bars are not implemented.
- Linux native tests: 待平台验证. GtkApplication with N windows, focus and
  last-window policy need a Linux run; per-window menu bars are not
  implemented.
- Example app tests: a launcher/document app opens and closes windows,
  supports several documents, quits with several windows, and uses menus and
  shortcuts (headless/TSX coverage in this delivery).

Acceptance criteria:

1. A macOS app with two windows survives closing either one, including the
   first; Dock reopen reaches the app's `reopen` handler. (待平台验证)
2. A Windows app with two windows destroys only the closed window; closing the
   last one quits under `"platform"`; menu Close/Minimize/Zoom act on the
   focused window. (待平台验证; roles still target the host — not met)
3. A Linux app behaves as on Windows. (待平台验证; roles still target the
   host — not met)
4. A window-scoped shortcut fires only in its window; an app-scoped shortcut
   fires in every window. (Headless/TSX and Rust tests pass.)
5. A per-window menu bar opens the right menus and roles. (Not implemented.)
6. An example document app opens a document, closes it back to the launcher,
   opens two documents, quits with both, and never shows a hidden "main"
   window. (Example apps cover the model headlessly; native UI 待平台验证.)
7. An app that declares no top-level `<Window>` fails with a clear error
   instead of receiving an implicit window. (JS; Rust renders into the hidden
   host as recorded above.)

## Implementation phases

These are engineering stages inside one major-version effort; the target model
is not partially shipped as a product. Status in this delivery: phases 1, 2 and
7 are done (the outstanding docs/compat items and native verification are
listed above); phases 4–6 are done in code with their native tests 待平台验证;
phase 3 is done for the application menu and role resolution, while per-window
menu bars are deferred; phase 8 (release) is outside this delivery.

1. **Core app host and window roots** — split `Core` into an app root and a
   window registry; move dialog roots to window roots; keep owned
   dialogs/panels; headless tests.
2. **JS/Rust app root and scenes** — `mount` app root, explicit `<Window>`
   scenes (no implicit window), `currentWindow`/`windows`/`focusedWindow`,
   `Application` policy and events, window-scoped keymaps.
3. **Menus** — application menu model, per-window menu bar, role resolution,
   Window menu, `nsh.json` application block.
4. **macOS backend** — app delegate, NSWindows, menu, Dock reopen, last-window
   behavior.
5. **Windows backend** — message-only dispatcher with a hidden surface, N
   HWNDs, taskbar, menu bars, last-window behavior, session end.
6. **Linux backend** — GtkApplication, N windows, focus, menu bars,
   last-window behavior.
7. **Headless model, docs, types and compatibility tests** — update
   `docs/dev/architecture.md`, platform pages, `website/`, `tests/compat/`,
   `nsh.json` schema and `api-naming.md`.
8. **Release** — major version and migration notes.

## Risks

- The core split is the riskiest part: layout, measurement, commit, mount,
  events and focus all assume one root today.
- Three desktop backends have different native lifecycle models; each needs
  its own native test.
- Menu bars with a hidden title bar need a client-area design on Windows and
  Linux; the native popup path must keep keyboard and accessibility behavior.
- The explicit-window migration and the keymap default change need careful
  release notes; a plain root keeps the implicit first window for released
  apps.
- One engine thread means a busy window can still stall the others; that is a
  known property of the single-context design, not a regression.
- Mobile and web must keep compiling and behaving as single-window apps.

## Alternatives considered

- **Keep the main window and add patches** (window-scoped keymaps, menu-role
  routing, hidden-main tests). This is smaller, but it keeps a privileged
  window and leaves the lifecycle, menus and startup shaped around it. It does
  not satisfy "top-level windows are equal".
- **Electron-style one JS context per window.** It gives isolation but
  duplicates the runtime, native modules, storage and event routing, and
  breaks the shared reactive graph NSH is built on. Qt and AppKit do not need
  it for native windows.
- **A separate launcher process or a second app instance per project.** It
  duplicates icons, locks and coordination, and loses the shared app state.

## Open questions

- Final names for the optional per-window menu API (`setMenuBar`,
  `setMenuItems`, `<MenuBar>`), to be settled in `api-naming.md`.
- Whether `nsh.json "window"` should keep its name or become
  `"firstWindow"`, now that it supplies launch defaults rather than creating
  a window.
- Whether `restoreBounds` plus app-managed session state is enough, or NSH
  should add an explicit window-session API.
