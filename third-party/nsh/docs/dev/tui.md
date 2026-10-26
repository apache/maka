# Terminal backend

`nsh-platform-tui` runs the shared engine in a terminal on Linux, macOS and
Windows. It keeps the GUI primitives and Rust components intact: Taffy lays
out point coordinates, the engine delivers one `MountBatch` per commit,
and a retained `Surface` paints into a Ratatui `Buffer`. Ratatui compares
buffers and Crossterm performs terminal IO only in the standalone runner.

Read [architecture](architecture.md), [text](text.md),
[scrolling and lists](scrolling-and-lists.md), [canvas](canvas.md) and
[images](images.md) before changing the corresponding pipeline. The user
guide is [Terminal](../../website/docs/tui.md), with a matching
[Chinese page](../../website/zh-CN/docs/tui.md).

## Ownership and data flow

- `app.rs`: `AppView` owns one engine, surface, event queue and asset
  provider. `load` starts a Rust root or JS bundle; `poll` drains batches;
  `tick` advances native work and forwards generated events. An embedded
  view never acquires terminal modes. `run_app` owns raw mode, alternate
  screen, mouse capture, bracketed paste, the event loop and restoration.
- `surface.rs`: dense node slots retain the mounted scene, scrolling,
  screen/modal state, animation bindings and decoded image references.
  It applies batches in order. Native state decisions happen before JS
  receives events, as on the other platforms.
  Inline-link locators index the resident Text snapshots directly; text
  replacement and physical node removal maintain the index, while parked
  list cells retain their text and locators together.
- `text.rs`: engine-thread text layout records terminal graphemes and
  positions in the type-erased `TextLayout`; the renderer uses those runs
  directly. Terminal widths come from `unicode-width`, graphemes from
  `unicode-segmentation`, line breaks from `unicode-linebreak` and visual
  runs from `unicode-bidi`. Indices crossing the engine are UTF-16.
- `fonts.rs`: a per-surface font catalog shared with the text engine and
  graphics worker. Registration, canvas measurement and rasterized glyph
  outlines use the same face selection and shaping.
- `input.rs` and `editor.rs`: terminal events, hit testing, focus scopes,
  press state, scroll offsets and grapheme-safe editing. The editor keeps
  undo/redo and selections in Rust. Controlled values use the existing
  event-count protocol to reject stale JS updates.
- `render.rs`: point-to-cell conversion, view decorations, text and
  input painting, scrollbars, focus indication, modal and system dialogs.
- `geometry.rs` and `composite.rs`: presentation matrices, inverse hit
  testing and asynchronous raster composition for transformed or effected
  subtrees. Ordinary nodes retain the direct terminal-cell paint path.
  Each immutable render pass caches presentation matrices by node ID;
  occlusion and ancestor clips reuse them, and input always reads current
  geometry outside that pass.
- `scroll.rs` and `navigation.rs`: native scrolling, zoom, drag/inertia,
  page and dialog transitions, viewport-sized dialog layers and back handling.
- `motion.rs`: presentation tracks for layout create/update/delete,
  style transitions and keyframe animations. Layout/style targets stay
  on the node; drawing and hit testing sample the same presentation.
  Idle nodes keep no motion record, and completed tracks are released.
- `image.rs`, `image_state.rs`, `canvas.rs`, `worker.rs`: asset loading, image decoding,
  canvas rasterization and completed-job queues. File and network IO and
  rasterization stay off the terminal draw loop. The renderer samples
  upper/lower half-cell colors for universal `▀` characters; `protocol.rs`
  prepares clipped pixel graphics and encodes them with `ratatui-image` on
  the same worker for capable terminals.
- `media.rs`: bounded readable-HTML loading and optional pipe-based FFmpeg
  video decoding. Retired jobs retain worker permits until their IO exits.
- `services.rs`: explicit embedding callbacks, supervised clipboard
  helpers, menus, terminal title/output requests and semantic accessibility.
- `native.rs`: per-view factories for host terminal components, receiving
  the existing native props, commands and event protocol. Animated
  component props retain stable named slots and are delivered once per changed
  value through the same Graph. Numeric and ARGB color setters default to
  `set_prop`; responses and intrinsic sizing follow ordinary prop updates.
  Unbinding or replacing/deleting a component resets its delivery cache.
