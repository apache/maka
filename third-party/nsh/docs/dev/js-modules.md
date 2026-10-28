# JS modules

NSH ships two layers of modules. `nsh` holds the primitives every UI is made of, the environment and the
capabilities, with `nsh/mobile` and `nsh/desktop` for what only mobile platforms or only the desktops have. `nsh/base` (the crate `nsh-base`) is the unstyled foundation every app's UI builds on: navigation stacks and
pages (and their status bar), dialogs, safe areas, the system's alert dialog and the software keyboard. NSH provides no styled
components: the look of an app is the app's, drawn from the primitives, or from Rust components in the app's own crate,
whose UI set is a module of its own (`app/native`; `docs/dev/components.md`, `tooling.md`). Each export has one home.
A UI set may serve a family of exports whose names only make sense together as a module under a path of its own
specifier, as `gpui-base`'s `plot` is a module of its crate: a submodule of the set (`Registry::submodule`, such as
`nsh/base/<family>` of `nsh/base`), served, described and declared wherever the set is (`Registry::sets`: the hosts'
module tables, the core's components, the toolchain's descriptions, one declaration file per module), so a list of UI
sets names only the set.

Every module is native: `nsh-js` serves it (`modules.rs`: NSH's own modules by `nsh_core::js::NATIVE_MODULES`, then the
registries: the runtime's `nsh_core::runtime::registries()` and the UI sets a host serves, `nsh/base` and the app's), and the bundler keeps
imports of them as imports (`plugin.rs`; how apps are compiled: `native-pipeline.md`). A module can be both: the
hand-written exports of `nsh` and `nsh/mobile` are joined by their registry's (`nsh-js` keeps the hand-written tables as internal sources the two serve, `NSH_SOURCES` and `MOBILE_SOURCES`, `NativeModule::moved_to`, declared in the module's own file). There is no JS file of
NSH's and no internal module apps could reach.

Declarations: each export of a module of NSH's own carries its TypeScript declaration in its table (`modules::Item`:
`signal`'s signatures next to `reactive::signal`), each module its own interfaces (`types`); a registry's components
and modules are declared from their specs (`nsh_core::element::declarations`, `docs/dev/components.md`), the styles, the
host elements' props and events, the easings and the canvas methods from the core's tables. `nsh-js`'s
`declarations.rs` assembles one file per module (`nsh/index.d.ts`, `nsh/base.d.ts`, `nsh/mobile.d.ts`), `nsh/types.d.ts` (the
element and JSX types `nsh` exports), `nsh/jsx-runtime.d.ts` and `nsh/globals.d.ts`, and tests check every module's
exports against its declarations; the CLI writes them into `.nsh/types` (`tooling.md`).
`nsh` has the reactive API, `mount`, the primitives every UI is made of (`View`, `Text`, `Scroll`,
`Input`, `Image`, `List`, `Canvas` and its classes, `WebView`, `Video`), the environment, animation, gestures, the
clipboard, the picker, storage, the host channel, keyboard shortcuts, what the embedding app registers, and the types.
TSX imports mirror the Rust crates' layers: the primitives from `nsh`, as Rust takes them from
`nsh_core::prelude`, the base components from `nsh/base` (`nsh-base`). The primitives' code is kept by area in
internal sources `nsh` serves (`NativeModule::also` / `moved_to`: `List` in `list.rs`, `Canvas` and its classes in
`canvas.rs`, `Image` in `modules.rs`, `WebView` and `Video` in `platform_modules.rs`); they are no modules apps
import, and their declarations and types go into `nsh`'s own file. Apps import a primitive's tag from `nsh`
(`native-pipeline.md`): the table below. `If` and `Each` are globals.

