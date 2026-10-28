---
title: Terminal
description: Run Native Shell apps in a terminal, package console applications, and embed an independent NSH surface in a Ratatui app.
order: 15.75
group: platforms
---

# Terminal

Native Shell renders apps in terminals on macOS, Windows and Linux with Ratatui and Crossterm. The same TSX and
Rust components, reactive graph, Taffy flex and grid layout, virtualized lists, networking and sandbox run behind
the terminal view. A terminal application can embed an independent `AppView` in any rectangular region it owns.

## Running an app

```sh
nsh run my-app --target tui
```

The host uses the terminal's alternate screen, keyboard, mouse and bracketed paste, and restores the terminal when
the app closes. TSX edits arrive through the same development server as on graphical platforms. Ctrl+Q closes the
app. The distributed host is in `runtime/tui/`; a checkout builds `nsh-tui-host` on demand.

The operations workbench combines sidebar navigation,
search and status filters, service metrics, a detail inspector, canvas charts, an activity timeline and a deployment
dialog. Its compact 120×34 layout shows seven complete service rows with metrics and a chart; 160×50 also shows
the inspector and activity timeline. At 140 columns and wider, the inspector offers Details, Effects and Guide
tabs. Effects combines a local image, blur, blend modes, an animated layer, bundled Pacifico canvas lettering and
a popup menu; Guide opens a local HTML runbook in readable mode. Shorter terminals fold away secondary content to
keep the fleet visible:

```sh
nsh run examples/terminal-workbench --target tui
```

The host can also load a built bundle directly:

```sh
nsh build my-app --release -o build
dist/nsh/runtime/tui/nsh-tui-host --bundle build/bundle.nshc --size 120x34
```

`--size` uses columns and rows. In an interactive session the current terminal size determines the viewport;
scripts use the supplied size as their initial viewport.

## Layout and drawing

NSH keeps layout in points. By default, one terminal cell represents **8×16 points**, so a 120×40 terminal supplies
a 960×640-point viewport to Taffy. Padding, flex and grid, scroll offsets, image sizes and pointer hit testing
share that coordinate system. Resizing the terminal relays the new viewport to the engine and reflows the app.

Text wraps by terminal column width: Chinese and many emoji occupy two columns, and combining sequences stay
together. Text spans preserve colors, bold and italic, underlines and strikethrough; bidirectional paragraphs
reorder their runs for display. The terminal's font determines the face and glyph size. Explicit line height and
letter spacing are rounded to terminal rows and columns.

Backgrounds, borders and clipping follow the retained view tree. Transforms project complete view subtrees, with
pointer hit testing following the transformed geometry. Rounded descendant clipping, group opacity, blend modes,
ordered filters and backdrop filters are composited on the graphics worker.