- `script.rs`: deterministic in-memory drawing and simulated events; it
  parses all steps before starting the app, then waits for the first
  real mount batch before executing assertions and snapshots.

`nsh-tui-host` is the development executable and enables `dev` (JS, dev
server and hot updates). `nsh-tui-app` is a console release runner. The
platform's default feature is `js`; `--no-default-features` supports a
native Rust root without linking QuickJS. The backend belongs to the main
workspace; its dependencies are in the root `Cargo.toml`.

The engine's `nsh/storage` uses `<data_dir>/<app id>/storage.json`, with
the system data directory by default. `AppOptions::data_dir` selects the
embedding host's directory; `AppOptions::storage` supplies a backend of
its own and takes precedence. The app id travels with JS bundles (build
metadata and dev-server messages) and Rust roots. Full reloads after hot
updates retain the latest bundle's id, keeping the same storage. Apps
with different ids keep separate files in a shared data directory.

`AppOptions::ui_sets` supplies registries to this view's engines and its development handshake.
`None` uses the process's `set_ui_sets` fallback; `Some(vec![])` explicitly serves no custom modules.
Use explicit per-view registries for host-owned values (`Registry::value`, [JS modules](js-modules.md#host-owned-values)):
the factory captures the native capability granted to that view, creates its local wrapper on the
engine thread on the first import or `nativeModule` lookup, and runs again for each replacement VM. Both access
paths share the same value in that VM. Stopping the view joins
its engine thread; the embedding host separately closes external subscriptions and tracks service receipts.

## Renderer type names

`nsh_core::ui::Renderer<T>` is the component render callback used by
`TextView`. The platform identity enum remains
`nsh_core::platform::Renderer`; `ui` and `ui::prelude` re-export it as
`PlatformRenderer`. Code that previously used the terminal branch's
`ui::Renderer::Terminal` should use `ui::PlatformRenderer::Terminal`
or the unchanged `platform::Renderer::Terminal`.

## Coordinates and typography

`CellMetrics::default()` is 8 points wide by 16 points high. A 120×40
terminal therefore starts the engine at 960×640 points. Never feed cell
counts directly to Taffy: text, padding, lists, hit slop, image geometry,
scroll offsets and animation all use points. Only terminal events,
script coordinates, Ratatui rectangles and the outer viewport use cells.
Solid and gradient view backgrounds cover the terminal cells whose centers
lie within both the view rectangle and its clip, using half-open bounds.

Custom cell dimensions must be finite and strictly positive. Embedded
hosts call `resize(columns, rows)` when their assigned region changes;
interactive standalone hosts use Crossterm's actual terminal size. The
host's `--size` controls the initial in-memory script viewport.

`Text` respects terminal grapheme widths, UAX #14 line opportunities,
paragraph bidi ordering, tabs at four-column stops, multiline and nowrap,
all ellipsis modes, alignment, inline attachments and UTF-16 line/run
indices. Font weight at least 600 requests bold; italic, underline,
strikethrough and text colors are terminal styles. Explicit line height
rounds up to terminal rows, and positive letter spacing rounds to columns.
Font size and family do not change terminal glyph advances: the emulator
chooses the physical font. Text shadows use a bounded cell kernel.

Registered TrueType, OpenType and collection fonts belong to one surface.
Canvas text uses that catalog with system-font fallback, Rustybuzz shaping
and outline rasterization; `measureText` uses the same font selection and
shaping as drawing. Its transforms and metrics belong to the canvas rather
than the terminal glyph grid. Rasterized text inside a transformed or
effected subtree fits outlines to the existing measured grapheme boxes.
Ordinary text still uses terminal glyphs. Raster glyphs support bounded
PNG/BGRA/grayscale font bitmaps and COLR v0 layers; COLR v1 paint graphs
and SVG glyph documents use replacement-outline fallback. Registration
invalidates that surface's raster caches; it never changes another view's
fonts.

## Interaction

The focus order includes visible inputs, pressables, enabled scroll views
and focusable host components. Only the newest modal participates while
it is open; background navigation screens cannot receive input. Tab and
Shift+Tab traverse this scope, and Enter/Space activate a pressable.
Keyboard, programmatic and automatic focus scroll the chosen node into view.
Pointer focus preserves the scroll position of the content being clicked.
The initial pointer contact places an input caret using the text visible before
native focus changes; captured selection drags follow the editor's scrolling.
Popovers and dialogs retain the actual opener across scope replacement.
A retiring scope passes its surviving opener to the replacement, including
its node generation and caret. Covered openers stay eligible as return
targets; focus moves only inside the current input scope. Animated dialog
exits retain this return target until their native navigation completes.
Within a mount batch, focus selection and events follow command order. The
implicit reveal of a newly selected focus waits until the batch's final cell
positions and scroll limits are applied. It follows only the still-current
node generation; later explicit scroll or zoom commands retain their chosen
position for the affected ancestor. The reveal is consumed before `apply`
returns, so later user scrolling remains independent.
Compact pressable rows underline their text for focus; graphics cells and
their protocol placeholders retain their colors and encoding state.

Inputs support cursor and selection movement, Unicode-safe deletion,
word/line/document movement, undo/redo, secure values, UTF-16 `maxLength`
and controlled-value event counts. `Clipboard` commands enforce the
mounted capability policy; copy/cut from a secure input is refused.
Interactive standalone apps use supervised OS clipboard helpers, with
OSC 52 as a write fallback. Embedded views and scripts use a local
clipboard unless the host supplies `HostServices`. Clipboard reads check
the current focus, selection and edit count before applying a late paste.
Clipboard text is transferred in full through local storage, host callbacks
and OSC 52 output; the selected operating system helper or terminal controls
whether it accepts the transfer.
Bracketed paste is one edit, and physical keys and paste preserve literal
text. Multiline values and paste retain their line endings and whitespace;
Return follows the first existing line ending, or uses LF in a new document.
Rendering filters terminal control sequences without changing editing data.
`input_context` exposes editing/autofill/correction hints to a host
keyboard, omitting secure text; `apply_input_edit` validates its node,
generation, UTF-16 selection, grapheme boundaries and maximum length.

Ctrl+Q always requests exit. Ctrl+C copies an input or selectable-text
selection and otherwise requests exit.
Escape leaves an input first, then invokes native back/modal handling.
Return follows `submitBehavior`; Shift/Alt+Return inserts a multiline
newline. Scrollable views accept arrows, Page Up/Down and Home/End;
wheel detents scroll three rows or three columns. App keymaps are checked
before ordinary input defaults, with text-input and repeat restrictions.
`keymap.bind(..., { within: node })` adds a native focus predicate: the node
itself or a mounted descendant must have focus. A scope miss continues
through older eligible bindings and ordinary input defaults.
`keymap.focusedWithin(node)` reads the latest host-supplied focus path as a
nonreactive boolean snapshot; reading it adds no dependency to an effect.
Both focus APIs use real `YNode` references. Supplying `within` or calling
`focusedWithin` on a host without native focus-scope support throws `TypeError`.
Terminal protocols may merge key combinations or consume them before the
application receives them.

Middle-button content dragging drives native scrolling, inertia, bounce
and mounted pull-to-refresh behavior. Left-button dragging remains
available for text, app pans and navigation; scrollbar thumbs and tracks
accept left-button drag or paging. Wheel events remain discrete and honor
paging, snapping and RTL. Ctrl+wheel and Ctrl+plus/minus zoom within the
mounted limits; Ctrl+0 resets the scale. Animated `scrollTo`, `scrollToEnd`
and `zoomTo` run natively. Drag, momentum, refresh and scroll completion
events use the shared event protocol.

Selectable text has mouse drag selection and Ctrl+A/C, with inline link
hit testing through the shaped runs' UTF-16 ranges. Pointer input also
reports raw touch events, native long press and mounted pan gesture
values; the terminal reports one mouse pointer rather than multitouch.
Ctrl+wheel also drives a view's mounted `pinch` animated value when no
zoomable Scroll on its pointer path takes the input. Each delivery pairs
`onPinchStart` and `onPinchEnd` when subscribed; native values need no JS listener.
Hover entry and exit are reported, but continuous `onHoverMove` and
`onMouseMove` callbacks are not emitted by this backend. The scripted
`hover` step moves the pointer; it does not add those callbacks.
`SelectionArea` shares one `nsh_core::selection::SelectionModel` across
its text nodes, including multiline text and `TextView` blocks. It uses
the shaped text's UTF-16 hit positions and text values, rather than copying
terminal cells; `selectable={false}` labels and control captions stay out. Mouse
dragging and Shift+click extend the selection, and dragging beyond a Scroll
edge scrolls while the pointer is held. Ctrl+A selects the area, Ctrl+C or
Ctrl+Insert copies, and Escape clears a nonempty selection. App keymaps
retain their priority. A retained background selection receives these keys
only in the active input scope: a modal or focused popup suspends its
keyboard ownership until that scope closes. Selection copies use the same
host clipboard services and complete OSC 52 output as other clipboard writes.

The native animation graph and `motion.rs` presentation tracks run on
terminal ticks. Layout animations interpolate frames and retain exiting
nodes until their opacity or scale transition finishes; exiting nodes
continue painting while they are excluded from input. Style transitions
interpolate colors, opacity, compatible transforms, shadows and shapes.
Keyframes support spin, ping, pulse and bounce with their configured
delays and iteration counts. Interrupted transitions start from the
current presentation; unchanged keyframes keep their original clock.
Scroll offsets and native animation reads/completions return through the
existing engine messages. Drawing and hit testing share the sampled
presentation geometry; rendering remains quantized to cells and
half-cell color samples.

Page push/pop defaults to a 300 ms horizontal slide with previous-page
parallax; fade uses 200 ms and the first page appears immediately.
Dialogs support slide, fade and immediate presentation, with `Show` after
entry and `Dismiss` after exit. Each dialog occupies the viewport: its app
supplies the backdrop, card and close controls. Pages place the app's
header slot in the normal content tree, and report `NO_NATIVE_HEADER` to
the engine. Mounted prevention and close props govern back handling;
reduced motion selects fades for transitions.

## Graphics and platform boundaries

PNG, JPEG, GIF and WebP decode on the graphics worker. SVG image sources are not
supported by the terminal backend, even though the GUI native backends support them. Still images apply
EXIF orientation. Animated GIF/WebP preserve timing and loops within
bounded frame/memory limits, falling back to the first frame if needed.
Encoded images are limited to 64 MiB, 8192 pixels on either side and
16 million pixels. The cache is bounded separately from compressed input.
Canvas rasterization is limited to 8192 pixels per side and 8 million
pixels; it supports paths, clips, transforms, gradients, blend modes,
alpha, shadows, image cropping and native animation argument slots.
Image `defaultSource` remains visible during loading and after failure.
`blurRadius` applies a bounded premultiplied-alpha Gaussian approximation
on the worker, including every animation frame. An explicit `fadeDuration`
fades the new source over its full-opacity placeholder; the terminal
default is immediate and sharp cache hits appear immediately. Progress
events are throttled to 100 ms plus completion; a custom asset provider
reports its completed read. Source/revision tickets discard stale work
and revoked capabilities remove denied layers.

Interactive `run_app` probes Kitty, Sixel and cell pixel dimensions with
`ratatui-image`'s capability parser, using environment hints for iTerm2.
The probe owns stdin synchronously before the Crossterm reader starts,
has a 600 ms deadline and a 16 KiB input budget, and leaves no background
reader. It never changes tmux pane options. `NSH_IMAGE_PROTOCOL` accepts
`auto`, `halfblocks`, `kitty`, `sixel` and `iterm2`; `halfblocks` skips the
probe. Graphics protocols require measured physical cell dimensions;
unsupported terminals and headless scripts use Unicode blocks.

Embedding performs no capability query. The host supplies an
`ImageProtocol` through `AppView::set_image_protocol` or
`Surface::set_image_protocol`, including the pixel dimensions per cell;
it updates that configuration if the terminal font changes. Encoded
graphics are prepared asynchronously; unmatched or occluded content uses
the Unicode block painter so clipping and overlay composition stay intact.
Kitty image identifiers come from a bounded per-surface pool, reused for
new frames and across app reloads. Embedded hosts write
`image_protocol_cleanup()`'s returned commands when releasing the view's
terminal resources; the standalone terminal guard handles this on exit.
Hosts reserve the rendered region for the surface when using graphics
protocols. Before painting their own overlapping widgets above that
region, they select Unicode blocks with `set_image_protocol(None)`; internal
NSH overlays already make that composition decision automatically.

View transforms use inverse homographies for raster contents and hit
testing, including rotation, skew and projective transforms. Effected
subtrees apply group opacity once, all CSS blend modes, ordered color and
spatial filters, backdrop filters from earlier painted content, and
rounded/continuous descendant clips. Composition is asynchronous and
bounded: 2 million output pixels, 24 million working pixels, 32 layers,
32 cached groups / 64 MiB and 8 pending jobs per surface. Larger groups
downsample; a previous complete frame remains visible while work runs.
Output uses the selected image protocol or Unicode blocks. The portable
painter retains 32 samples per cell and selects the lowest RGB squared-error
two-color partition among half and quadrant blocks. Half blocks win ties.
Existing block masks are decoded for transparent overlays and rasterized
backdrops; they are filled rectangles rather than font-rasterized glyphs.
Each terminal cell still has only a foreground and background color, so
four differently colored quadrants cannot be reproduced exactly. Terminal glyphs,
physical resolution and colors remain controlled by the emulator.

The `unicode_images_preserve_directional_edges_and_compose_transparent_layers`
Surface regression compares a source bitmap against the actual rendered cells
and an independent half-block baseline. Setting `NSH_UNICODE_IMAGE_EVIDENCE`
to an output directory when running that test also saves all three PNGs and
their RGB squared errors. These are ideal filled-block reconstructions,
not emulator screenshots or a measurement of font/palette fidelity.

Built-in WebView provides a readable HTML presentation for inline HTML
and URI sources. HTTP(S) navigation and redirects enforce the mounted
webview grants. Headings, paragraphs, lists, preformatted text, basic
tables and numeric link references become terminal text; Tab/Enter select
and follow links, Alt+Left/Right traverse history, and reload/stop commands
work through the existing ref. Page scripts are skipped; injected script
and `postMessage` report an error because this reader has no browser JS
context. Local fragment anchors are not resolved.

Video uses optional `ffmpeg` and `ffprobe` executables from `PATH`, or
`NSH_FFMPEG` and `NSH_FFPROBE`. Pipe-based decoding provides visual
playback, pause/rate/repeat/seek and load/progress/end events; its last row
contains controls. Sources are bounded to 64 MiB, 8192 pixels per side,
16 million pixels and four hours; decoding samples at most 512×288 at
12 fps with three queued frames. Eight actual media workers per surface
remain reserved until IO stops. HTTP loads have a total 15 s deadline
across redirects, and a stalled FFmpeg pipe is killed after 15 s. An
embedding asset callback owns its own timeout. Audio output and a full
browser context can be supplied through `nsh/native` host components.

System dialogs and application/popup menus are terminal overlays. F10
opens the app menu; arrows, Enter/Space and Escape handle selection,
submenus and dismissal. Enabled/checkmarked items and shortcuts retain
their shared callbacks. Window titles become sanitized OSC 2 output in
standalone apps. Graphical window geometry, status bars and software
keyboard accessories remain host-specific presentations.

`HostServices` connects embedded clipboard, title and announcement
transports explicitly; creating a view performs no terminal IO.
`accessibility_snapshot` exposes mounted semantics, focus, frames and
actions, omitting secure values and respecting hidden/grouped children.
The host can invoke `perform_accessibility_action` and route announcements
to its assistive technology. The standalone default also shows a visual
announcement toast; it does not install an OS screen-reader bridge.

The renderer environment is a separate axis from the operating system:
`platform.os` keeps the real OS and `platform.renderer` identifies the
terminal. See [elements](elements.md) and
[JS modules](js-modules.md) for the generated environment API.

## Tooling and packages

```sh
cargo build -p nsh-cli -p nsh-tui-host
./target/debug/nsh check examples/terminal-workbench
./target/debug/nsh run examples/terminal-workbench --target tui
./target/debug/nsh build examples/terminal-workbench -o target/terminal-workbench
./target/debug/nsh-tui-host --bundle target/terminal-workbench/bundle.nshc \
  --size 120x34 --script "wait 300; expect Operations workbench; shot target/workbench-home.txt; type 王宁; expect 12 services; tap 108 1; expect Deploy service; key Ctrl+a; type 安全发布; key Tab; key Tab; key Enter; expect Deployment queued; shot target/workbench-deployed.txt; quit"
./target/debug/nsh package examples/terminal-workbench --target tui
```

Script steps: `wait <ms>`, `shot <path>`, `tap <col> <row>`,
`hover <col> <row>`, `wheel <col> <row> <dx> <dy>`, `type <text>`,
`key <name>`, `selectall`, `resize <cols> <rows>`, `dark`, `light`,
`expect <substring>`, `expect-focus`, `quit`. Separate steps with `;` or
newlines. Wheel deltas are detents. Key names include `Enter`, `Esc`,
`Space`, `PageDown`, `F1`, `Ctrl+a` and `Ctrl+Shift+Left`.

`shot` writes UTF-8 characters, preserving wide-cell spacing, and omits
color attributes. Rasterized glyphs inside effect groups become graphic
samples rather than searchable characters; assert nearby ordinary labels
and inspect interactive rendering for their visual appearance. Script
failures return a process error and are suitable for CI.

`expect` checks frame contents rather than input readiness. A background
notice can update during a modal's exit animation while the modal still
owns input. Allow the transition to finish before the next background
action; the workbench uses `expect Deployment queued; wait 300` after
confirming its fade dialog.

`nsh package --target tui` places the runner beside `nsh/bundle.nshc`,
`nsh/assets`, `nsh/app.json` and optional `nsh/capabilities.json`, archived
as `.tar.gz` on Unix and `.zip` on Windows. Rust roots are compiled into
their runner. `--run` inherits terminal streams and waits for child exit.
The distribution includes `runtime/tui/{nsh-tui-host,nsh-tui-app}` (with
`.exe` on Windows). App-specific Rust tooling generates
`.nsh/rust/tui-host`, `tui-app` and `rust-tui`; the latter builds the native
root runner with `default-features = false`. Generated Windows terminal
runners remain console applications.

## Public embedding API

`nsh-platform-tui` re-exports `ratatui`, `ratatui_image`, `crossterm`, `Appearance`,
`App`, `Bundle`, `Limits` and `Root`. Its public types and entry points:

| API | Purpose |
|---|---|
| `CellMetrics::new(Points, Points) -> Result<Self, String>`; `width()`, `height()`, `viewport(u16, u16)` | Validated point dimensions for terminal cells |
| `TerminalTextEngine::new(CellMetrics)`; `Clone`, `Default`, `TextEngine` | Point measurement and terminal text runs; clones share the font catalog |
| `AppOptions` | Trace, assets, ID/title, size, script, appearance, limits, metrics, component factories, `reduce_motion`, `data_dir` and `storage` |
| `AppSource::{Rust(Root), Bundle(Box<Bundle>), DevServer(String)}` | Standalone source (`DevServer` requires `dev`) |
| `AppView::new(AppOptions) -> Self` | Independent embeddable engine and surface |
| `AppView::load(App) -> io::Result<()>`; `connect(String)` (`dev`) | Load trusted code or start a development session |
| `AppView::poll()`, `tick(f64) -> io::Result<bool>` | Process engine commits and advance native frames |
| `AppView::handle_event(Event) -> bool`; `resize(u16, u16)` | Route local terminal input and region dimensions |
| `AppView::render(Rect, &mut Buffer)`; `snapshot() -> String` | Render the assigned area or get UTF-8 characters |
| `AppView::surface()`, `surface_mut()`, `control()`, `last_error()` | Access the scene, engine control and last error |
| `AppView::set_asset_base`, `set_appearance`, `set_theme`, `set_reduce_motion(bool)` | Update resources and visual environment |
| `AppView::set_host_services(Option<Arc<dyn HostServices>>) -> io::Result<()>` | Opt into host service callbacks on supervised workers |
| `AppView::drain_service_output() -> impl Iterator<Item = ServiceOutput>` | Retrieve output for the embedding host to transport explicitly |
| `AppView::accessibility_snapshot() -> Vec<AccessibleNode>`; `Surface::accessibility_snapshot()` | Obtain semantic nodes without terminal IO |
| `Surface::perform_accessibility_action(NodeId, &str) -> bool` | Invoke a mounted semantic action |
| `AppView::set_image_protocol(Option<ImageProtocol>)`; `Surface::set_image_protocol(Option<ImageProtocol>)` | Choose host-negotiated graphics without terminal IO |
| `AppView::image_protocol_cleanup() -> String`; `Surface::image_protocol_cleanup() -> String` | Return commands for the host to release its view's Kitty image resources |
| `ImageProtocol::new(ProtocolType, u16, u16) -> Result<Self, String>`; `with_tmux(bool)`, `protocol_type()`, `cell_size()` | Select Kitty, Sixel, iTerm2 or Unicode blocks with physical cell pixels |
| `AppView::register_component(name, factory)`; `stop()` | Register a native terminal leaf and stop the engine |
| `Surface::new(u16, u16, CellMetrics)` | Retained rendering/input layer for hosts supplying their own engine wiring |
| `Surface::apply(MountBatch)`, `tick(f64)`, `animating()`, `render(Rect, &mut Buffer)` | Mount and draw the scene |
| `Surface::render_plain(Rect, &mut Buffer)` | Draw one pass with Unicode image/canvas blocks while retaining the configured protocol for later passes |
| `Surface::metrics`, `viewport`, `resize`, `snapshot`, `focused`, `should_quit` | Geometry and interaction inspection |
| `Surface::focus_path() -> Vec<NodeId>` | Focused node followed by its mounted ancestors, or an empty path when no node has focus |
| `EngineControl::set_focus_path(Vec<NodeId>)` | Queue the native focus snapshot before input events or environment updates |
| `Surface::set_assets`, `set_access`, `set_dark`, `set_components`, `set_reduce_motion(bool)` | Engine resources, capability access and host components |
| `Surface::input_context() -> Option<InputContext>` | Snapshot editing hints and generation; secure text is omitted |
| `Surface::apply_input_edit(InputEdit) -> bool`; `type_text(&str) -> bool` | Validate host-keyboard edits or enter text with mounted capitalization policy |
| `Surface::handle_event(Event)`; `drain_events()` | Accept input and forward ordered `SurfaceEvent`s |
| `Surface::cancel_pointer()` | Cancel native pointer capture while retaining keyboard focus |
| `Surface::pointer_left()` | Clear hover and native capture when the pointer leaves the input region, preserving focus and selection |
| `Surface::handle_wheel(MouseEvent, u16) -> u16` | Apply consecutive identical wheel detents to one live hit-tested owner and report consumed detents |
| `Surface::set_host_services_enabled(bool)` | Route service requests to the embedding host without terminal IO |
| `Surface::complete_clipboard(u32, bool, Result<ClipboardContent, String>)` | Complete a host clipboard read with the current capability check |
| `Surface::complete_paste(InputEdit, Result<ClipboardContent, String>)` | Complete a paste while its focused input, selection and edit count still match |
| `SurfaceEvent::{Event, Scroll, States, AnimationsFinished, ComponentSize, Service, Zoom, RootSize, ScreenHeader}` | Ordered engine and host-service messages produced by a surface |
| `InputContext`; `InputEdit` | UTF-16 selections, edit generation, keyboard/autofill hints and checked replacements |
| `HostServices: Send + Sync + 'static` | Cancellable clipboard read/write, title and announcement callbacks |
| `ServiceCancellation::is_cancelled() -> bool`; `SystemServices` | Cancellation token and the standalone OS-service implementation |
| `ClipboardContent::{Text(String), HasText(bool)}` | Clipboard read and format-query responses |
| `ServiceRequest`; `ServiceOutput::{Title, Clipboard, Announcement}` | Explicit service requests and output payloads |
| `ServiceOutput::terminal_sequence(bool) -> String` | Encode a title or complete OSC 52 clipboard output, optionally through tmux |
| `AccessibleNode` | Mounted role, label, hint, state, value, focus, actions and frame |
| `AssetBase::{Directory(PathBuf), Http(String)}` | Resolve imported assets |
| `Components::register(name, factory)`; `NativeComponent` | Per-view factories and mounted host leaves |
| `ComponentContext`, `ComponentEvent`, `ComponentResponse` | Point/cell clipping and native event responses |
| `run_app(AppSource, AppOptions) -> io::Result<()>` | Standalone terminal lifecycle, or headless script lifecycle |
| `set_ui_sets(Vec<Registry>)`; `init_logging()` | App-specific host registration and binary logging |

Embedding hosts own event routing. Mouse events supplied to `AppView` use
cells relative to the assigned region; drawing uses the region's absolute
Ratatui rectangle. Native components receive destination cell rectangles
and must respect both their clip and the buffer bounds.

`Surface::render_plain` gives an embedding host a per-pass Unicode image
path without changing the selected protocol or clearing its encoding cache.
It neither requests protocol encodings nor consumes protocol uploads. A host
can use it when rejecting an unpublished Sixel candidate before its terminal
backend swaps buffers. The host owns whole-frame admission and retry ordering;
this method does not roll back earlier protocol state or terminal output and
cannot restore a Kitty upload already consumed by `render`.

Hosts driving a `Surface` with `nsh_engine::LocalEngine` route input through
`Surface::handle_event` or `Surface::handle_wheel` against the current mounted
scene. The surface owns native pointer capture, selection, gestures and focus.
They forward each resulting `SurfaceEvent` in order through the engine's
`EngineControl`, using `dispatch_event(NodeId, EventKind, EventPayload)` for
application events before `pump()`, then apply every produced mount batch in
order. Engine work and native input continue while terminal output completes. During idle probes,
`LocalEngine::needs_pump() -> bool` reads queued messages and due deadlines
without running app code; queued native input requires a pump.

Keep keymap focus snapshots in the same input order. After native focus changes,
take `Surface::focus_path()` and pass it to `EngineControl::set_focus_path`
before enqueueing events or environment updates that can run JS; those messages
are handled in FIFO order, including when a host drives a `LocalEngine` and
pumps it explicitly after enqueueing work. `AppView` forwards the
surface's path automatically. Empty paths clear the snapshot, so no focus
and removed scopes cannot keep a terminal binding eligible.

`Surface::handle_wheel` accepts consecutive wheel detents
with identical coordinates, direction and modifiers. It hit-tests the current
scene once and applies the accumulated scroll delta once;
a host component receives at most one detent before the host dispatches
its callbacks and delivers more input. Raw `Surface` hosts opt into service
requests explicitly with `set_host_services_enabled`; clipboard reads and
pastes are completed through the checked methods above.
Native text pastes report `onPaste` before `onChangeText`. `pasteBehavior="report"`
reports the text without changing the selection or edit count; the default
`"insert"` retains literal terminal text, including line endings. Clipboard
completions still require the original focus, selection, edit count and grant.

`TextEngine::measure_canvas(&self, &CanvasFont, &str) -> Option<Points>`
returns an optional Canvas line advance. Its default is `None`, which uses
the regular text measurement path; `Rc` forwards the call. The terminal
engine returns the shaped advance from its per-surface font catalog.

## Verification

For shared engine changes, trace a counter update headlessly and compare
mount items and timings with [performance](performance.md):

```sh
printf 'await app.press("+1");\n' | ./target/debug/nsh test examples/counter/App.tsx --trace
```

This checks the shared engine, not terminal drawing. Historical terminal
measurements are recorded in [performance](performance.md#terminal-backend).

The [operations workbench](../../examples/terminal-workbench/README.md)
adds a three-pane, searchable service fleet with an inspector, canvas
charts, an activity timeline and a deployment dialog. Run it at 120×34 for
the compact view or 160×50 cells for the full layout. The wide inspector
also includes local image/blending/font samples, a popup menu and an
inline-HTML runbook. Its README includes checked scripts for those tabs,
filtering, selection, deployment, section navigation and resizing down to
100×30.

```sh
cargo test -p nsh-platform-tui -p nsh-tui-host -p nsh-tui-app
cargo clippy -p nsh-platform-tui -p nsh-tui-host -p nsh-tui-app --all-targets -- -D warnings
cargo check -p nsh-platform-tui --no-default-features
cargo +nightly fmt --all --check
```

`.github/workflows/tui.yml` checks all three desktop OSes and exercises the
operations workbench headlessly on each OS, retaining text snapshots as CI
artifacts. Changes to focus, Unicode metrics, clipping, assets, hot reload
or lifecycle should include a focused test that crosses the affected
boundary and a script that checks the resulting app behavior.
