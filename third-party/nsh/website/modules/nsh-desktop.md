---
title: nsh/desktop
description: "Desktop-only APIs: the app's windows (the main window and windows of its own, their kinds, attributes, state and events), the displays, a title bar of the app's own, the application menu, context menus, the tray and global shortcuts."
order: 12.5
---

# nsh/desktop

`nsh/desktop` holds what only desktops have: the app's windows and their title bars, the displays, the application menu and context menus, the tray and global shortcuts. It works on macOS, Windows and Linux. Rust code finds the same in `nsh_core::element::desktop`: windows of the app's own (`window()`), the window a component renders in (`current_window()`, a `WindowRef`), the displays (`displays`), `quit`, `restart`, the application menu and context menus (`set_application_menu`, `popup_menu`, made of `MenuItem`s), the tray (`set_tray`) and global shortcuts (`register_global_shortcut`), and marks draggable views with `.window_drag(true)`; TSX imports `nsh/desktop`. The module can be imported on every platform, so one bundle runs everywhere: on iOS and Android its functions do nothing, and `isAvailable` tells you whether its windows and menus are there.

```rust tabs
use nsh_core::{
    desktop::{MenuRole, TitleBarOptions, TitleBarStyle, WindowAttributes, WindowKind, WindowMode},
    element::desktop::{
        MenuItem, current_window, displays, popup_menu, quit, set_application_menu, title_bar,
        window,
    },
    prelude::*,
};
```

```tsx tabs
import {
  Application,
  currentWindow,
  displays,
  focusedWindow,
  isAvailable,
  Menu,
  titleBar,
  Window,
  windows,
  windowState,
} from "nsh/desktop";
```

## isAvailable

```ts
const isAvailable: boolean;
```

`true` where this module's window and menu APIs work: macOS, Windows and Linux; `false` elsewhere. Rust: `os().is_desktop()`.