On startup, the interactive host detects image protocols and the terminal's physical cell dimensions. Images and
recorded canvas drawings use
[`ratatui-image`](https://docs.rs/ratatui-image/11.1.0/ratatui_image/) with Kitty, Sixel or iTerm2 graphics when
available. Encoding runs on the graphics worker. Colored half and quadrant blocks provide a portable drawing
path and preserve composition where text or overlays overlap a graphic. Each cell selects the lower-error block
but still has only two colors. The terminal controls glyph shapes and how RGB colors map to its palette.

`NSH_IMAGE_PROTOCOL` selects `auto` (the default), `halfblocks`, `kitty`, `sixel` or `iterm2`. `halfblocks` starts
directly with ordinary text rendering. Selecting a graphics protocol uses the terminal's reported pixel dimensions.
Headless scripts render reproducible text snapshots. An embedding host selects its protocol explicitly through
`AppView::set_image_protocol`; creating an embedded view leaves terminal IO with its host.

The existing [`nsh/base`](../modules/nsh-base.md) components render through these primitives. Give each
interactive row enough height to occupy at least one terminal row, use clear color contrast and keep important
labels legible at the terminal's column width.

Canvas paths, gradients, clipping, transforms, compositing and image drawing are rasterized on a worker. Canvas
text uses shaped outlines from fonts registered with the surface and system fallback fonts; `measureText` uses
the same shaping and font selection as drawing. Registered TrueType, OpenType and font-collection faces belong to
that surface. Ordinary `Text` uses the terminal's font and cell geometry; transformed or effected text groups
rasterize font outlines fitted to the measured cell geometry.

Images support PNG, JPEG, GIF and WebP, including animated GIF and WebP within the decoder's resource bounds.
`objectPosition` places an image within its box after `objectFit` sizes it, for both cell and pixel graphics.
`placeholder` remains visible during loading and after a load error. `blurRadius` runs on the worker and
`fadeDuration` sets the loaded image's fade over its placeholder; the terminal default is 0 ms. Download progress
arrives at most once every 100 ms and on completion.

Page stacks and dialogs apply slide, fade or immediate transitions. Apps supply page headers, dialog backdrops,
cards and close controls. Dialogs occupy the viewport, and back or close actions follow the mounted props.
Hosts can select reduced motion with `AppOptions::reduce_motion` or `AppView::set_reduce_motion`.

## Keyboard and mouse

| Keys | Action |
|---|---|
| Tab, Shift+Tab | Focus the next or previous input, pressable or scroll view, within the newest modal |
| Enter, Space | Activate the focused pressable |
| Escape | Leave an input; otherwise go back or request modal dismissal |
| Arrows, Page Up / Down, Home / End | Scroll the focused scroll view or a scrollable ancestor |
| Ctrl+wheel, Ctrl++ / Ctrl+- | Zoom a scroll view within its configured limits |
| Ctrl+0 | Reset the scroll view's zoom |
| F10 | Open the application menu |
| Ctrl+Q | Close the terminal host |
| Ctrl+C | Copy an input or selectable-text selection; otherwise close the host |

Click to focus or activate controls while keeping their current scroll position. Keyboard navigation and
programmatic focus scroll the chosen control into view. Newly mounted list controls are revealed at their
completed layout position; an explicit scroll or zoom issued afterward takes priority for that scroll view.
The mouse wheel scrolls vertically; Shift+wheel scrolls horizontally. Pointer
positions are converted from cells into the same virtual points used by layout. Middle-button dragging pans scroll
content with inertia, bounce and pull-to-refresh according to its props. Drag a scrollbar thumb with the left
button, or click its track to page. Zoom honors the scroll view's zoom and gesture props; paging, snap offsets,
right-to-left layout and animated scroll commands use the same native scroll state.

The terminal reports hover entry and exit, but does not emit continuous `onHoverMove` or `onMouseMove` callbacks.
The scripted `hover` step moves the pointer without adding those callbacks.

Inputs support grapheme-aware cursor movement and deletion, Shift selection, word movement with Ctrl/Alt+arrows,
Home / End, Ctrl+Home / End, select all, undo and redo. Ctrl+A/C/X/V select, copy, cut and paste; Ctrl+Z and
Ctrl+Shift+Z or Ctrl+Y undo and redo. Secure fields mask their contents and protect
copy and cut. Terminal keys and bracketed paste preserve their literal text. Input methods enter committed text
through the terminal; bracketed paste enters text as one edit. Enter follows `submitBehavior`, and Shift/Alt+Enter
inserts a newline into a multiline input.

The interactive standalone host connects copying and pasting to the operating system clipboard through its
clipboard helpers, with OSC 52 as a copy fallback. Embedded views and scripts start with a surface-local clipboard;
an embedding host can connect its own clipboard through `HostServices`. NSH transfers the complete text;
the operating system helper or terminal handles clipboard acceptance.

The app's [`keymap`](../modules/nsh.md#keymap) bindings run before default handling. Terminal emulators decide
which keys and modifiers reach an app; choose shortcuts that your supported terminal forwards.

Selectable text supports mouse selection, and inline text links activate through pointer hit testing.
[`View selectable`](../elements/text-selection.md) extends a selection across text nodes, lines and `TextView`
blocks. Drag or Shift+click to extend it; dragging beyond a Scroll edge scrolls while held. Ctrl+A selects the
area, Ctrl+C or Ctrl+Insert copies, and Escape clears a nonempty selection. Text with `style={{ userSelect: "none" }}`
stays out, so labels and control captions need not enter a copy. Copy uses the underlying text, including its
line breaks and Unicode content, through the same host clipboard and OSC 52 path described above.
A modal or focused popup suspends keyboard handling for a retained background selection; closing the overlay
makes that selection available again. Native alert and action-sheet overlays use Tab or the arrows to choose
a button and Enter to activate it.

[`nsh/desktop`](../modules/nsh-desktop.md) is available on terminal surfaces for titles and menus.
`platform.isTerminal` identifies this presentation while `platform.idiom === "desktop" && !platform.isTerminal` identifies graphical desktop surfaces.
F10 opens the application menu; arrows navigate, Enter or Space selects, and Escape closes it. Application and
popup menus include submenus, checkmarks, disabled items and shortcuts. Window titles update through sanitized
OSC 2 output in the standalone host.

## Readable pages and video

`WebView` presents HTML as a readable terminal page with headings, paragraphs, lists, preformatted blocks and
basic tables. Both inline HTML and remote URI sources use this mode. URI navigation follows the app's `webview`
capabilities and checks redirects against those grants. Links have numbered references: Tab selects a link and
scrolls it into view, and Enter follows it. Alt+Left and Alt+Right navigate history; reload, stop and scrolling
commands operate on the reader.

`Video` presents picture playback through FFmpeg, with pause, seek, playback rate, repeat and load/progress events.
Install `ffmpeg` and `ffprobe` on the executable search path, or select them with `NSH_FFMPEG` and `NSH_FFPROBE`.
Embedding hosts can supply native components for audio output, browser execution or platform-specific media
presentations.

## App data

[`nsh`](../modules/nsh-storage.md) keeps string values across launches and development reloads. Each
application's `nsh.json` `id` names its own `storage.json` directory under the system data directory: Application
Support on macOS, `%APPDATA%` on Windows and `$XDG_DATA_HOME` (or `~/.local/share`) on Linux. Bundles and Rust roots
carry the same app identity, so both entries use the same data. Releases declare their own `id` in `nsh.json`.

## Packaging

```sh
nsh package my-app --target tui
nsh package my-app --target tui --run
```

The console runner and its resources travel together:

```text
out/<Name>/
  <Name>                 executable; <Name>.exe on Windows
  nsh/bundle.nshc        compiled TSX application
  nsh/assets/…           imported assets
  nsh/app.json           application metadata
  nsh/capabilities.json  application capabilities, when configured
```

The same directory is archived as `<Name>.tar.gz` on macOS and Linux and `<Name>.zip` on Windows. Package on the
operating system where the executable will run. Keep the `nsh/` directory beside the executable. The terminal
runtime uses Rust libraries and the operating system's console facilities. `--run` launches it in the current
terminal and waits until it closes. Rust root applications use the same package layout with their root compiled
into the runner.

## Embedding in a Ratatui app

`nsh-platform-tui` exposes an `AppView` with its own engine, retained surface and input state. Use
`view.load_with_config(config)` to run a shared `nsh_engine::EngineConfig`, retaining its UI registries, asset
reader, module loader, runtime and host context. The view supplies its actual terminal viewport and environment.
Your host owns the
terminal, event loop and other Ratatui widgets. Load a bundle, then poll commits, advance animations, forward
events and draw into the region assigned to the view:

```rust
use nsh_platform_tui::{AppOptions, AppView, Bundle};

let mut view = AppView::new(AppOptions::default());
let code = std::fs::read_to_string("app/bundle.js")?;
view.load(Bundle::source(code).into())?;

// In the host's event loop:
view.poll()?;
view.tick(start.elapsed().as_secs_f64())?;
view.resize(area.width, area.height);
view.render(area, frame.buffer_mut());
```

Forward keyboard and paste events with `view.handle_event(event)`. Translate mouse positions to coordinates
relative to the view's region before forwarding them; route events only to the surface that should receive them.
Dropping the view or calling `stop()` ends its engine.

Hosts driving `Surface` and `LocalEngine` directly deliver events to `Surface::handle_event` against the current
mounted scene. The surface owns native pointer capture, selection, focus and gestures. Forward its ordered
`SurfaceEvent`s through the engine's `EngineControl`, using `dispatch_event` for application callbacks, then
call `LocalEngine::pump()` and apply every resulting mount batch before the next physical event. Publish
`Surface::focus_path()` through `EngineControl::set_focus_path` before enqueueing events or environment updates.
Engine work and native input continue while terminal output completes.

`Surface::handle_wheel(mouse, steps)` groups consecutive detents with identical coordinates, direction and
modifiers against one live hit-tested owner and returns the number consumed. Host components receive at most
one detent per call so their events can be dispatched before more input arrives. When the host's input region
changes, `Surface::cancel_pointer()` cancels native capture while retaining keyboard focus; forward its
resulting events through the same engine control.

`AppOptions::asset_base` resolves `asset:/` URIs from an asset directory or HTTP base.
`AppOptions::limits` configures the VM limits; embedding defaults to `Limits::default()`, while the standalone
hosts use `Limits::standalone()`. `nsh run --target tui --limits` uses the embedding defaults for a TSX entry;
pass named limits to choose their values. `AppOptions::metrics` accepts a validated `CellMetrics` value for hosts
that choose a different virtual point scale. See [Sandbox and capabilities](./sandbox-and-capabilities.md).

`AppOptions::data_dir` chooses the embedding app's directory for app data, such as its own data directory plus
`nsh/`. Each loaded app uses its own id below that directory. `AppOptions::storage` connects the host's own
`nsh_engine::StorageBackend` and takes precedence over the file location.

Connect optional clipboard, title and accessibility-announcement callbacks with
`AppView::set_host_services(Some(services))`. `AppView::accessibility_snapshot()` exposes each accessible node's
role, label, hint, state, value, frame, focus and actions; `Surface::perform_accessibility_action` routes host
actions back to the mounted app. Secure input values stay protected. Creating an embedded view leaves terminal
IO and service integration under the host's control.

For [native components](./native-components.md), implement `NativeComponent` and register its factory with
`AppView::register_component(name, factory)` before loading the app. Each mounted leaf gets its own instance,
receives props and commands, paints into its clipped region, and can return native events to TSX. Hosts can supply
terminal presentations for content such as maps, browser pages and media controls.

### Host-owned services

Supply native modules for one view with `AppOptions::ui_sets`. A registry's `value` factory can capture
the host's scoped client and expose a Rust class instance to TSX:

```rust
use nsh_core::element::{Instance, Registry};

let mut native = Registry::ui_set("my-app/native");
native.value("service", move || Instance::new(Service::from(client.clone())));
let options = AppOptions {
    ui_sets: Some(vec![native]),
    ..Default::default()
};
```

Here `Service` is the host's `#[class]` wrapper. Its methods, including async methods, generate TypeScript
declarations; TSX uses `import { service } from "my-app/native"`. A class without a constructor keeps
client creation in the host. The first import or [`nativeModule`](../modules/nsh.md#nativemodule) lookup
runs the factory once per VM, and both paths share its value; reloads create new values. The host retains
cancellation, subscription cleanup and service-operation receipts.
`None` uses the process's default modules, while `Some(vec![])` selects an empty set.

## Reproducible interaction

The host's `--script` runs against an in-memory Ratatui buffer and saves UTF-8 text snapshots. Steps are separated
by semicolons or newlines:

```sh
nsh-tui-host --bundle build/bundle.nshc --size 120x40 \
  --script "wait 300; shot home.txt; key Tab; type 你好 👋; resize 100 35; wait 300; shot resized.txt; quit"
```

| Step | Action |
|---|---|
| `wait <ms>` | Process commits and animations for the duration |
| `shot <file.txt>` | Save the current text buffer |
| `tap <column> <row>` | Click a cell |
| `hover <column> <row>` | Move the pointer to a cell |
| `wheel <column> <row> <dx> <dy>` | Scroll in wheel detents at a cell |
| `type <text>` | Paste UTF-8 text into the focused input |
| `key <name>` | Send a key, such as `Tab`, `Enter`, `Esc`, `Ctrl+a` or `Shift+Left` |
| `selectall` | Select all text in the focused input |
| `resize <columns> <rows>` | Change the viewport and relayout |
| `dark`, `light` | Set the surface appearance |
| `expect <text>` | Assert that the snapshot contains text |
| `expect-focus` | Assert that a node has keyboard focus |
| `quit` | Stop the app |

Snapshots preserve ordinary terminal text and layout. Rasterized text and graphics appear as half-block
approximations; use labels outside effect groups for text assertions. Inspect colors and graphic details in an
interactive terminal.

## See also

- [CLI](./cli.md)
- [Packaging](./packaging.md)
- [Images and assets](./images-and-assets.md)
- [Canvas](./canvas.md)
- [Platform overview](./platforms.md)