| Module | Exports | Implemented in (`crates/nsh-js/src`) |
|---|---|---|
| `nsh` | `signal`, `computed`, `effect`, `batch`, `untracked`, `cleanup`, `context`, `split`, `mount`, `inputAction` (a callback over deeply frozen captured JSON arguments), `ErrorBoundary` (`dom.rs`: a memo of the children or the fallback, `native-pipeline.md`), `resource` (`resource.rs`: a callable object over four signals, its loads kept by `nsh_core::resource::Runs`); `View`, `Text`, `Scroll` (host elements as components: `dom::host_component`); `View`'s `selectable` (texts that select together); padding and margin take `env()` (safe area, keyboard: `styles.md` "Environment variables"); `Keyboard.dismiss()` (a Rust module of `nsh-core`, `element/keyboard.rs`), `safeArea()`, `safeAreaInsets()`, `keyboardFrame()` (the environment's accessors, `env.rs`, re-exported by the same registry); `List` (`list.rs`), `Canvas`, `Path2D`, `CanvasRenderingContext2D`, `CanvasGradient` (`canvas.rs`), `Image`: the image element's component, with `Image.getSize`, `Image.prefetch` (promises the core resolves from the root's `ImageInfo` event; the `nsh` registry's functions, `components.rs`), `WebView`, `Video` (`platform_modules.rs`); `YNode`, `Accessor`, `Signal`, `Context`, `Component`, the types of styles, element props, events and `JSX`; Animation: `createAnimatedValue`, `AnimatedValue`, `AnimatedNode`, `Animated`, `Easing`, `LayoutAnimation` (`animated.rs`); The environment: `windowSize()`, `colorScheme()`, `fontScale()`, `pixelRatio()`, `locale()` (accessors), `setColorScheme`, `platform` (a constant: `os`, `version`, `idiom`, `catalyst`, `renderer`, `isTerminal`, `select`); `openUrl(url)` (Rust, `nsh_core::runtime`'s `device.rs`: a promise of whether the URL opened outside the app, `nsh_core::open_url`; `sandbox.md`, `embedding.md` "The host channel") (`env.rs` + its registry); Accessibility: `screenReaderEnabled()`, `reduceMotion()` (accessors), `announce(message)`, `setAccessibilityFocus(node)` (`env.rs` + its registry (`nsh_core::runtime`)); Gestures: `PanResponder` (`touch.rs`); The clipboard: `Clipboard.writeText(text)`, `Clipboard.readText()` / `hasText()`, `writeImage(src)`, `readImage()` / `hasImage()`, `readFiles()` (promises the core resolves from the root's `Clipboard` event; the `has*` reads do not read the content, so iOS shows no paste notice). Images cross as base64 `data:` URIs (an image source and a `fetch` URL, so bytes stay native until JS asks for them), files as `file:` URLs one per line; the backends build both with `nsh_core::platform::clipboard`. UIPasteboard, ClipboardManager (text only), NSPasteboard, GDK, Win32, `navigator.clipboard`; the `clipboard` capability (its registry (`nsh_core::runtime`)); The photo picker: `Picker.pickImages({ multiple, limit, maxDimension, quality, format })`: the system's picker for photos, resolving with `PickedImage`s (`{ file: File, size }`; `[]` when cancelled). A Rust `#[module]` over `nsh_core::picker`: the core sends the root `Command::PickImages` with a checked `PickRequest` (or asks the embedder's `PickerBackend`, `Core::set_picker` / `EngineConfig::picker`), the platform answers with the root's `Pick` event, whose `EventPayload::Picked` carries the files' bytes, and the result becomes `File`s natively (`JsHost::new_file`: a `Blob` over the same `ImageData`, no copy and no base64). The `picker` capability (its registry (`nsh_core::runtime`)); Storage: `Storage.getItem` / `setItem` / `removeItem` / `keys` / `clear` (async functions of the core; the entries live in memory in `nsh_core::storage`, loaded once from the platform's `StorageBackend` (`EngineConfig::storage`: `nsh_engine::FileStorage::open` in `<EngineConfig::data_dir>/<app id>` (the id travels with the app: `app.json`, the dev server, packages, `Root::app_id`), one per file in the process so a reload reads unflushed writes; a damaged file is set aside as `storage.json.corrupt`, an unreadable one leaves the changes in memory, never replacing it; `localStorage` under `nsh:<app id>:` on the web) and every change handed to it; 5 MB quota; no capability: the app's own data, kept where the host says) (its registry (`nsh_core::runtime`)); The host channel: `host.call(name, args, { timeout })` (a task of the core (`runtime/host.rs`), racing the answer against the app's clock: 30 s unless `timeout` says, 0 none; a call that timed out drops its slot at once (`Action::ForgetHostCalls`), so `Core::answer_host` drops a late reply with a debug line; the root's `Command::HostCall { id, name, args }`, answered by the root's `Host` event, `EventPayload::Json` `{ type: "reply", id, ok, value?, error? }` (an id that is not a whole number answers no call); it rejects at once when the environment has no `host`, with `invalid function name` when the name is not 1 to 128 of `[A-Za-z0-9_.:-]` without `..` (`access::valid_host_name`, checked before the grants), and with the `host` capability's message when the name is not granted; a timeout too large for the clock waits without limit, a negative or non-finite one rejects), `host.available()` (the platform environment or configured native SDK channel), `host.on(event, listener)` → `{ remove() }` (JS listeners of the root's `Host` events of `{ type: "event", event, payload }`, the core keeping the replies; a listener that throws leaves the next ones called, the first error thrown after them; events need no capability) (`platform_modules.rs`, `host_channel.rs` + its registry (`nsh_core::runtime`); SDK channel adds `params`, `post` and a callable subscription with `remove()`); Keyboard shortcuts: `keymap.bind(keystroke, handler, { when, repeat, within, fallback })` / `keymap.bind({ keystroke: handler })`: keyboard shortcuts. Keystrokes are parsed and checked in Rust (`nsh_core::keymap`: syntax, `mod`, reserved keystrokes, which ones text inputs keep); the whole table goes to the platform as the root's `Prop::Keymap` → `MountItem::Keymap`, which matches keys on the spot and reports the root's `KeyCommand` event (the binding's id). Bindings made under an owner go with it; a module's top-level ones are undone when hot module replacement runs it again (`hot::undo_on_rerun`) (`keymap.rs`); What the embedding app registers: `nativeComponent(name, { props, events })`: a component for a native component the embedding app registered; `nativeModule(specifier)`: the exports of a UI set the embedding app gave its engines (`EngineConfig::ui_sets`), as one object made by the loader's code (`modules::host_module`, the same values an import of the set gets) and kept per specifier; only the host's sets, never nsh's own modules or the runtime's registries (`platform_modules.rs`, `modules.rs`) | `reactive.rs`, `dom.rs`, `modules.rs`, `env.rs`, `animated.rs`, `touch.rs`, `keymap.rs`, `platform_modules.rs`, `host_channel.rs` + its registry (`nsh_core::runtime`) |
| `nsh:rt` | what compiled JSX calls (`element`, `insert`, `spread`, `cond`, `each`, `list`, `font`, ...); apps never import it | `dom.rs`, `list.rs` |
| (globals) | `If`, `Each` (control flow; their tags compile to `cond` / `each`) | `dom.rs` |
| `nsh/mobile` | What iOS and Android have: `isAvailable` (`true` on iOS and Android), `InputAccessoryView` (iOS; nothing on Android), `BackHandler` (`onBackPress` native: it returns the function that removes the listener, which goes with the owner it was added under, as `keymap.bind`'s bindings do; `exitApp` Rust; Android; nothing on iOS), `TabBar` (a Rust component of the runtime, `nsh_core::mobile`; its root is the native component `nsh/tab-bar` (`nsh_core::platform::TAB_BAR_COMPONENT`), which the iOS (`UITabBar`, `system_tab_bar.rs`) and Android (Material 3's navigation bar, `TabBarComponent.java`) backends register themselves; `items` (`{ title, icon }`), `selectedIndex`, `onChange(index)`; a hidden view elsewhere). The engine gives the core the runtime registries' components with the UI sets' (`Registry::merged`) | `platform_modules.rs` + its registry |

`keymap.focusedWithin(node)` reads the native focus snapshot without subscribing. `within` needs native focus scopes; `fallback` runs after native editing, selection and navigation leave a key unhandled. Terminal and GPUI hosts supply these capabilities. `Registry::value` supplies lazy host-owned values; imports and `nativeModule` share their canonical instances per VM, rejecting duplicate authority before constructing values.
| `nsh/desktop` | `isAvailable`, `titleBar()` (the environment's `title_bar`), `Menu.setApplicationMenu` / `Menu.popup` (decoded natively into `nsh_core::desktop::MenuItem`s, the items' functions kept by id, called on the root's `onMenu`), `Window` (Rust: `setTitle`, `setTitleBar`, `minimize`, `toggleMaximize`, `toggleFullScreen`, `setFrame`, `setLevel`, `orderFront`, `close`); all of it is `Command::Desktop` on the root, which mobile platforms ignore | `desktop.rs` + its registry |
| `nsh/base` | The unstyled foundation of an app's UI. Navigation: `NavStack`, `NavPage`, `createNavStack`, `Dialog` (natives of `nsh-js`, `Registry::native_values`). Text input: `Input` (a host element made by `nsh-js`, `env::ELEMENTS`, `Registry::native_values`; its props' types `InputProps` and `IOSInputProps` declared beside it). Alerts: `AlertDialog.show({ title, description, actions, presentation })` (a promise of the chosen action's `id`, its `label` without one, `null` when closed without one; `presentation: "actionSheet"` is a list dialog on Android), the platform's own. A press target: `Button` (Rust; no look of its own). A checked / unchecked / indeterminate control: `Checkbox` (Rust; its indicator is a part the app styles and fills with its mark, the `indicator` slot, `checked:` / `indeterminate:` / `disabled:` following the checkbox through `Interactive::project_checked` / `project_indeterminate`). A set of options the user picks one of: `Radio` in a `RadioGroup` (Rust; the group holds no value, each radio its `checked`, the app's indicator its children with `group-checked:` classes). An on / off control: `Switch` (Rust; its track and thumb are parts the app styles, `checked:` / `disabled:` following the switch through `Interactive::project_checked`). The tabs of a tab list: `Tab` in `Tabs` (Rust; the list holds no value, each tab its `selected` and `onPress`, the app shows the selected section's content). A region that expands and collapses: `Collapsible` (Rust; its children always, its `content` slot after them while `open`, kept while collapsed; the trigger and its `expanded` state are the app's). How far a task is: `Progress` (Rust; the progress bar role with the range 0 to 100 and its value, `Accessible::accessibility_value`, none while `indeterminate`; its track and indicator are parts the app styles, the indicator `value` percent of the track's width). A value or a range picked along a track: `Slider` (Rust; `value` a number or `[start, end]`, controlled or from `defaultValue`, snapped to `step` from `min`, on a `linear` or `logarithmic` `scale`, along a horizontal or vertical `axis`; `onChange` per new value, `onChangeEnd` once per change; each thumb an adjustable element with its value, Tab stop, WAI-ARIA's slider keys and the screen readers' increment / decrement; its track, indicator, range and thumbs are parts the app styles). Documents: `TextView` (Rust; Markdown, HTML or blocks, `docs/dev/text-view.md`). Code: `Editor` (Rust; a code editor, its text controlled, `docs/dev/editor.md`), `DiffView` (Rust; the changes between two texts or of a patch, `docs/dev/diff.md`). The status bar: `statusBar` of `NavPage` and `Dialog` (a host prop of screens and modals; `StatusBar`, `StatusBarForeground` declared with the navigation) over `nsh.json`'s `"statusBar"` | `nsh_base::registry()` (`crates/nsh-base`); `navigation.rs` |
| `nsh/base/plot` | The parts charts are built from, as `gpui-base`'s `plot`, with no look of their own: `Plot` (Rust; the rows of data `data: T[]`, generic over `T` so `x` / `y` are checked keys of it or functions of a row (`RowAccessor`), the `point` / `linear` / `band` scales of its axes, its size as their range, `onHoverChange(index)` for the row nearest the pointer, the hover's parts `crossLineClass` / `dotClass` / `tooltipContent` (placed by `tooltipPlacement` / `tooltipOffset`, kept inside the plot on the animator) and `motion` (appear, enter, exit, pointer) on the platform's animator, `interactive`, one element for screen readers with `accessibilityValue`) and its marks `Line`, `Area`, `Bar`, `Grid` (Rust; a canvas each, drawn natively from the rows, painting with the paint properties `fill` / `stroke` / `strokeWidth` / `strokeDasharray` they inherit, `currentColor` where none is set: `Painter::*_from_view`, `canvas.md`; `Line`'s `dot` part; a mark's own `data` / `x` and `hoverDot` part; `Area`'s and `Bar`'s `background` part, a CSS gradient inside its shapes: `Painter::fill_background_from_view`; `Bar`'s stacks and side-by-side groups, its growth with the appear and its fading away from the hover's row as animated canvas numbers, its `label` part read with `RowText`), and the radial marks `Pie` (a canvas per slice, the `slice` part, its classes `sliceClass` a string or a function of the slice's row; the plot's hover finds the slice under the pointer through the marks' hit tests, the slice lifting and the others fading on the animator) and `Arc` (one sector between two angles) | `nsh_base::plot::registry()`, a submodule of `nsh/base` (`crates/nsh-base/src/plot`) |
| an app's UI set (`app/native`) | The Rust components, modules and classes of the app's crate (`#[native_module("app/native")]`) | the registry (`components.rs`, `classes.rs`) |

`nsh:hot` (hot module replacement, `hot.rs`) is only imported by development bundles. The same loader also compiles
the chunks of a split bundle (`Screen.js`: a name that is no native module, with code the host gave; `chunks.rs`,
`native-pipeline.md`), which `import()` loads through the global `__nsh_import`.

`importModule<T>(id, dependencies?)`, exported by `nsh`, uses that same loader for modules whose ids the
embedding app discovers at runtime. Names are flat `.js` file names. Each id evaluates once in the current VM;
its exports, native modules and policy are shared with the app. Changed code uses a new id. Removing its
components disposes their reactive owners; it does not unload an evaluated ES module from QuickJS's cache.

Native hosts can provide `EngineConfig::chunk_loader` (`ChunkLoader::load` returns a `ChunkLoad` future of
`ChunkSource`, containing `code` and an optional `asset_base`). Each module receives its directory in
`import.meta.assetBase`. The bundler's image and font virtual modules use the internal `nsh:rt.assetUrl` helper
to resolve imported paths against that directory, encoding path segments; an ordinary bundle keeps its root
`asset:/` names. The asset base stays outside the package source, so content-addressed packages have no
self-referential digest. Imported files are represented by `nsh_bundler::Asset { path, source }`:
`path` is their packaged logical name and `source` is the actual build input. A resource family is stored at
`imports/<sha256>/<filename>`; the digest covers sorted, length-delimited filenames and full contents, including
all bitmap density variants. Imports outside the entry directory and checkout relocation therefore use the
same rule, without leaking source paths. Packagers copy `source` to `path`; development servers replace their
named asset set after each successful rebuild and watch every source, including density siblings.
The shared engine schedules reads on its configured runtime and delivers completion through the existing chunk
messages, waking `LocalEngine` as necessary. Dropping the engine cancels its pending loader futures. With no configured
loader, `MountSink::load_chunk` retains responsibility for fetching split-bundle chunks. Bundled chunks are
already available and use neither path.

- **Terminal menus** use `nsh/desktop`: `isAvailable` is true, `Menu` controls terminal menus and `Window.setTitle`
  updates the host's title. `platform.idiom === "desktop" && !platform.isTerminal` still describes graphical desktop interaction; terminal apps use
  `platform.isTerminal` to choose terminal behavior. Window placement and desktop chrome stay with the host.
- **Platform modules** are importable on both platforms (one bundle runs on both); on the other one their calls do
  nothing and their components render nothing. `isAvailable` tells which.
- **Platform-only props** are grouped: `ios={{…}}` / `android={{…}}` / `web={{…}}` / `desktop={{…}}` (macOS, Windows, Linux, and browsers in the desktop idiom) on
  elements and components (`IOSProps` / `AndroidProps` / `DesktopProps` in `types.d.ts`, extended per element; the host
  props in them are the generated `IOS…HostProps` / `Android…HostProps`). The renderer
  (`platform_props` in `dom.rs`) sends only the current platform's object, each key as a prop of its own (keys removed
  from the object are cleared); the core knows them by those names. Android: `ripple`, `elevation`,
  `accessibilityLiveRegion`, Dialog `statusBarTranslucent`. iOS: `backdropMaterial` (the system material of a
  backdrop blur), input `inputAccessoryViewID` / `textContentType` / `keyboardAppearance`, Dialog
  `supportedOrientations`, WebView `allowsBackForwardNavigationGestures`. Desktop:
  `windowDrag`, WebView `allowsBackForwardNavigationGestures` (macOS' trackpad swipes, Windows' touchscreen swipes; a
  prop of several platforms names each: `#[prop(ios = "x", desktop = "x")]`). What two platforms do is a top-level prop, ignored where it does not apply (`presentation`,
  `headerLargeTitle`, `headerBackTitle`, AlertDialog's `closeOnEscape` / `closeOnBackdropPress`; `api-naming.md`).
- A module's exports are made when a bundle first imports it or looks it up with `nativeModule`; what must always happen (the root's direction, the
  themes) is the renderer's (`dom.rs`, `setup`), not a module's.