[`platform.desktop`](./nsh.md#platform) is the broader check for desktop behavior (`desktop={{…}}` props, `platform.select({ desktop })`): it also holds in browsers in the desktop idiom, which run in the browser's own window. Gate desktop layout, density and input on `platform.desktop`, and windows and menus on `isAvailable`.

## Windows

Every window of an app renders from the app's one engine: the main window and the windows the app opens share its signals, context, theme and modules, so there is no messaging between windows. Each window is a `WindowRef`: the same type for the main window and every window of the app's own.

- A window of the app's own is declared in the tree with [`<Window>`](#window), or opened imperatively with [`Window.open`](#windowopen).
- [`currentWindow()`](#currentwindow) is the window the calling component renders in; `windows()`, `focusedWindow()` and `Window.get(id)` find the others.
- What only the app changes (the title, the title bar, the level, the look, the close policies) are the window's [attributes](#attributes): `<Window>`'s props and `set()`. What the user also changes (the bounds, the mode, being open) starts from a `default…` option, changes through requests (`setMode`, `setBounds`, `close`, …) and comes back in [`state()`](#the-windows-state-and-the-displays) and the [events](#events).
- Requests return nothing: the platform may adjust or decline one (a window manager places windows itself, a display was unplugged), and `state()` reports what happened.

The main window's launch settings are nsh.json's [`window`](#the-main-window), which the app applies before its first frame.

### Window

```ts
const Window: Component<WindowProps> & {
  open(component: () => JSX.Element, options: WindowOptions): WindowRef;
  get(id: string): WindowRef | null;
};

interface WindowProps extends WindowOptions {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (event: { open: boolean; reason: WindowCloseCause }) => void;
  onClosePress?: (event: { reason: CloseReason }) => void;
  onFocusChange?: (event: { focused: boolean }) => void;
  onModeChange?: (event: { mode: WindowMode; minimized: boolean }) => void;
  onBoundsChange?: (event: { bounds: Bounds }) => void;
  onDisplayChange?: (event: { display: Display }) => void;
  children?: JSX.Element;
}
```

`<Window>` is a window of the app's own, controlled as a [`Dialog`](./nsh-base.md) is: it is open while `open` is not `false` (`defaultOpen` without `open`, `true` by default) and closes when it unmounts. Its content is part of the tree around it: it reads the same signals and context, and `currentWindow()` inside it is this window. When the window closes other than by its `open` prop, `onOpenChange({ open: false, reason })` tells the app, which sets `open` from it. The reasons are `"closePress"` (the user closed it), `"escape"` (`closeOnEscape`), `"blur"` (`closeOnBlur`), `"parentClose"` (its parent closed) and `"close"` (the app called its `WindowRef.close()`).

Its props are its [options](#options) and [attributes](#attributes); the attributes are reactive, so `title={`${doc().name} – Editor`}` follows the signal.

```rust tabs
#[component]
fn Inspector(open: Signal<bool>) -> impl IntoElement {
    window()
        .id("inspector")
        .kind(WindowKind::Panel)
        .title("Inspector")
        .default_size(size(px(320.0), px(560.0)))
        .open(open)
        .on_open_change(move |e| open.set(e.open))
        .content(inspector_panel)
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Window } from "nsh/desktop";

const inspector = signal(false);

function Toolbar() {
  return (
    <View>
      <Button onPress={() => inspector.set(true)}>
        <Text>Inspector</Text>
      </Button>
      <Window
        id="inspector"
        kind="panel"
        title="Inspector"
        defaultSize={{ width: 320, height: 560 }}
        open={inspector()}
        onOpenChange={({ open }) => inspector.set(open)}
      >
        <InspectorPanel />
      </Window>
    </View>
  );
}
```

In Rust, `window()` is a builder: `.id()`, `.kind()`, `.parent()`, `.modal()`, `.default_size()`, `.default_position()`, `.display()`, `.default_mode()`, `.restore_bounds()`, `.title()` and `.attributes(..)` (a `WindowAttributes`, a signal of one or a closure), `.open(..)`, `.on_open_change(..)`, `.on_close_press(..)` and `.content(..)` (made each time it opens); `current_window()` in its content is its `WindowRef`. Off the desktops `<Window>` and `window()` show nothing.

### Window.open

`Window.open(Component, options)` is the imperative form of `<Window>`: it renders `Component` in a window of its own and returns its `WindowRef`. Opening an `id` that is open returns that window. The window closes when the user closes it (with `closeOnPress`) or the app calls `close()`.

```tsx
import { signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

const unread = signal(0);

function Chat() {
  return <View><Text>{`${unread()} unread`}</Text></View>;
}

const chat = Window.open(Chat, { id: "chat", title: "Chat", defaultSize: { width: 360, height: 480 } });
chat.focus();
```

In Rust, `open_window(window()...)` is the same (GPUI: `cx.open_window`): it opens the `window()` builder's window from anywhere, an event handler, a menu item or a task, and returns its `WindowRef` at once. With the id of a window that is already open (opened by `open_window` or declared with `window()`), it focuses that window and returns its ref. Where `Window.open` throws, off the desktops or when the capabilities do not grant the window, it returns `None` and logs a warning. Its `.open(..)` is not used; the window stays open until the user or `close()` closes it, and `.on_open_change(..)` hears it. For a window per document, give each its own id:

```rust
let Some(doc) = open_window(
    window()
        .id(format!("doc:{id}"))
        .title(name)
        .content(move || editor(id)),
) else {
    return;
};
```

`Window.get(id)` is the open window with `id`, or `null` (reactive); `"main"` is the main window. Off the desktops `Window.open` throws with `code` `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; a window the app's [capabilities](#capabilities) do not grant throws with `ERR_ACCESS_DENIED`.

### Kinds

A window's `kind` says what it is for. Each kind is a set of defaults for the attributes, which any attribute the app sets overrides: `<Window kind="popup" closeOnBlur={false}>` is a popup that stays open when it loses the focus.

| Kind | For | Defaults |
|---|---|---|
| `"normal"` (the default) | Document and main windows | In the taskbar, activates, resizable. |
| `"dialog"` | Settings, about, confirmations | Owned by the window that opened it and centered on it; no minimize or maximize; Escape closes it; not in the taskbar. `modal: true` keeps its parent from taking input while it is open. |
| `"panel"` | Inspectors, palettes, tool windows | Floats over its parent; no minimize or maximize; not in the taskbar; does not activate the app. |
| `"popup"` | Launchers, tray popovers, command palettes | No frame; not resizable; Escape and losing the focus close it; floats on every workspace; not in the taskbar. |
| `"overlay"` | HUDs, captions, annotations, desktop pets | Transparent, the pointer passes through it (`pointerEvents: "none"`), never takes the focus, above the Dock and the taskbar, on every workspace, no shadow. Needs the `windows` capability's `overlay`. |

Each platform shows a kind as its own windows of that role: an `NSPanel` on macOS for panels and popups, a tool window owned by its parent on Windows, a transient window on Linux.

### Options

`WindowOptions` are what a window starts with: `<Window>`'s props and `Window.open`'s second argument. They hold every [attribute](#attributes) as well.

| Option | Rust (`window()`) | Description |
|---|---|---|
| `id` | `.id(id)` | The app's id for it (required): one window per id, and the key of `restoreBounds`. |
| `kind` | `.kind(kind)` | What it is for (above). |
| `parent` | `.parent(id)` | The window that owns it (a `WindowRef` or an id): it stays above it and closes with it. Dialogs and panels default to the window that opened them. |
| `modal` | `.modal(true)` | Its parent takes no input while it is open (dialogs). |
| `defaultSize` | `.default_size(size)` | Its content size when it opens, in points. |
| `defaultPosition` | `.default_position(position)` | Where it opens: a point on the screen (`{ x, y }`), `"center"` (its display's center) or `"parentCenter"`. Dialogs open at their parent's center; other windows where the system places them. |
| `display` | `.display(id)` | The display it opens on. |
| `defaultMode` | `.default_mode(mode)` | The mode it opens in: `"normal"`, `"maximized"` or `"fullScreen"`. |
| `restoreBounds` | `.restore_bounds(true)` | Opens where the user left it: its placement is kept under its `id` in the app's data and fitted on the displays there are when it opens again. |

### Attributes

`WindowAttributes` are what the app changes while a window is open: `<Window>`'s reactive props and `WindowRef.set(partial)`, which changes the attributes it names and keeps the others. Every attribute takes its kind's default until the app sets it. The changes of a commit reach the platform together.

| Group | Attribute | Description |
|---|---|---|
| Chrome | `title` | Shown in the title bar, the taskbar, the window switcher and to assistive technologies. |
| | `titleBar` | `{ style: "default" \| "hidden"; height?; controlsOffset? }`: the system's title bar, or a title bar of the app's own ([below](#a-title-bar-of-your-own)). `controlsOffset` (`{ x, y }`) places macOS's traffic lights in a hidden title bar. |
| | `frame` | `"default"`, or `"none"`: no title bar or border, the app draws everything. |
| Size | `minSize`, `maxSize` | The least and largest content size the user may give it, `{ width, height }` in points; `null` clears it. |
| | `sizeToContent` | `true`, `"width"` or `"height"`: the window follows its content's laid-out size, natively, without JS on the path. |
| Behavior | `resizable`, `movable`, `minimizable`, `maximizable`, `closable` | What the user may do with it. The app's requests are not limited by them. |
| | `focusable` | It takes the keyboard focus. |
| | `activate` | It activates the app and takes the focus when it opens or shows. |
| Closing | `closeOnPress` | A press of its close button or the close key closes it at once (`true`, the default); `false`: the app hears `closePress` and closes it when it decides ([Closing](#closing)). |
| | `closeOnEscape`, `closeOnBlur` | Escape, or losing the focus, closes it. |
| Layering | `level` | `"normal"`, `"floating"` (above normal windows), `"aboveDock"` (above the Dock and the taskbar) or `"desktopIcon"` (macOS's desktop icon level, on every space; on Windows, the bottom of the z-order). |
| | `taskbar` | It has a taskbar button (Windows). |
| | `workspaces` | `"current"` or `"all"`: the workspaces (macOS's spaces) it shows on. |
| | `pointerEvents` | `"auto"`, or `"none"`: clicks pass through it to what is below. Needs the `windows` capability's `overlay`. |
| Look | `transparent` | Its background is transparent: the app's views are all it shows. |
| | `backdrop` | The system's material behind its content: `"none"`, `"window"`, `"sidebar"`, `"popover"` or `"hud"`. Each platform maps them to its own (macOS's visual effect materials, Windows 11's Mica and Acrylic). |
| | `shadow` | The system's shadow around it. |
| Taskbar | `progress` | `{ value?, state? }` or `null`: progress on its taskbar button or the Dock's icon; `value` from 0 to 1, `state` `"normal"`, `"indeterminate"`, `"paused"` or `"error"`. |

An attribute a platform's windows do not have is kept and has no effect there: the window manager on Linux places and stacks windows itself, so positions, levels and `taskbar` are its.

### currentWindow

```ts
function currentWindow(): WindowRef;
function windows(): WindowRef[];
function focusedWindow(): WindowRef | null;
```

`currentWindow()` is the window the calling component renders in: the nearest `<Window>` (or `Window.open`'s window) around it, else the main window. It follows the tree, never the focus, so a component shows the right window's state and acts on its own window wherever it is used. Call it while rendering and keep the `WindowRef`: called outside a component (in an event handler, a timer, after an `await`) it throws a `TypeError`.

```tsx
function SaveButton() {
  const win = currentWindow(); // while rendering
  return <Button onPress={() => save().then(() => win.close())}>Save</Button>;
}
```

`windows()` is the open windows, the main window first, then the app's own in the order they opened; `focusedWindow()` is the one with the keyboard focus, `null` while another app has it. Both are reactive.

Rust: `current_window() -> WindowRef`, the same lookup through the component's context, and `main_window()`.

### WindowRef

```ts
interface WindowRef {
  readonly id: string;
  readonly main: boolean;
  readonly parent: WindowRef | null;
  state(): WindowState | null;
  titleBar(): TitleBarArea;
  set(attributes: Partial<WindowAttributes>): void;
  show(): void;
  hide(): void;
  focus(): void;
  close(): void;
  minimize(): void;
  restore(): void;
  setMode(mode: WindowMode): void;
  setBounds(bounds: { origin?: Partial<Point>; size?: Partial<Size>; animated?: boolean }): void;
  setPlacement(placement: WindowPlacement): void;
  center(options?: { display?: DisplayId }): void;
  requestAttention(options?: { critical?: boolean }): void;
  on(event: WindowEventName, listener: (event) => void): () => void;
}

type WindowMode = "normal" | "maximized" | "fullScreen";
```

The Rust column names the methods of `WindowRef`.

| Member | Rust | Description |
|---|---|---|
| `id` | `id()` | The app's id for it; `"main"` for the main window. |
| `main` | `is_main()` | It is the main window. |
| `parent` | | The window that owns it, or `null`. |
| `state()` | `state()` | What the platform reports of it (reactive; [below](#the-windows-state-and-the-displays)). `null` off desktops, before it shows and once it closed. |
| `titleBar()` | `title_bar()` | Its hidden title bar's area ([below](#titlebar)). |
| `set(attributes)` | `set(WindowAttributes)` | Changes the [attributes](#attributes) it names; the others keep their values. An attribute the app's capabilities do not grant is left as it is, with a warning. |
| `show()`, `hide()` | `show()`, `hide()` | Shows it (restoring it when minimized), or hides it. |
| `focus()` | `focus()` | Shows it, brings it to the front of its level and gives it the keyboard focus; the app activates. The window keeps its level. |
| `close()` | `close()` | Closes it, whatever `closeOnPress` says. A window of the app's own unmounts its content (`<Window>`: `onOpenChange` with `reason: "close"`); the main window closes as when the user closes it, and the app ends with its last window. |
| `minimize()`, `restore()` | `minimize()`, `restore()` | Minimizes it, or brings it back in the mode it had: a maximized window minimized comes back maximized. |
| `setMode(mode)` | `set_mode(mode)` | Puts it in `"normal"`, `"maximized"` or `"fullScreen"`; asking for the mode it is in changes nothing. |
| `setBounds({ origin?, size?, animated? })` | `set_bounds(WindowFrame { .. })` | Moves and sizes it, in points; omitted fields keep their values. `origin` (`x`, `y`) is its top left corner from the primary display's top left, `y` growing down; a `height` without a `y` keeps the top edge where it is. On macOS and Windows `size` includes the window's decorations; on Linux it sets GTK's default window size. `animated: true` enables macOS's resize animation. Widths and heights take positive finite numbers, `x` and `y` finite ones; other values keep the field's. |
| `setPlacement(placement)` | `set_placement(placement)` | Restores a placement saved from `state().placement`: restored to its bounds, then maximized or in full screen when its mode says so. The bounds are first fitted on the displays there are now: they stay when the window's title bar can still be grabbed on a display, otherwise they are centered on the primary display, no larger than it. |
| `center({ display? })` | `center(display)` | Centers it on `display`, its own without one. |
| `requestAttention({ critical? })` | `request_attention(critical)` | Asks for the user's attention: the Dock's icon bounces, the taskbar button flashes; `critical` until the user activates the app. |
| `on(event, listener)` | `on_<event>(f)` | Listens to an [event](#events); returns a function that stops. |

Double-clicking a `windowDrag` view does the system's title bar action natively, so a title bar of the app's own needs no maximize toggle of its own.

### Events

| Event | Payload | When |
|---|---|---|
| `closePress` | `{ reason }` | The user asked to close it, whether or not `closeOnPress` lets it close. `reason`: `"closeButton"`, `"shortcut"`, `"menu"`, `"taskbar"` or `"system"`. |
| `close` | | It closed. |
| `focusChange` | `{ focused }` | It gained or lost the keyboard focus. |
| `modeChange` | `{ mode, minimized }` | Its mode changed, or it was minimized or restored. |
| `boundsChange` | `{ bounds }` | It moved or was resized, once the move or resize settles. |
| `displayChange` | `{ display }` | It moved to another display. |

`win.on("focusChange", l)` returns a function that stops the listener; a listener registered while a component renders goes with the component. `<Window>` takes the same as props (`onClosePress`, `onFocusChange`, …). Rust: `WindowRef::on_focus_change`, `on_mode_change`, `on_bounds_change`, `on_display_change`, and `window()`'s `.on_close_press(..)` and `.on_open_change(..)`.

### Closing

Closing is answered natively, at once: the platform reads the window's `closeOnPress` when the user presses its close button (or Cmd+W, Alt+F4, the taskbar's Close), so a window closes even while the app's JS is busy.

- `closeOnPress: true` (the default): the window closes; the app hears `closePress`, then `close` (`<Window>`: `onOpenChange` with `reason: "closePress"`).
- `closeOnPress: false`: the window stays and the app hears `closePress`. The app decides, then closes it with `close()` (or `open={false}`): an editor asks to save its changes first.
- `close()` and [`Application.quit()`](#application) close whatever `closeOnPress` says.

```tsx
function Editor() {
  const win = currentWindow();
  win.set({ closeOnPress: false });
  win.on("closePress", () => {
    if (!edited()) win.close();
    else askToSave.set(true); // the app's own dialog, which calls win.close()
  });
  return <EditorView />;
}
```

`closeOnEscape` and `closeOnBlur` close a window the same way, with `reason` `"escape"` or `"blur"`; a window whose parent closes closes with it (`"parentClose"`).

### The main window

The main window is there when the app starts. nsh.json's `window` holds its launch settings, which the app's window has from its first frame, before any JS runs:

```json
{
  "window": {
    "title": "Mail",
    "defaultSize": { "width": 1100, "height": 720 },
    "minSize": { "width": 640, "height": 420 },
    "titleBar": { "style": "hidden", "height": 40 },
    "backdrop": "sidebar"
  }
}
```

It takes the [options](#options) `defaultSize`, `defaultPosition`, `display` and `defaultMode`, and every [attribute](#attributes). While the app runs, `currentWindow()` outside any `<Window>` (or `Window.get("main")`) is the main window, and its `set()` changes the same attributes.

`"defaultVisible": false` starts the app with its main window hidden: the window is made and the app runs in it, unseen and without taking the keyboard, until the app shows it with `show()` or `focus()`, as a [tray](#tray) app does when its icon is clicked. Until then `state()` reports it hidden; the first time it shows, it opens in its `defaultMode`. A link of one of the app's [URL schemes](./nsh.md#urlscheme) opened while the app runs shows it too, and so does opening the app again on macOS (its Dock icon, the Finder). `nsh run` and `nsh test --target` start it hidden as well. Their development host opens the window as it does for every app: with `--target windows` (`nsh run`'s default on Windows) at the app's `defaultSize` and in its `defaultMode`, with `--target macos`, `linux` or `gpui` at the host's size in the normal mode; GPUI shows a window as it opens on Linux, so with `--target gpui` there it shows. Under `nsh run` an error shows it, so the error is seen.

```json
{
  "window": {
    "title": "Focus",
    "closeOnPress": false,
    "defaultVisible": false
  }
}
```

```tsx
import { currentWindow, Tray } from "nsh/desktop";
import icon from "./tray.svg";

function App() {
  const win = currentWindow();
  // The close button hides the window: the app keeps running in the tray.
  win.on("closePress", () => win.hide());
  Tray.set({ icon, onClick: () => win.focus(), menu: [{ role: "quit" }] });
  return <Timer />;
}
```

[`examples/tray`](https://github.com/longbridge/nsh/tree/main/examples/tray) is a tray app made this way.

### Capabilities

An app without `"capabilities"` in nsh.json may open windows of every kind except overlays. An app that declares its capabilities opens windows of its own when `capabilities.windows` grants them ([Sandbox and capabilities](../docs/sandbox-and-capabilities.md#windows)). Overlays and click-through windows (`pointerEvents: "none"`) are granted only when declared. `Window.open` and `<Window>` throw `ERR_ACCESS_DENIED` with `permission` `"windows"` and `resource` the window's id for a window not granted; an attribute not granted in `set()` is left as it is, with a warning.

## Application

```ts
const Application: {
  quit(): void;
  restart(): void;
  on(event: "secondInstance", listener: (launch: { args: string[]; cwd: string }) => void): () => void;
  on(event: "openFiles", listener: (files: { paths: string[] }) => void): () => void;
  on(event: "quit", listener: () => void): () => void;
};
```

| Member | Rust | Description |
|---|---|---|
| `quit()` | `quit()` | Quits the app, as the application menu's Quit item (`{ role: "quit" }`) and the platform's quit key do. |
| `restart()` | `restart()` | Quits the app as `quit()` does, then starts it again with the same arguments. |
| `on("secondInstance", listener)` | `next_second_instance()` | The app was launched again while it runs ([Single instance](#single-instance)). |
| `on("openFiles", listener)` | `next_open_files()` | The system opened the app with files of the types it declares ([Opening files](#opening-files)). |
| `on("quit", listener)` | `on_app_quit(f)` | The app is quitting: its cleanup runs ([Quitting](#quitting)). |

`Application.quit()` is for a Quit of the app's own (a menu item with its own label, a button) and for restarting after an
update. The app stops as when its last window closes, then its run ends, also when closing the window alone would
leave it running: a window kept hidden for the Dock, a tray icon. Closing goes through the same steps as the Quit
item: the standalone app on macOS returns from `run_app` as with Cmd+Q; in a GPUI app that owns the window, the request
reaches its `AppView::on_close_request` handler as `CloseRequest::Quit`, which quits when the app is ready; elsewhere
the quit goes ahead as the Quit item's does. A view
embedded in another app leaves the app's lifecycle to that app. In the terminal the app ends, as with a quit role.

`Application.restart()` is for a setting that takes effect at the next start, such as the app's language: the app asks
the user first, then calls it. The app quits as with `quit()`, and once its process has exited the same program starts
again with the arguments it was started with; the two processes never run side by side. On macOS an app inside an
`.app` bundle comes back through Launch Services, as when the user opens it. It works in standalone apps on macOS,
Windows and Linux, including those `nsh package` builds; a view embedded in another app (a GPUI app's `AppView`, say)
leaves restarting to that app. Under `nsh run` the app quits, and `nsh run` ends with it: check restarting in an app
`nsh package` builds.

```tsx
import { Application } from "nsh/desktop";

async function changeLanguage(language: string) {
  await saveLanguage(language);
  if (await confirmRestart()) Application.restart();
}
```

### Quitting

The app owns its Quit, as a GPUI app owns its `Quit` action. The application menu's `{ role: "quit" }` item and its key
quit at once. An app that asks first (unsaved changes, a running upload) puts a Quit item of its own in the menu with
the quit key, asks, then calls `quit()`:

```rust tabs
use nsh_core::{
    desktop::MenuItem,
    element::desktop::{on_app_quit, quit, set_application_menu},
    prelude::*,
};

#[component]
fn Editor() -> impl IntoElement {
    let dirty = signal(false);
    set_application_menu(vec![MenuItem::submenu("File", vec![
        MenuItem::new("Quit").shortcut("mod+q").on_select(move || {
            if dirty.get_untracked() {
                ask_to_save(); // its Quit button calls `quit()`
            } else {
                quit();
            }
        }),
    ])]);
    // Runs however the app quits; it cannot keep it running.
    on_app_quit(move || async move { save_session().await });
    editor()
}
```

```tsx tabs
import { Application, Menu } from "nsh/desktop";

function Editor() {
  Menu.setApplicationMenu([
    {
      label: "File",
      submenu: [{ label: "Quit", shortcut: "mod+q", onSelect: () => (dirty() ? askToSave() : Application.quit()) }],
    },
  ]);
  // Runs however the app quits; it cannot keep it running.
  Application.on("quit", async () => {
    await saveSession();
  });
  return <EditorView />;
}
```

`Application.on("quit", listener)` (Rust: `on_app_quit`) is the app's cleanup, as GPUI's `on_app_quit`: it runs
however the app stops (its Quit item, `quit()`, its last window closing, the Dock's Quit, the system ending it when the
user logs out, a host app removing its view), and cannot keep it running. A promise the listener returns is awaited,
200 ms at most for all of them, while the platform waits for the app; past that the app stops. A listener added while a
component renders goes with the component; the function `on` returns stops it.

### Opening files

An app that opens documents (a media player, an editor) lists their types under `fileTypes` in nsh.json. `nsh package`
declares them to the system, so the app shows in Open With and opens the files the user double-clicks or drops on its
icon. The files come to `Application.on("openFiles")` as absolute paths, those that launched the app included. Links of
the app's [schemes](nsh.md#urlscheme) stay apart, on `UrlScheme.on("open")`. `Application` is imported from
`nsh/desktop`, and `openFiles` also comes on iOS.

```json
{
  "fileTypes": [
    { "name": "Video", "extensions": ["mp4", "mov"], "mimeTypes": ["video/mp4", "video/quicktime"], "contentTypes": ["public.movie"] }
  ]
}
```

```tsx
import { Application } from "nsh/desktop";

Application.on("openFiles", ({ paths }) => {
  for (const path of paths) play(path);
});
```

| Key | Description |
| --- | --- |
| `name` | What the system calls the kind of file (`"Video"`). Required. |
| `extensions` | The extensions, without the dot (`["mp4", "mov"]`). |
| `mimeTypes` | The MIME types (`["video/mp4"]`): Linux lists the app for them. |
| `contentTypes` | Uniform Type Identifiers (`["public.movie"]`): iOS lists the app for them. |
| `role` | `"viewer"` (the default) or `"editor"`. |

Each type names `extensions` or `contentTypes`. Rust code awaits `next_open_files()` of `nsh_core::prelude`, a
`Vec<PathBuf>`. Files that come while nothing listens go to the next listener at once (up to 64, the oldest dropped).
NSH takes opened files only for an app that declares file types.

| Platform | How the app opens files |
| --- | --- |
| macOS | `CFBundleDocumentTypes` in `Info.plist`; Launch Services opens the app, or hands the files to the one that runs |
| iOS, Mac Catalyst | `CFBundleDocumentTypes` in `Info.plist` (by `contentTypes`); the system hands the app a copy of the file |
| Windows | The app, under `HKEY_CURRENT_USER\\Software\\Classes`, each time it starts: a ProgID per type, listed in each extension's `OpenWithProgids`. A second launch with files hands them to the running app |
| Linux | `MimeType` of the desktop entry, with `Exec … %U`; the app runs once and a second launch hands its files to the running app |
| Android, web | Not declared; `fileTypes` is left out of their packages |

With [`singleInstance`](#single-instance) a second launch also reports `secondInstance`, with its arguments as given.

### Single instance

A desktop app usually runs once: opening it again brings the running app forward. An app opts in with
`"singleInstance": true` in nsh.json. A second launch then hands its command line to the running app and exits before it
opens a window or starts its engine; the running app brings its main window forward (shown when it was hidden, as a
tray app's) and reports the launch as `secondInstance`, with the arguments (the program's path not included) and the
directory it was started in:

```json
{ "singleInstance": true }
```

```tsx
import { Application } from "nsh/desktop";

Application.on("secondInstance", ({ args, cwd }) => {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (file) openDocument(resolve(cwd, file));
});
```

Rust code awaits `next_second_instance()` of `nsh_core::prelude`, a `SecondInstance` with `args` and `cwd`. A launch that
comes while nothing listens waits for the next listener (up to 16, the oldest dropped). Anyone can start the app with
any arguments, so check them as any other input. Links of the app's [schemes](nsh.md#urlscheme) among the arguments
also come through `UrlScheme.on("open")`.

| Platform | How the app runs once |
| --- | --- |
| Windows | A mutex named after the app's id; the second launch sends its arguments and working directory to the running app's window (`WM_COPYDATA`) |
| Linux | GApplication's uniqueness on the session bus, by the app's id; the second launch's command line goes to the running app |
| macOS | Launch Services runs one instance of an app bundle and activates it when it is opened again, so `secondInstance` is not reported; files come through `openFiles` and links through `UrlScheme` |
| iOS, Android, web | The system runs the app once; `secondInstance` is not reported |

The release runners of `nsh package` read the setting; `nsh run` starts its development host as before.

## A title bar of your own

With the title bar hidden (`titleBar: { style: "hidden" }`), the app draws its own bar and says which parts of it move the window, with `.window_drag(true)` in Rust and `desktop={{ windowDrag: true }}` in TSX. For the main window, put `titleBar` in nsh.json's [`window`](#the-main-window), so the first frame already has it; a `<Window>` takes it as a prop.

```rust tabs
use nsh_core::{
    desktop::{TitleBarOptions, TitleBarStyle, WindowAttributes},
    element::desktop::{current_window, title_bar},
    prelude::*,
};

#[component]
fn TitleBar() -> impl IntoElement {
    let win = current_window();
    let mut bar = TitleBarOptions::default();
    bar.style = TitleBarStyle::Hidden;
    bar.height = Some(px(40.0)); // a bar 40 points tall
    let mut attributes = WindowAttributes::default();
    attributes.title_bar = Some(bar);
    win.set(attributes);
    view()
        .window_drag(true)
        .h(move || match title_bar().top {
            top if top > px(0.0) => top,
            _ => px(40.0),
        })
        .pl(move || title_bar().left + px(8.0)) // macOS's traffic lights
        .pr(move || title_bar().right + px(8.0)) // the caption buttons on Windows, GTK's buttons
        .flex_row()
        .items_center()
        .child(text("My App"))
        .child(view().flex_1())
        .child(input().placeholder("Search").w(px(180.0)))
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { currentWindow } from "nsh/desktop";

function TitleBar() {
  const win = currentWindow();
  win.set({ titleBar: { style: "hidden", height: 40 } }); // a bar 40 points tall
  return (
    <View
      desktop={{ windowDrag: true }}
      style={{
        height: win.titleBar().height || 40,
        paddingLeft: win.titleBar().left + 8, // macOS's traffic lights
        paddingRight: win.titleBar().right + 8, // the caption buttons on Windows, GTK's buttons
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <Text>My App</Text>
      <View style={{ flex: 1 }} />
      <Input placeholder="Search" style={{ width: 180 }} />
    </View>
  );
}
```

Pressing a view with `windowDrag` drags the window as the system's title bar would: a double click maximizes it (or does what the user set: on macOS, "Double-click a window's title bar to"), and on Windows and Linux a right click opens the window menu. In GPUI apps on Linux, a right click goes to the app instead when the draggable view under it, or a view inside that one, listens to `onContextMenu`; listeners on views around it, the root included, do not take the window menu away.

- The nearest view that sets `windowDrag` decides: `.window_drag(false)` (`desktop={{ windowDrag: false }}`) keeps a part of a draggable view clickable.
- Text fields and views with press or touch handlers (`onPress`, `onTouch*`, responders) inside a draggable view stay clickable without it: the search field and any buttons in the example above work as usual.
- `windowDrag` also works with the system's title bar: a sidebar or toolbar can move the window too.

A window without a frame (`frame: "none"`) or with its title bar hidden can draw its window buttons and resize edges itself:

| Prop | Rust | Description |
|---|---|---|
| `desktop={{ windowControl }}` | `.window_control(WindowControl::Close)` | `"minimize"`, `"maximize"` or `"close"`: the view is that system window button. The platform carries out its press (a close press goes through `closeOnPress`), assistive technologies see the button, and on Windows hovering a maximize view shows Windows 11's snap layouts. Its look is the app's (`hover:`, `active:`). |
| `desktop={{ windowResize }}` | `.window_resize(ResizeEdge::BottomRight)` | `"top"`, `"bottom"`, `"left"`, `"right"`, `"topLeft"`, `"topRight"`, `"bottomLeft"` or `"bottomRight"`: pressing the view resizes the window by that edge or corner. |

```tsx
<View style={{ flexDirection: "row", gap: 8 }}>
  <View desktop={{ windowControl: "minimize" }} class="size-3 rounded-full bg-amber-400" />
  <View desktop={{ windowControl: "maximize" }} class="size-3 rounded-full bg-green-500" />
  <View desktop={{ windowControl: "close" }} class="size-3 rounded-full bg-red-500" />
</View>
```

### titleBar

```ts
function titleBar(): TitleBarArea; // currentWindow().titleBar()

interface TitleBarArea {
  height: number;
  left: number;
  right: number;
}
```

The hidden title bar's area of the current window, in points (reactive): its `height`, and the widths the system's window controls take at its `left` and `right` ends. Lay your bar out with it so that nothing goes under the controls. All three are 0 while the system shows its title bar (and in full screen, and off desktops). Rust: `title_bar() -> Edges<Points>`, whose `top` is the height and `left` and `right` the controls' widths; reading it subscribes to changes.

| | `height` | `left` | `right` |
|---|---|---|---|
| macOS | `height`, else the title bar's (28 or 32, by macOS version) | The traffic lights' width | 0 |
| Windows | `height`, else 32 | 0 | The three caption buttons (138) |
| Linux | `height`, else the header bar's | The window buttons at the start (the desktop's button layout) | The window buttons at the end |

On macOS the traffic lights are centered in `height` and the window keeps the corners of a window with a plain title bar. On Windows the caption buttons are drawn by NSH in Windows 11's style and follow the app's appearance; hovering the maximize button shows Windows 11's snap layouts. The window keeps its resize borders, shadow and rounded corners on every platform. An embedding app's existing toolbar keeps its own height, which `titleBar()` reports.

## The window's state and the displays

```ts
function windowState(): WindowState | null; // currentWindow().state()
const displays: Accessor<Display[]>;

interface WindowState {
  mode: WindowMode;            // "normal", "maximized" or "fullScreen"
  minimized: boolean;
  visible: boolean;            // on the screen: not hidden, not minimized
  focused: boolean;            // it has the keyboard focus
  bounds: Bounds;              // its outer frame now, decorations included
  contentBounds: Bounds;       // its content area now
  placement: WindowPlacement;  // its mode and the bounds it is restored to
  display: Display | null;     // the display with most of it
  scaleFactor: number;         // device pixels per point
}
interface WindowPlacement {
  mode: WindowMode;
  bounds: Bounds;
}
interface Display {
  id: string;                  // the same in the app's next launch
  name: string;
  bounds: Bounds;
  visibleBounds: Bounds;       // without the menu bar, the Dock or the taskbar
  primary: boolean;
  scaleFactor: number;
  refreshRate: number | null;  // in hertz
}
```

`win.state()` is a window as the platform reports it, `windowState()` the current window's, and `displays()` the displays, the primary one first; all are reactive. Every rectangle is in points, in screen coordinates: from the primary display's top left corner, with `y` growing down, as `setBounds` takes them. A change of mode, of display, of focus, or of being minimized or visible is reported at once; a move or a resize once the window stops for a moment, so what reads them runs once per move rather than at every step. Rust: `WindowRef::state() -> Option<WindowState>` and `displays() -> Vec<Display>` (`nsh_core::desktop`'s types); reading them subscribes to changes.

While the window is on the screen, [`lifecycle()`](./nsh.md#device) reporting `"background"` means other windows cover it.

`placement` is what to save to open the window as the user left it: a maximized or full screen window carries the bounds it returns to. A window of the app's own does this with `restoreBounds: true`. For the main window, save `placement` and give it back to `setPlacement`; the window and the displays are there when the app starts, so the root can restore it as it first renders. The same entry serves a Rust root and a TSX one, as `WindowPlacement`'s serde form is the object TSX saves.

```rust tabs
#[component]
fn App() -> impl IntoElement {
    let main = current_window();
    if let Some(saved) = Storage::get_item("window")
        .and_then(|json| serde_json::from_str::<WindowPlacement>(&json).ok())
    {
        main.set_placement(saved); // fitted on today's displays
    }
    effect(move || {
        if let Some(state) = main.state() {
            let json = serde_json::to_string(&state.placement).unwrap();
            let _ = Storage::set_item("window", json);
        }
    });
    view() // ...
}
```

```tsx tabs
import { effect, Storage } from "nsh";
import { Window } from "nsh/desktop";

const main = Window.get("main");
const saved = await Storage.getItem("window");
if (main && saved) main.setPlacement(JSON.parse(saved)); // fitted on today's displays

effect(() => {
  const state = main?.state();
  if (state) Storage.setItem("window", JSON.stringify(state.placement));
});
```

The desktops report the windows' state and the displays. On iOS, Android and the web, `windowState()` is `null` and `displays()` is empty.

## Menu

```ts
const Menu: {
  setApplicationMenu(items: MenuItem[] | null): void;
  setMenuBar(mode: "shown" | "autoHide"): void;
  popup(items: MenuItem[], at?: Point): Promise<void>;
};
```

| Member | Description |
|---|---|
| `setApplicationMenu(items)` | Sets the application menu: one submenu per top-level item (`File`, `Edit`, ...). On macOS it is the menu bar, whose first menu is the app menu (AppKit titles it with the app's name). On Windows and Linux it is the window's menu bar, which is not shown while the title bar is hidden; its shortcuts still work, and a title bar of the app's own can open its menus with `Menu.popup`. `null` restores the platform's default menu. |
| `setMenuBar(mode)` | On Windows and Linux in GPUI apps, where the window draws the application menu as a bar above the app: `"shown"` (the default) shows it always; `"autoHide"` shows it after Alt is pressed and released alone, until Alt alone hides it again, as in Windows and GNOME apps. F10 and Alt with a menu's initial open a menu either way, and the bar shows while it is open. macOS's menu bar is the system's. Rust: `set_menu_bar(mode)`. |
| `popup(items, at?)` | Shows a context menu with its top left corner at `at` (the window's coordinates, in points: an `onContextMenu`'s `e.pagePosition`), or at the pointer. The promise resolves once the menu closes, whether an item was chosen or not: a button that opened it can stay pressed until then. |

In Rust, `set_application_menu(items)` takes a `Vec<MenuItem>` (`None` restores the platform's default menu), and `popup_menu(items)` (at the pointer) and `popup_menu_at(items, at)` return an `Answer<()>` that comes once the menu closes (awaiting it is optional). An item's handler runs under the owner that set the menu, while that owner lives.

Call `setApplicationMenu` again to change the menu. Inside an `effect` it follows the signals it reads: a check mark or a disabled state that depends on app state stays current.

### Menu items

```ts
type MenuItem =
  | { type: "separator" }
  | {
      label?: string;
      role?: MenuRole;
      shortcut?: string;
      when?: "always" | "auto" | "notEditing";
      disabled?: boolean;
      checked?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
    };
```

| Field | Description |
|---|---|
| `label` | What the item shows. A role's item has a label of its own without it. |
| `onSelect` | Called when the item is chosen, by a click or its shortcut. |
| `shortcut` | Its keyboard shortcut: modifiers and one key joined by `+`, such as `"mod+n"`, `"mod+shift+z"`, `"alt+f4"` or `"f11"`. The modifiers are in the table below. Keys are letters, digits and punctuation, written as the character the key types on a US keyboard without Shift (`,`, `/`; `"shift+/"` for `?`), or a name: `plus` (the `=` / `+` key, also `=`), `minus` (also `-`), `space`, `enter` (`return`), `escape` (`esc`), `tab`, `backspace`, `delete` (`del`), `insert`, the arrows `up`, `down`, `left`, `right` (`arrowup`, …), `home`, `end`, `pageup`, `pagedown`, `f1`–`f24`. Case does not matter (`"Mod+Shift+N"` is `"mod+shift+n"`; a capital letter is the same key, not Shift), and lowercase is the recommended style. An invalid shortcut (`"mod-n"`, `"mod++"`, `"mod+?"`) throws an error that gives the right spelling. `keymap` takes the same keystrokes. Menus show it in the platform's own style (`⇧⌘N` on macOS, `Ctrl+Shift+N` on Windows). |
| `when` | When the shortcut chooses the item while a text field has the keyboard focus, on the GPUI backend: `"always"` (the default), `"auto"` (unless the field uses the key itself: keys that type, move the caret or delete, and the editing shortcuts, as with [`keymap`](./nsh.md#keymap)'s bindings) or `"notEditing"`. A key the item leaves goes to the field. |
| `disabled` | `true` grays the item out (default `false`). |
| `checked` | Set (to `true` or `false`) for an item with a check mark. |
| `submenu` | Makes the item a submenu (it needs a `label`). |
| `role` | A standard item the platform carries out (below). |

`null`, `undefined` and `false` items are left out, so `cond && { … }` works in a list.

In Rust, an item is `MenuItem::new(label)`, `MenuItem::role(role)`, `MenuItem::separator()` or `MenuItem::submenu(label, items)`, with the fields as methods: `.shortcut("mod+n")` (it panics on an invalid shortcut, with the right spelling), `.shortcut_when(When::Auto)`, `.disabled(true)`, `.checked(on)`, `.on_select(f)`, and `.label(..)` for a role's item.

Modifiers:

| Modifier | macOS | Windows | Linux |
|---|---|---|---|
| `mod` (also `cmdorctrl`) | Command (⌘) | Ctrl | Ctrl |
| `cmd` (also `command`, `meta`, `super`, `win`) | Command (⌘) | Windows key | Super |
| `ctrl` (also `control`) | Control (⌃) | Ctrl | Ctrl |
| `alt` (also `option`, `opt`) | Option (⌥) | Alt | Alt |
| `shift` | Shift (⇧) | Shift | Shift |

Use `mod` for an app's own shortcuts: it is the key each platform's apps use for them (⌘N on macOS, Ctrl+N on Windows and Linux), so one spelling fits everywhere. The Windows key and Super mostly belong to the system (Win+E, the GNOME overview), so `cmd` is rarely right outside macOS.

Roles:

| Role | Does | Platforms |
|---|---|---|
| `about`, `hide`, `hideOthers`, `showAll` | The app menu's standard items | macOS (left out elsewhere) |
| `quit` | Quits the app | All |
| `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll` | Edit the focused text field (its own shortcuts stay its own) | All |
| `minimize`, `zoom`, `toggleFullScreen`, `close` | The window | All |

A role's item has the platform's label and shortcut unless it sets its own (macOS adds the app's name to `about`, `hide` and `quit`).

Menu shortcuts come first, as in native apps: a key an item takes never reaches the focused text field or NSH's own keys. Only a binding of [`keymap`](./nsh.md#keymap) of the same keystroke comes before them. So give the editing shortcuts (`mod+c`, `mod+v`, `mod+x`, `mod+a`, `mod+z`) only to the edit roles, which pass them to the text field, and avoid keys without a modifier (`escape`, the arrows, letters), which would take them from text fields and from back navigation. On the GPUI backend, `when: "auto"` lets an item share a key with text fields: `delete` or `mod+z` choose the item while no field has the focus and edit the text while one has it.

On the GPUI backend, a native component with the keyboard focus sees each key first. A key it handles itself never reaches the keymap or the menu. A key it lets through reaches the keymap as if a text field were focused, then the menu.

```rust tabs
use nsh_core::{
    desktop::MenuRole,
    element::desktop::{MenuItem, set_application_menu},
    platform::Os,
    prelude::*,
};

#[component]
fn AppMenu() -> impl IntoElement {
    let mac = os() == Os::MacOs;
    let wrap = signal(true);
    effect(move || {
        let mut menus = Vec::new();
        if mac {
            menus.push(MenuItem::submenu("My App", [
                MenuItem::role(MenuRole::About),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Hide),
                MenuItem::role(MenuRole::HideOthers),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Quit),
            ]));
        }
        let mut file = vec![
            MenuItem::new("New").shortcut("mod+n").on_select(create_document),
            MenuItem::new("Open…").shortcut("mod+o").on_select(open_document),
        ];
        if !mac {
            file.push(MenuItem::separator());
            file.push(MenuItem::role(MenuRole::Quit).label("Exit"));
        }
        menus.push(MenuItem::submenu("File", file));
        menus.push(MenuItem::submenu("Edit", [
            MenuItem::role(MenuRole::Undo),
            MenuItem::role(MenuRole::Redo),
            MenuItem::separator(),
            MenuItem::role(MenuRole::Cut),
            MenuItem::role(MenuRole::Copy),
            MenuItem::role(MenuRole::Paste),
        ]));
        menus.push(MenuItem::submenu("View", [
            MenuItem::new("Word Wrap")
                .checked(wrap.get())
                .on_select(move || wrap.update(|w| *w = !*w)),
            MenuItem::role(MenuRole::ToggleFullScreen),
        ]));
        set_application_menu(menus);
    });
    view()
}
```

```tsx tabs
import { effect, signal } from "nsh";
import { platform } from "nsh";
import { Menu } from "nsh/desktop";

const mac = platform.os === "macos";
const wrap = signal(true);

effect(() => {
  Menu.setApplicationMenu([
    mac && {
      label: "My App",
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "File",
      submenu: [
        { label: "New", shortcut: "mod+n", onSelect: () => createDocument() },
        { label: "Open…", shortcut: "mod+o", onSelect: () => openDocument() },
        !mac && { type: "separator" },
        !mac && { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }],
    },
    {
      label: "View",
      submenu: [
        { label: "Word Wrap", checked: wrap(), onSelect: () => wrap.update((w) => !w) },
        { role: "toggleFullScreen" },
      ],
    },
  ]);
});
```

A context menu, from a button's press:

```rust tabs
text("More").on_press(|| {
    let _ = popup_menu(vec![
        MenuItem::new("Rename").on_select(rename),
        MenuItem::new("Duplicate").on_select(duplicate),
        MenuItem::separator(),
        MenuItem::new("Delete").on_select(remove),
    ]);
})
```

```tsx tabs
<View
  onPress={() =>
    Menu.popup([
      { label: "Rename", onSelect: rename },
      { label: "Duplicate", onSelect: duplicate },
      { type: "separator" },
      { label: "Delete", onSelect: remove },
    ])
  }
>
  <Text>More</Text>
</View>
```

> [!NOTE]
> Menus are the system's (NSMenu, Win32 menus, GTK popover menus): they look and behave like every other app's, follow the system's (or the app's) appearance and are keyboard accessible. `examples/desktop` is an app with a title bar of its own, an application menu and context menus.

## Tray

```ts
interface TrayModule {
  set(options: TrayOptions | null): void;
}
```

`Tray.set` shows the app's icon in the system tray, or changes it; `null` removes it. There is one per app. The tray is the notification area on Windows, the right side of the menu bar on macOS, and a StatusNotifierItem on Linux, which Plasma, Waybar and most panels show (GNOME needs the AppIndicator extension).

| Option | Description |
| --- | --- |
| `icon` | The icon, as `<Image>`'s `src` takes it. Panels draw it at 16 to 24 pixels, so keep it simple and square. On macOS and Windows an SVG is a template drawn in the color of the menu bar's or taskbar's text. Without it, Windows shows the app's icon. |
| `tooltip` | Shown when the pointer rests on the icon; the app's name without it. |
| `title` | Text beside the icon, as runs `{ text, color? }`, each in its own color (a CSS color; without one, the menu bar's text color): what the app keeps in sight, such as a price. macOS's menu bar shows it in the menu bar's font. Linux's panels that show AppIndicator labels (GNOME's AppIndicator extension, Unity, MATE, Budgie) show its text right of the icon, in the panel's color; Plasma, Waybar and Windows' notification area show the icon alone. |
| `titlePlacement` | Which side of the icon the title shows on: `"right"` (the default) or `"left"`. macOS only; Linux's panels always draw the title right of the icon. |
| `menu` | Its menu, made of the same items as `Menu`'s. A secondary click opens it, and so does a primary one when there is no `onClick`. |
| `onClick` | Called when the icon is clicked with the primary button (on Windows, Enter or Space on the icon too), with `{ bounds }`: where the icon is ([below](#a-window-at-the-icon)). |

Call `set` again to change it; inside an `effect` it follows the signals it reads.

```tsx
import { Tray, Window } from "nsh/desktop";
import icon from "./tray.svg";

Tray.set({
  icon,
  tooltip: "Mail",
  onClick: () => Window.get("main")?.focus(),
  menu: [
    { label: "New Message", onSelect: compose },
    { type: "separator" },
    { role: "quit" },
  ],
});
```

A window the app shows or focuses in `onClick` or in a menu item's `onSelect` comes to the front, on Linux's Wayland desktops too, where the panel hands the app the activation token of the click.

A title keeps something in sight beside the icon in macOS's menu bar, such as a price, its change in a color of the app's theme. A run's color is fixed when `set` is called; set the tray inside an `effect` that reads the color scheme for a theme color to follow light and dark:

```rust tabs
use nsh_core::desktop::TrayTitleRun;

set_tray(tray().icon(icon).title([
    TrayTitleRun::new("AAPL 228.00 "),
    TrayTitleRun::new("+1.33%").color(color(tokens().color("up").unwrap())),
]));
```

```tsx tabs
import { token } from "nsh";

Tray.set({
  icon,
  title: [{ text: "AAPL 228.00 " }, { text: "+1.33%", color: token("up") }],
});
```

### A window at the icon

`onClick`'s `bounds` is the icon's frame on the screen when it was clicked, in points, in the coordinates of `displays()` and `setBounds`: from the primary display's top left corner, `y` growing down. On macOS it is the status item's place in the menu bar, on Windows the icon's place in the notification area or its overflow. On Linux it is `null`, as the window manager places the app's windows there; it is `null` too whenever the system reports a click without a frame. A popup window opened from it shows next to the icon: below a menu bar at the top of the screen, above a taskbar at the bottom.

```tsx
import type { Bounds, Point, Size } from "nsh";
import { Tray, Window, displays } from "nsh/desktop";
import { TrayPanel } from "./TrayPanel";

const size = { width: 320, height: 240 };

Tray.set({
  icon,
  onClick: ({ bounds }) => {
    if (!bounds) return Window.get("main")?.focus();
    Window.open(TrayPanel, {
      id: "tray-panel",
      kind: "popup",
      defaultSize: size,
      defaultPosition: atIcon(bounds, size),
    }).focus();
  },
});

/** Centered on the icon, on the side of its display with more room, kept
 * in the display's visible area. */
function atIcon(icon: Bounds, size: Size): Point {
  const inside = (b: Bounds, p: Point) =>
    p.x >= b.origin.x && p.x < b.origin.x + b.size.width && p.y >= b.origin.y && p.y < b.origin.y + b.size.height;
  const display = displays().find(d => inside(d.bounds, icon.origin)) ?? displays()[0];
  if (!display) return { x: icon.origin.x, y: icon.origin.y + icon.size.height };
  const area = display.visibleBounds;
  const below = icon.origin.y < area.origin.y + area.size.height / 2;
  const x = icon.origin.x + (icon.size.width - size.width) / 2;
  const y = below ? icon.origin.y + icon.size.height + 4 : icon.origin.y - size.height - 4;
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  return {
    x: clamp(x, area.origin.x, area.origin.x + area.size.width - size.width),
    y: clamp(y, area.origin.y, area.origin.y + area.size.height - size.height),
  };
}
```

In Rust, `set_tray(tray()...)` is the same (`None` removes it): `tray()` is a builder with `.icon(..)`, `.tooltip(..)`, `.title(runs)` (`TrayTitleRun::new(text)`, with `.color(..)`), `.title_placement(..)` (`TrayTitlePlacement`), `.menu(items)` (the same `MenuItem`s as `set_application_menu`) and `.on_click(|e| ..)`, whose `TrayClickEvent` carries `bounds: Option<Bounds<Points>>`. Its handlers run under the owner that set it, while that owner lives; in an `effect` it follows the signals it reads. One tray per app, shared with TSX: the last set wins.

```rust
use nsh_core::element::desktop::{MenuItem, main_window, quit, set_tray, tray};

set_tray(
    tray()
        .icon("tray.svg")
        .tooltip("Mail")
        .on_click(|_| main_window().focus())
        .menu([
            MenuItem::new("New Message").on_select(compose),
            MenuItem::separator(),
            MenuItem::new("Quit").on_select(quit),
        ]),
);
```

## GlobalShortcut

```ts
interface GlobalShortcutModule {
  register(shortcut: string, onPress: () => void): Promise<boolean>;
  unregister(shortcut: string): void;
  unregisterAll(): void;
}
```

A global shortcut reaches the app whichever app has the keyboard. `register` takes a keystroke written as a menu item's `shortcut` (`"mod+shift+k"`) and resolves with whether the system took it: `false` when another app holds it, or off desktops. Registering a keystroke again replaces its function.

On macOS they ask the user for no permission. A letter is the key that types it on the keyboard layout at registration, so `k` stays `k` on Dvorak.

On Windows a keystroke is the app's alone: one another app holds, or one the system keeps (Win+L), resolves `false`. Holding the keys down presses once.

On Linux, shortcuts go through the desktop portal (`org.freedesktop.portal.GlobalShortcuts`), the only way on Wayland. The keystroke is only a preference: the desktop may ask the user to confirm it or pick another. Hyprland binds them in its own configuration, by the app's id and the keystroke written in lowercase: `bind = CTRL ALT, K, global, com.example.mail:ctrl+alt+k`, or in a Lua configuration `hl.bind("CTRL + ALT + K", hl.dsp.global("com.example.mail:ctrl+alt+k"))`. The portal knows the app by its id, which needs the app's `.desktop` file: `nsh package` installs one, and `nsh run` writes one for an app with URL schemes.

```tsx
import { GlobalShortcut, Window } from "nsh/desktop";

const ok = await GlobalShortcut.register("mod+shift+space", () => Window.get("main")?.focus());
```

In Rust, `register_global_shortcut(keystroke, on_press)` returns an `Answer<bool>`, awaited in a task or left alone; it panics on a keystroke that is not one, as `MenuItem::shortcut` does. `unregister_global_shortcut(keystroke)` and `unregister_all_global_shortcuts()` give them back, and a shortcut is also given back when the owner that registered it goes.

```rust
use nsh_core::element::desktop::{main_window, register_global_shortcut};

let taken = register_global_shortcut("mod+shift+space", || main_window().focus());
spawn(async move {
    if !taken.await {
        log::warn!("mod+shift+space is taken");
    }
});
```
