# Repository reference

Reference for contributors; read the relevant section before changing its area.
Paths and shell commands below are relative to the repository root.
This page is loaded on demand, not imported as an agent instruction file.

## Layout

```
crates/
  nsh-core/            Platform-independent core: typed units and geometry (`geometry/`, as GPUI's), shadow tree, styles (CSS semantics, React Native's defaults for what nothing sets), Taffy layout (flex + grid + block, on the core's own layout tree: `core/layout_tree.rs`), text merging, list virtualization,
                       mount items; CSS values (`css.rs`: colors, lengths, shadows, gradients, filters), effects (`effects.rs`), Tailwind (`tailwind/`);
                       shaders (`shader.rs`: apps' WGSL `shade(uv)` checked with naga, uniforms packed, GLSL ES for the web);
                       CSS environment variables in padding and margin (`env(safe-area-inset-*)`, `env(keyboard-inset-height)`: `Core::sync_env`);
                       what iOS and Android share (`mobile.rs`: `nsh/mobile`'s `TabBar`, a native component the two backends register);
                       the reactive graph both sides run on (`reactive.rs`, Solid's algorithm, generic over the host), the loads of
                       resources both faces share (`resource.rs`); opening URLs outside the app (`open_url.rs`: the check, the flow); the selection across the texts of a selectable view (`selection.rs`, the platforms run it);
                       overlays (`overlay.rs`: anchors and their placement; `core/overlay.rs`: shown in the root view, outside presses,
                       Escape / back; docs/dev/elements.md "Overlays"); the native animation graph (`animation/`: value / interpolate /
                       math nodes, timing / spring / decay drivers; the platforms evaluate it every frame; `Animator`: its
                       bindings to views, gestures and scroll views); what the desktop backends share, free of any toolkit:
                       pointer decisions (`input.rs`: what a pointer may start, presses, hover, hit areas, wheel latching),
                       navigation decisions (`navigation.rs`: stacks' screens, transitions' timing and motion, what going back
                       acts on), one view's transitions, layout animations and keyframes (`transition.rs`: curves,
                       interpolation, timing), scroll views' state and physics (`scroll.rs`);
                       Rust components that run once (`element/`: signals, elements, bindings, typed styles, design tokens;
                       `core/components.rs`, `core/views.rs`), classes TS uses with `new` (`element/class.rs`), JS's calls into
                       Rust and what comes back, typed (`element/call.rs`: ops carrying closures, the event stream, posts); UI sets as data for the
                       toolchain (`element/description.rs`: exports, declarations, files; JSON for apps' describe programs); the runtime's Rust
                       modules (`runtime/`: `nsh`'s `Keyboard` and `Image` functions, `nsh/mobile`'s BackHandler, ...; their JS face is made from their specs),
                       the standard modules among them (`runtime/fs.rs`: `fs/promises`, `runtime/process.rs`, `runtime/net.rs`,
                       `runtime/websocket.rs`, `runtime/os.rs`) on the `System` their calls get (capabilities, data directory, quotas, per-VM state)
  nsh-base/            `nsh/base`, NSH's `gpui-base`: unstyled base components (behavior, state, focus, accessibility; the look is the
                       app's): navigation (`NavStack`, `NavPage`), `Dialog`, `AlertDialog`, `Button`, `Link`, `Checkbox`, `Radio` / `RadioGroup`, `Switch`, `Tab` / `Tabs`, `Carousel` and its parts (slides on a native scroll view snapping to the slides' laid-out starts, previous / next, a pagination with a followed indicator, keys, a seamless loop of runways and translations the animation graph computes from the scroll offset: `carousel.rs`), `Avatar` / `AvatarGroup` (`avatar.rs`: a picture with its image status tracked natively and a row that places its first `limit`), `Toggle` / `ToggleGroup` (a toggle button and a toolbar of them: `toggle.rs`), `Toolbar` / `ToolbarGroup` / `ToolbarSeparator` (a bar of buttons, toggles and links: `toolbar.rs`; `roving.rs` the roving focus `Tabs`, `RadioGroup`, `ToggleGroup` and `Toolbar` share, its items in tree order through the core's `watch_order`), `Select` and `Combobox` (`select.rs`, `combobox.rs` on `listbox.rs`, the list's state machine they share), `Calendar` (`calendar.rs`: views, disabled dates, the days' keys), `TimeField` (`time_field.rs`: segments over one native text field), `DatePicker` (`date_picker.rs`: a calendar and time field in a popup; `popup.rs`'s `dropdown` is the popup `Select`, `Combobox` and `DatePicker` share), `Collapsible`, `Accordion` and its parts (`accordion.rs`: items open by the app's `value`, one at a time or several, panels revealed as `Collapsible`'s), `Progress`, `Terminal` (a program's output and the keys sent back: `term/`, its emulator on `vte`, `TerminalEmulator` the app's replacement), `Command` (a command palette: a search field over commands filtered natively, virtualized: `command.rs`), `EmojiPicker` (a search field over every emoji in groups, a virtualized grid with 2D keys, the app's recent emoji, names and skin tone: `emoji_picker/`, its data `emoji.tsv` made by `cargo xtask emoji-data` from emojibase-data), `Tree` (items that hold items, virtualized, one Tab stop: `tree.rs`), `Slider` (a value or a range along a track: `slider.rs`, numbers' rules in `numeric.rs`, a focused control's keys in `keys.rs`), `Scrollbar` (a bar of the app's own over a scroll view or list it names: `scrollbar.rs`, on the core's `watch_scroll`), `NumberInput` (a number typed or stepped: `number_input.rs`), `ColorPicker` and its parts `ColorArea`, `ColorSlider`, `ColorField`, `ColorSwatch`, `ColorEyeDropper` (a color in RGB, HSL, HSB or OKLCH: `color_picker/`), `OtpInput`, `Table` and its parts (`table.rs`: a table's roles, the look the app's), the charts' parts in the submodule `nsh/base/plot` (`Plot`, `Line`, `Area`, `Grid`, `Pie`, `Arc`, `Treemap`: `plot/treemap/`), `Input` (a native text input, made by `nsh-js`), the status
                       bar, `TextView` (Markdown / HTML documents: `text_view/`, docs/dev/text-view.md), `ResizablePanelGroup` / `ResizablePanel` (`resizable/`), `DockArea` (a dockable workspace: splits, tab groups and edge docks whose layout is
                       data, `dock/`, docs/dev/dock.md), `Editor` (a code editor: highlighting, several carets, folds, search, diagnostics;
                       `editor/`, docs/dev/editor.md), `DiffView` (the changes between two texts or of a patch, split or unified: `diff/`,
                       docs/dev/diff.md), `DataTable` (a table that scrolls both ways over any number of rows and columns: selection, sorting, resizing,
                       moving, fixed columns; `data_table/`, docs/dev/data-table.md), `RichEditor`'s headless kernel after ProseMirror
                       (schema-defined documents, steps, transactions, states, commands, history, formats; `rich_editor/`,
                       docs/dev/rich-editor.md),
                       the popups on the core's overlays (`Popover`, `HoverCard`, `Menu` / `ContextMenu` / `MenuItem` / `MenuSeparator` / `Submenu`,
                       `Tooltip`, `Sheet`; presented per device: docs/dev/components.md "Popups"), written in Rust (the navigation and `Dialog` in `nsh-js`); JS face and declarations made from their specs;
                       the theme (`theme.rs`: shadcn/ui's tokens and their defaults, `neutral`, read from shadcn's `cssVars` theme
                       files, which the core keeps as design tokens and no component of `nsh-base` draws with)
  nsh-macros/          `#[component]`, derives of Rust components (`Props`, `PropEnum`, `Event`, `JsObject`), `#[methods]`, `#[module]`, `#[class]`,
                       `#[native_module("…")]` (an app crate's UI set, which `rust_app.rs`'s generated code calls),
                       `#[native_components(<platform>)]` (an app crate's native components, which the generated hosts register), `Styled`'s spacing methods;
                       `HostProps` (the host elements' props: decoding, defaults and TS), `JsOps` (recorded operations: canvas)
  nsh-js/              QuickJS host and NSH's runtime: console / timers, bytecode compilation and loading, limits (`sandbox.rs`);
                       the native modules apps import (`modules.rs`: module table and loader; docs/dev/js-modules.md), the
                       app's side of the channel with the embedding app (`host_channel.rs`: `nsh`'s `host`), the
                       renderer of compiled JSX (`dom.rs`, `nsh:rt`), JS's reactive graph (`reactive.rs`: `nsh-core`'s
                       graph with JS values: signals, memos, effects, owners, context), `resource` (`resource.rs`), Rust components' and modules' JS face (`components.rs`), navigation,
                       lists, canvas, animation (`navigation.rs`, `list.rs`, `canvas.rs`, `animated.rs`), touches and the
                       responder system (`touch.rs`), the environment (`env.rs`), hot module replacement (`hot.rs`),
                       Rust classes (`classes.rs`: on the web classes' machinery);
                       decoding JS values into core types (`protocol.rs`); the web APIs of TS apps (`web/`: fetch, streams,
                       Blob / FormData, URL, encoding, events), native classes; the standard modules' VM side (`standard/`:
                       the catalog and its loader, LLRT's `buffer` / `crypto` / `path` / `url` / `zlib`, `console`,
                       the globals `WebSocket`, `process` and `nextTick`); the TypeScript declarations of all of it
                       (`declarations.rs`, from the declaration next to each export and spec)
  nsh-engine/          Engine thread: drives nsh-js + nsh-core and hands one MountBatch per frame to the platform;
                       feature `shader`: the native backends' shader renderer (`shader.rs`: shader views' WGSL rendered with
                       wgpu offscreen, read back asynchronously, never blocking the main thread; docs/dev/shaders.md)
  nsh-package/         Signed packages (`.nshpkg`): Ed25519 keys, release-key certificates, revocation lists, the trust store
  nsh-updater/          App self-update: manifests and their signatures, verified downloads, replacing the installed app on the desktop (docs/dev/updater.md); `nsh-core`'s `runtime/updater.rs` is its JS face, `nsh/updater`
  nsh-bundler/         Bundler: rolldown + Oxc (TS stripping) + NSH's JSX compiler (`jsx.rs`, docs/dev/native-pipeline.md) + source maps;
                       imports of the native modules stay imports (`plugin.rs`), so a bundle holds only the app's code;
                       the app's themes (nsh.json `tailwind` / `theme`, checked, handed to the renderer by the entry) and the
                       unknown-class check (`classes.rs`); the warning of components taking their props apart (`props.rs`);
                       development bundles with hot module replacement (`hot.rs`); the bundler's part of `.nsh/types`
                       (`types.rs`: asset imports); feature `bundle` (default off in the workspace; the CLI turns it on) is
                       all of that, without it only `compile_module` (`compile.rs`: one module, no rolldown) is left, which
                       also builds for WebAssembly (the website's playground)
  nsh-dev/             Dev tooling: dev server protocol, server (CLI, feature `server`), client (host, feature `client`)
  nsh-testing/         Headless tests: the driver (`headless/`: an engine without a window, display frames, a model of the views,
                       the steps, stand-in network and storage, fetch on ureq; no QuickJS, for Rust apps' `cargo test`); feature
                       `js`: `nsh test`'s side, the `nsh/test` module test files import (`module.rs`, Rust), each test file on an
                       engine of its own and each app it opens on a headless one (`run.rs`; the web page's host module,
                       nsh.json `web.host`, answers `nsh`'s `host` there: `page_host.rs`) or a real host (`driver.rs`, `--target`),
                       apps' headless runners (`runner.rs`); feature `bundle`: building entries in process (TSX entries of
                       `cargo test`, the CLI's compiler); feature `agent`: a real host's test agent (`agent.rs`, the dev hosts'),
                       which takes the steps with the platform's input
  nsh-platform-ios/    UIKit backend (iOS / simulator / Mac Catalyst): native view mounting, CoreText text engine, input, AppView, standalone app;
                       feature `dev`: dev server client, log forwarding, error overlay; feature `embed`: the C ABI (`embed.rs`,
                       `include/nsh.h`) under the `NativeShell` Swift module (`swift/NativeShell.swift`) iOS apps embed nsh with
  nsh-platform-android/ Android backend: `libnsh.so` (JNI glue, StaticLayout text engine, batch encoding, UI-thread animator) + the Java
                       runtime in `java/com/longbridge/nsh` (NshView, Mounter, views, images, networking); feature `dev` as above
  nsh-platform-web/    WebAssembly backend (published web apps, `nsh run --target web`, the website's live demos): the engine on
                       the page's main thread (`LocalEngine`), text laid out with browser font metrics, batches as JSON + CSS
                       for the DOM runtime in `web/nsh.js`, the animator on requestAnimationFrame, fetch over the browser's
                       (`net.rs`); app code runs on the browser's own JavaScript engine (feature `browser`: `src/browser/`
                       and `web/browser/`, no QuickJS in WebAssembly), feature `dev`: the development host's (`nsh-dev.wasm`,
                       development bundles with hot updates, `web/browser/hot.js`, the model `nsh test --target web` asks
                       about); `web/index.html` is the demo
                       player (`cargo xtask web`); feature `compiler`: the playground's TSX compiler (`nsh-playground.wasm`)
                       (docs/dev/web.md)
  nsh-platform-linux/  GTK 4 backend (Linux): one `NshView` widget per node drawn with GSK, Pango text engine (typeset on the engine
                       thread, glyph runs drawn on the main thread), input, scroll views, navigation, video, native
                       components, AppView, standalone app; feature `dev`: dev server client, log forwarding, error overlay,
                       the test agent's platform part (`agent.rs`: `nsh test --target linux`) (docs/dev/linux.md)
  nsh-linux-host/      Development host on Linux (`nsh run --target linux`): connects to a dev server or runs a bundle
  nsh-linux-app/       Release runner on Linux: the executable of apps built by `nsh package --target linux`
  nsh-platform-apple/  Shared by the macOS and iOS backends: the Speech recognizer, the notification center, and
                       `unified_log`, the logger of the release runners and the iOS SDK (the unified log; stderr too
                       wherever it goes but /dev/null)
  nsh-platform-macos/  AppKit backend (macOS): one flipped, layer-backed `NSView` per node decorated by Core Animation, CoreText text
                       (typeset on the engine thread), desktop input and scroll views as on Linux, navigation, video, web views,
                       native components, AppView, standalone app; feature `dev` as above (docs/dev/macos.md)
  nsh-macos-host/      Development host on macOS (`nsh run --target macos`): connects to a dev server or runs a bundle
  nsh-macos-app/       Release runner on macOS: the executable of apps built by `nsh package --target macos`
  nsh-platform-windows/ Win32 backend (Windows): one retained `NshView` per node, the tree drawn with Direct2D into a swap chain,
                       DirectWrite text engine (typeset on the engine thread, glyph runs drawn on the main thread), input
                       (mouse, touch, pen, wheel, precision touchpads), scroll views, NSH's own text editor (IMM32 IME),
                       navigation, video (Media Foundation), web views (WebView2), native components, UI Automation,
                       AppView, standalone app; feature `dev` as above (docs/dev/windows.md)
  nsh-windows-host/    Development host on Windows (`nsh run --target windows`): connects to a dev server or runs a bundle
  nsh-windows-app/     Release runner on Windows: the executable of apps built by `nsh package --target windows`
  gpui/                The GPUI backend: a workspace of its own (`crates/gpui/Cargo.toml`, its own `Cargo.lock` and GPUI's dependencies),
                       excluded from the main one, so the main workspace's builds, tests and CI never build GPUI:
  gpui/nsh-platform-gpui/ GPUI backend (macOS, Windows, Linux): the Windows backend's retained `NshView` tree, input,
                       scrolling and editing logic, painted by one GPUI element per surface (`render.rs`: `SurfaceElement`,
                       `DrawCx` with the transform and opacity GPUI lacks), text shaped by GPUI's text system on the engine
                       thread, the main-thread queue (`rt.rs`), GPUI events (`events.rs`, keys as Windows VK codes);
                       `AppView` is a GPUI view for GPUI / GPUI Kit apps; features `webview` (wry), `video` (GStreamer),
                       `dev` as above, `shot` (screenshots on macOS / Windows: GPUI's test support), the runtime's
                       optional parts as the other platform crates (docs/dev/features.md); it is the
                       backend for embedding, standalone apps run on each OS's own backend (docs/dev/gpui.md)
  gpui/nsh-gpui-host/  Development host on GPUI (`nsh run --target gpui`): shows a TSX app as GPUI apps that embed it
                       show it; connects to a dev server or runs a bundle
  nsh-ios-host/        Development host app (Catalyst / iOS simulator); connects to a dev server or runs a local bundle
  nsh-ios-app/         Release runner: the executable of iOS apps built by `nsh package`
  nsh-cli/             The `nsh` command line (a binary): init / build / test / check / dev / run / package; keygen /
                       certify / publish / verify / revoke; apps with Rust components of their own (`rust_app.rs`: each crate
                       nsh.json `"rust"` names, one or a list, has a `#[native_module("…")]` fn; a generated workspace in `.nsh/rust`
                       with a `describe` program, which prints the sets as data for the CLI to bundle, compile and declare with, the
                       hosts and runners, and the headless runner of `nsh test`; it takes nsh's crates where the app's crates do:
                       crates.io at the CLI's version, or the checkout they depend on by path; docs/dev/tooling.md); web packages and the
                       browser host's pages (`web.rs`, `web/`); `nsh test --target web`'s headless browser (`cdp.rs`, `test_web.rs`);
                       what it prints (`ui.rs`:
                       one line per step, tools' output only on failure, `-v` for everything; docs/dev/tooling.md "Output")
  xtask/               Maintainer tasks: `cargo xtask android` (Android runtime), `ios-embed` (the iOS SDK), `dist` (the distribution),
                       `web` (the WebAssembly runtime and the website's demos), `emoji-data` (`EmojiPicker`'s emoji from a release of emojibase-data), `compat` (runs `nsh-compat` against this checkout;
                       `compat record <version>`: records a release there)
tests/compat/         The apps whose scripts check the API apps use (`nsh-compat` builds and runs them): `cases/<domain>/` (one app per
                      domain, a module per case, `script.txt`), `examples/<app>.txt` (the scripts of examples)
skills/               The skills for coding agents that build apps with NSH (`npx skills add longbridge/nsh`): `skills/nsh`, `skills/nsh-design-guides`;
                      their guides are verbatim copies of `website/docs/`, their recipes of `examples/tasks-rs` and `examples/tasks`, and `website/tests/skills.test.ts`
                      fails when a copy differs: after changing one, copy it (`cp website/docs/coding-guides.md skills/nsh/references/`)
docs/                 Documentation; `docs/dev/`: for developers of nsh (architecture, internals, decisions, pitfalls)
website/              The documentation site (Astro; guides, element / component / API reference in English and zh-CN) and its
                      runnable demos (`website/demos/*.tsx`, live on the site through the WebAssembly runtime); see its README
examples/             Example apps (gallery: a demo index, one module per demo, `tests/` the reference for `nsh test` (storage,
                      inputs, a long list, stubbed requests, dark mode, a manual clock); gallery-rs: the same in Rust, the app's crate in `native/`,
                      TypeScript tests of its root (`*.test.tsx`, about a demo each); rust-exports: a TSX app using one of each export of its crate, the reference
                      for exporting components, modules and classes and registering native components, with Rust and TypeScript tests of the TSX entry; counter,
                      with a test; tray: a tray app whose main window starts hidden (nsh.json `window.defaultVisible`),
                      with a test; host-echo: an app calling its web page's host (`nsh`'s `host`, nsh.json `web.host`), the host
                      module and their tests), embedding samples
                      (embed-ios, embed-android; embed-gpui: a GPUI Kit app, its own workspace; `run/` the root's
                      `cargo run -p example-embed-gpui`) and the app they run (embedded: uses a native component the samples
                      register); bench: component benchmarks
```

The TSX gallery and website demos share their internal styled UI in `examples/nsh-gallery-ui/`: components,
icons, finishes, theme and table part classes. Change shared visual rules there. `examples/gallery/ui.tsx` keeps
the gallery shell/navigation; `website/demos/palette.ts` is the documentation adapter. See that layer's README.

**Gallery examples must be beautiful and refined.** A demo in `examples/gallery` or `examples/gallery-rs` is what people
judge NSH by, so one is finished only when it looks designed: colors from the theme's tokens (up and down, too, as
`text-up` / `text-down`), restrained gradients or real photographs instead of saturated placeholder tints, nothing clipped,
even spacing and alignment, no leftover boxes or debug-looking labels. Photos come from the ones the gallery already
uses, so a page does not download many images, and do not repeat within a page unless the demo compares one picture.
Check a screenshot, in dark and light, before calling a demo done.

Dependency direction: `nsh-core` ← `nsh-js` ← `nsh-engine` (also ← `nsh-package`) ← `nsh-platform-*` ←
`nsh-ios-host` / `nsh-ios-app` / `nsh-linux-host` / `nsh-linux-app` / `nsh-macos-host` / `nsh-macos-app` / `nsh-windows-host` / `nsh-windows-app` / `nsh-gpui-host`; `nsh-cli` depends on `nsh-bundler`, `nsh-js` and `nsh-engine`; `nsh-bundler`'s feature `bundle` depends on `nsh-js` (to check
imports against the names native modules export); `nsh-base` depends on `nsh-core` only and is used by the bundler
(declarations), the platforms and the CLI (registry). An app's own crates (its UI sets) depend on `nsh-core` only and
are never linked into the CLI: it reads their UI sets as data (`nsh_core::element::description`); the hosts and runners
`rust_app.rs` generates link them. `nsh-core` must not depend on any platform or JS crate.

## Documentation

| Changing | Read |
|---|---|
| threads, the JS → native data flow, text pipeline | `docs/dev/architecture.md` |
| how apps are compiled and run: the JSX compiler, the renderer | `docs/dev/native-pipeline.md` |
| the native modules, where a new API goes, platform props | `docs/dev/js-modules.md` |
| API names: anything apps use, its props, events, slots and parts | `docs/dev/api-naming.md` |
| elements, touch, accessibility, the environment | `docs/dev/elements.md`, `text.md` |
| styles, Tailwind, effects | `docs/dev/styles.md` |
| units and geometry (`Points`, `Length`, `Bounds`, ...) | `docs/dev/geometry.md` |
| scroll views, zooming, `List` | `docs/dev/scrolling-and-lists.md` |
| animation, canvas, images | `docs/dev/animation.md`, `canvas.md`, `images.md` |
| shaders: WGSL views, the renderer | `docs/dev/shaders.md` |
| VM limits, capabilities, signed packages | `docs/dev/sandbox.md`, `signed-packages.md` |
| packaging, the iOS / Android SDKs, native components | `docs/dev/embedding.md` |
| `.nsh/types`, the dev server, hot reload | `docs/dev/tooling.md` |
| the web runtime (`nsh-platform-web`), the website's demos | `docs/dev/web.md`, `website/README.md` |
| the Linux backend (`nsh-platform-linux`, GTK 4) | `docs/dev/linux.md` |
| the macOS backend (`nsh-platform-macos`, AppKit) | `docs/dev/macos.md` |
| the Windows backend (`nsh-platform-windows`, Win32 / Direct2D) | `docs/dev/windows.md` |
| the GPUI backend (`nsh-platform-gpui`, macOS / Windows / Linux) | `docs/dev/gpui.md` |
| anything apps use: exports, `nsh:rt`, props, events, style keys, Tailwind, declarations, behavior, formats | `docs/dev/compatibility.md` |
| a hot path | `docs/dev/performance.md` (baselines) |
| anything platform-specific | `docs/dev/pitfalls.md` (verified constraints, by area) |
| Rust components (`nsh-base`'s, apps' UI sets) | `docs/dev/components.md` |
| `TextView`: Markdown / HTML documents, their parsers, parts and extensions | `docs/dev/text-view.md` |
| `DockArea` and `ResizablePanelGroup`: the layout data, render keys, drag and drop, compact presentation | `docs/dev/dock.md` |
| `Editor`: the code editor's model, display rows, input, keys, highlighting, search, diagnostics and parts | `docs/dev/editor.md` |
| `DiffView`: the line diff, pairing and inline changes, rows and separators, patches, parts | `docs/dev/diff.md` |
| platforms built outside NSH: the extension points, `Environment::platform` (the platform's name beside the device's `Os`), external targets (`nsh-platform-<name>`), the generated `nsh_rust_app` | `docs/dev/platforms.md` |
| `DataTable`: columns, the virtual rows and columns, huge extents, selection, the layers | `docs/dev/data-table.md` |
| `RichEditor`: the schema, steps and transactions, positions, states, plugins, node views, formats | `docs/dev/rich-editor.md` |
| Rust classes TS uses (`#[class]`), module functions' kinds, callbacks, how calls and Rust components' props cross (typed) | `docs/dev/rust-classes.md`, `docs/dev/components.md` |

Keep them current: a change that alters documented behavior updates its page (or the module doc) in the same commit,
including the user-facing pages in `website/` (English and `zh-CN`). User-facing pages and the README are written in
positive terms: what a platform or feature is and does, never what it is not or lacks, and name the product Native
Shell in formal places and NSH elsewhere (`nsh` only in code) ("Writing documentation" in `website/README.md`).

Two homes for documentation. This repository's documentation (`docs/dev/`, `website/`, module docs, pull request
text) describes NSH at the level every contributor needs: the direction, concepts, which component does what,
rules, code locations, commands and verification. The core design record lives in the private repository
[`longbridge/nsh-docs`](https://github.com/longbridge/nsh-docs), checked out beside this one at `../nsh-docs`
(`gh repo clone longbridge/nsh-docs ../nsh-docs`): the design thinking behind NSH's architecture and the details of
its core mechanisms — key algorithms, inner data structures and protocols, formats and ABIs, tuning and
thresholds, and the reasoning and alternatives behind them.

When the core developers (`huacnlee`, `sunli829`, `madcodelife`) design or change something at that level with
you, write the details to nsh-docs (its `dev/<page>.md`, the full version of `docs/dev/<page>.md`, or a design
note such as `web/runtime-split.md`; follow that repository's contribution workflow), and give this repository only the summary a
contributor needs: what the part does and where its code is. If you are unsure which side something belongs
to, put the details in nsh-docs and the summary here. Before changing an area, read its nsh-docs page as well as
`docs/dev/` when you have access; without it, `docs/dev/` and the code's module docs are enough to work from.