## Host-owned values

An embedding host can add `Registry::value(name, factory)` to a registry it supplies through
`EngineConfig::ui_sets` (or directly through `HostOptions::ui_sets`). The factory is a `Send + Sync` closure;
it runs on the VM's thread on the first import or `nativeModule` lookup of the module. Both access paths
share that VM's value, including when they are used in either order; a new VM or a reload constructs a new one.
Compiling bytecode, generating declarations and enumerating
exports never execute factories. The returned `Ret` value uses the same typed conversions as Rust methods;
the classes it names and `export declare const` are generated with the registry's other declarations.

Factories can capture a scoped native client and return `Instance::new(ClientHandle { ... })`. A class
without a constructor exposes only the operations of that existing client. The embedding host owns the
client's authority, cancellation and external resource cleanup; disposing a JS object or stopping the VM
releases its local handles, while completion of an admitted operation belongs to the external service.
Factory panics and conversion failures reject module evaluation. Conflicting host export names fail
instead of selecting one registry's value.

## Captured input actions

`inputAction<A>(handler: (args: A) => unknown, args: A): () => void` captures explicit JSON-compatible
arguments and returns a callable that passes only that snapshot to `handler`; incoming event arguments and
the handler's return value are ignored. Use `null` or `[]` for an action with no arguments. Capture reads
getters and Proxy traps, copies the normalized JSON and freezes every captured object and array. The native
JSON bounds apply: 64 levels, 1,048,576 entries and 8 MiB of canonical UTF-8 JSON.

Choose the action and its target from captured arguments. Applications and host services may check current
business state to reject stale work while keeping the captured target and arguments unchanged. Event handlers
follow ordinary native input dispatch against the current UI. Argument capture does not prove which rendered
frame the user saw or grant service authority.

## Native keymap focus

`KeyBindingOptions.within?: YNode` is an additional native eligibility condition. A supporting backend tries bindings
newest first and skips a scope unless the focused node or one of its mounted ancestors is its `within` node;
older eligible bindings and ordinary native input keep their normal precedence. `within` must be a real node
of that VM. Supplying it without native focus-scope support throws `TypeError`.

`keymap.focusedWithin(node: YNode): boolean` reads the same native focus path from the latest snapshot the host
has supplied. It returns `false` for an empty path or a node outside it, including a removed node. This read
does not subscribe an effect to focus or cause an effect to run. An effect triggered by `windowSize()` can read
the current snapshot during its resize work. Calling the method without host support throws `TypeError`.

`Environment.native_focus_scopes` declares backend support before the first render; the terminal also
retains its existing implicit support. This capability is not a reactive JS environment part.
The host supplies focus before delivering input or environment changes that can enter JS. `AppView` maintains
this ordering; hosts wiring their own `Surface` and engine use the
[focus-path embedding APIs](tui.md#public-embedding-api).

## Component scope and project goals

NSH targets native views and interaction with app-owned visual design. Common controls have one cross-platform
home in `nsh/base`: `Switch` owns behavior, state, focus and accessibility while the app styles its track, thumb and
states. A system-styled version of an existing control does not justify a second platform-specific public component.
Improve the shared component's behavior and customization surface instead.

Platform modules expose capabilities with platform-specific semantics. `nsh/mobile`'s `TabBar` is a mobile navigation
capability; `nsh/base`'s `Tabs` switches tabbed content across platforms. Its presence does not establish a parallel
catalog of system-styled form controls. Existing system-managed presentations (navigation headers and alerts) keep
their documented behavior. An embedding app can register a particular native control when its product requires one.

For additions, classify the capability by role, keep shared state and event contracts coherent across targets,
and verify input, accessibility, measurement and app styling on affected platforms. The public
[Goals and design principles](../../website/docs/goals.md) describes this boundary for app developers.
The discussion in [PR #438](https://github.com/longbridge/nsh/pull/438#issuecomment-6380656764) records the rationale.

## Where new things go

Names follow `gpui-base`'s, translated to TSX: before naming anything apps use, read `api-naming.md` (the conventions
and the renames decided so far).

- A primitive, the environment or a capability: `nsh` (or `nsh/mobile` / `nsh/desktop` when only mobile platforms or only the desktops have it), natives in `crates/nsh-js`
  listed in `modules.rs` and `nsh_core::js::NATIVE_MODULES`, each export with its declaration (`Ts`) and the
  module's interfaces in its `types`. Functions that only ask the platform (a command, a request answered by an event)
  are a Rust `#[module]` in `crates/nsh-core/src/runtime/`, registered in `runtime::registries()` under the module's
  specifier: their JS face and declarations come from the spec, with nothing written per function.
- An unstyled base component (`nsh-base` is NSH's `gpui-base`, `architecture.md` "Layers"): behavior, state, focus,
  keyboard or accessibility a UI needs, or system UI (insets, the keyboard's avoidance, the status bar's setting, a
  dialog; controls such as a toggle, a slider or a popover as their behavior is written): a Rust component or
  `#[module]` in `crates/nsh-base`, registered by one of `nsh_base::parts` (`core`, or a part of its own for a large
  component), which `nsh_base::registry()` puts together (`docs/dev/components.md`). It never styles
  (no colors, paddings, radii, fonts or variants of its own), takes the app's styles, exposes its parts and reports
  changes of state the app owns.
- A styled widget (a button with a look, a card, a list row): never in NSH, which has no `gpui-component`. Apps
  draw their own on `nsh/base` and the primitives, or ship them, as a third party does, as Rust components in a
  crate of their own (`docs/dev/components.md`).
- Something only mobile platforms have (iOS, Android or both): `nsh/mobile`; only the desktops: `nsh/desktop`; or a prop in `ios={{…}}` / `android={{…}}` /
  `desktop={{…}}`.
- Never a React Native compatibility wrapper. Something released that moves keeps its old name and module as a
  deprecated alias (`compatibility.md`); something unreleased simply moves.

## Standard modules

The standard catalog is eleven bare specifiers, `nsh_core::js::STANDARD_MODULES`, shared by the bundler (which
keeps their imports) and the loader: `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`,
`process`, `url`, `websocket` and `zlib`. Only these names import: `node:buffer` and the Node modules outside the
catalog (`fs`, `events`, `assert`, `util`, `string_decoder`, `child_process`, ...) are refused (tests:
`nsh-js` `tests/standard/imports.rs`, which also checks that each module's runtime exports are its declared ones).
The loader asks the module table first (typed registries own their names), then `standard::load`. `zlib` and
`crypto` (with its globals, `nsh_core::js::CRYPTO_GLOBALS`) are features of `nsh-js` of those names, on by default
and with `nsh-engine`'s `js` (which every native platform enables); a runtime built without them (`nsh-engine`'s
`js-core`, the web runtime's `std-zlib` / `std-crypto` off) refuses to load them, and their code is not in its binary.

| Module | Where | Exports |
|---|---|---|
| `os` | `nsh_core::runtime::os` (`#[module(flat, default)]`) | `platform()`, `arch()`, `homedir()`, `EOL`, default |
| `fs/promises` | `nsh_core::runtime::fs` | `readFile`, `writeFile`, `readdir`, `exists`, `unlink`, `rmdir`, `mkdir`, `stat`, `lstat`, `rename`, `readlink`, default; `Stats` and `Dirent` are `#[class(interface)]` (declared, no value) |
| `process` | `nsh_core::runtime::process`, `nsh-js` `standard/process.rs` | `run`, `spawn`, `exit`, `platform`, `arch`, `nextTick`, `ChildProcess`, default (also `env` / `dataDir` getters); the default object is the global `process` |
| `net` | `nsh_core::runtime::net` | `connect`, `Socket`, default |
| `console` | `nsh-js` `standard/console.rs` | default: the VM's `console` (`log`, `info`, `debug`, `warn`, `error`) |
| `websocket` | `nsh_core::runtime::websocket`, `nsh-js` `standard/websocket.rs` (the global) | `WebSocket` (`connect`), `WebSocketConnection`; the global `WebSocket` constructor |
| `buffer`, `crypto`, `path`, `url`, `zlib` | LLRT, vendored by `quickjs-jit-stdlib` (`standard/mod.rs`) | their LLRT exports, projected by `standard/declarations.rs`; `Buffer` and `crypto` are globals |

`process.platform`, `process.arch`, `os.platform()` and `os.arch()` are Rust's `std::env::consts` values, as
gpui-shell's are: `"macos"`, `"windows"`, `"linux"`, `"ios"`, `"android"`; `"aarch64"`, `"x86_64"` (not Node's
`darwin` / `win32` / `arm64` / `x64`); in WebAssembly they are empty strings, and `platform.os` (`nsh`'s environment) is
`"web"`.

The typed modules' JS face and `.nsh/types` come from their specs (`#[module]`, `#[class]`; `docs/dev/rust-classes.md`):
grants and limits throw in the call (`Later`, `JsError`: a `TypeError` or `RangeError`), I/O failures reject, and
the work runs as core tasks on the engine's tokio runtime (`fs/promises` on its blocking threads). A call's
`System` carries the VM's `Access`, data directory, `TrustedPaths`, `Quotas` and per-VM state (`Locals`:
`process`'s children, killed at once and joined together when the VM goes). `process.spawn` returns its
`ChildProcess` in the call; a core task posts the child's output to the `Callback`s `on(..)` keeps; `nsh-js`
adds what needs the VM: the global `process` (the module's default object, one per VM) and `nextTick`, a JS job.
`websocket`'s URL, options, grant (`Access::allows_websocket`) and limits are checked in the call, the handshake
uses the configured `WebSocketTransport` (browser WebSocket on web, the native transport elsewhere). On native hosts a task spawned per connection drives the socket (answering pings, keeping up to eight unread
messages); connections count under the VM's `Quotas` kind `runtime::WEBSOCKETS`, which the global `WebSocket`
(`nsh-js` `standard/websocket.rs`, made on first use) shares. `os.homedir()` and `process.dataDir` are metadata
and grant no file access. On WebAssembly, `os.homedir()` returns a typed error and `process.env` an empty object;
both avoid `std::env`, whose accessors panic on `wasm32-unknown-unknown`.

QuickJS and the LLRT modules come through `quickjs-jit` and `quickjs-jit-stdlib` on native and WebAssembly targets. The WebAssembly build uses the interpreter and pregenerated bindings; the portable standard-library implementation supplies `buffer`, `crypto`, `path`, `url`, `zlib` and `zlib-zstd`, including synchronous hashing and compression. Browser entropy reaches Rust through the player's `crypto.getRandomValues` import (`standard/random.rs`); wasm builds select getrandom's custom backend. All eleven catalog modules load on both targets, with `Buffer` and `crypto` globals. On WebAssembly, `path` uses POSIX separators and a virtual `/` working directory. The crates are
published together at one version and pinned exactly (`=0.14.1`), with no git dependency or patch. `standard/declarations.rs` projects their actual exports from checksummed upstream assets in
`crates/nsh-js/third_party/llrt-types`. `zlib` bounds each decompression (64 MiB, or the heap limit when smaller). NSH's WHATWG constructors (URL, Blob, streams, events)
keep their identity. `console` declares the global `console`'s type next to its implementation. The
declared interfaces define the API: Node-shaped subsets compatible with gpui-shell's, not Node.js itself; where
they differ (a symlink `exists`, listeners get the payload only, `Stats`' methods are on its prototype, the child
environment and `cwd` rules), `website/modules/standard-modules.md` says so.

On web, `System` receives a `BrowserFileSystem` and `BrowserWebSocket` from the player. `fs/promises` checks capabilities and quotas in Rust, then sends app-relative operations to the browser's persistent OPFS namespace. Browser WebSocket I/O crosses the transport bridge while Rust retains grants, size/count bounds and deadlines; custom handshake headers are rejected explicitly. `process.run` / `spawn` and raw TCP remain callable exports that report typed platform errors in a browser. `process.env` stays empty there.
