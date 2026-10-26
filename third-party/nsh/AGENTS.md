# AGENTS.md

Native Shell (NSH for short in prose; crates, the CLI, the JS module and Java package all use `nsh`) is designed for
AI-generated, dynamically delivered native UI: native apps embed it (`NshAppView` on iOS, `NshView` on Android,
`AppView` on macOS, Windows and Linux) and load TSX modules at run time — signed, sandboxed by the host, rendered with
each platform's own UI. Embedding comes first; plugins for native apps and standalone apps use the same machinery.
Module code runs in QuickJS on a native runtime (the reactive graph, the renderer and every module apps import are
Rust); layout uses Taffy; embedding native components such as maps or web views has no layering problems. The
toolchain is pure Rust and does not need Node.js; app developers get a prebuilt distribution (`cargo xtask dist`) and
never need Rust either. Every platform has a native backend: iOS with UIKit views (`nsh-platform-ios`), Android with
Android views (`nsh-platform-android`), macOS with AppKit views (`nsh-platform-macos`), Windows in Win32 windows drawn
with Direct2D (`nsh-platform-windows`), Linux with GTK 4 widgets (`nsh-platform-linux`). Each desktop OS has one
backend for standalone apps (AppKit, Win32, GTK 4); the GPUI backend (`nsh-platform-gpui`) draws on macOS, Windows and
Linux and is the backend for embedding in GPUI / GPUI Kit apps; the web platform
(`nsh-platform-web`) renders apps as HTML in a browser page, and `nsh package --target web` publishes them as static
sites. The terminal backend (`nsh-platform-tui`) draws into Ratatui buffers on all three desktops and embeds in
terminal apps. NSH is layered as GPUI Kit is: `nsh-core` is NSH's `gpui` (primitives, layout, rendering), `nsh-base` its
`gpui-base` (unstyled base components: behavior, state, focus, accessibility, no look); a styled component library,
NSH's `gpui-component`, is never part of NSH: apps and the community build theirs on `nsh-base`, or customize the UI
in the app itself.

This file is the short version. The details are in `docs/dev/` (read the page of the area you change first) and in
the module docs of the code (`//!`, Javadoc), which are the reference for how a module works inside.

## Layout

```
crates/
  nsh-core/            Platform-independent core: typed units and geometry (`geometry/`, as GPUI's), shadow tree, styles (RN semantics), Taffy layout (flex + grid + block, on the core's own layout tree: `core/layout_tree.rs`), text merging, list virtualization,
                       mount items; CSS values (`css.rs`: colors, lengths, shadows, gradients, filters), effects (`effects.rs`), Tailwind (`tailwind/`);
                       what iOS and Android share (`mobile.rs`: `nsh/mobile`'s `TabBar`, a native component the two backends register);
                       the reactive graph both sides run on (`reactive.rs`, Solid's algorithm, generic over the host), the loads of
                       resources both faces share (`resource.rs`); opening URLs outside the app (`open_url.rs`: the check, the flow); the selection across the texts of a selection area (`selection.rs`, the platforms run it);
                       overlays (`overlay.rs`: anchors and their placement; `core/overlay.rs`: shown in the root view, outside presses,
                       Escape / back; docs/dev/elements.md "Overlays"); the native animation graph (`animation/`: value / interpolate /
                       math nodes, timing / spring / decay drivers; the platforms evaluate it every frame; `Animator`: its
                       bindings to views, gestures and scroll views); what the desktop backends share, free of any toolkit:
                       pointer decisions (`input.rs`: what a pointer may start, presses, hover, hit areas, wheel latching),
                       navigation decisions (`navigation.rs`: stacks' screens, transitions' timing and motion, what going back
                       acts on), one view's transitions, layout animations and keyframes (`transition.rs`: curves,
                       interpolation, timing), scroll views' state and physics (`scroll.rs`);
                       Rust components that run once (`ui/`: signals, elements, bindings, typed styles, design tokens;
                       `core/components.rs`, `core/views.rs`), classes TS uses with `new` (`ui/class.rs`), JS's calls into
                       Rust and what comes back, typed (`ui/call.rs`: ops carrying closures, the event stream, posts); UI sets as data for the
                       toolchain (`ui/description.rs`: exports, declarations, files; JSON for apps' describe programs); the runtime's Rust
                       modules (`runtime/`: `nsh/android`'s Toast, `nsh/image`, ...; their JS face is made from their specs),
                       the standard modules among them (`runtime/fs.rs`: `fs/promises`, `runtime/process.rs`, `runtime/net.rs`,
                       `runtime/websocket.rs`, `runtime/os.rs`) on the `System` their calls get (capabilities, data directory, quotas, per-VM state)
  nsh-base/            `nsh/base`, NSH's `gpui-base`: unstyled base components (behavior, state, focus, accessibility; the look is the
                       app's): navigation (`NavStack`, `NavPage`), `Dialog`, `AlertDialog`, `Button`, `Checkbox`, `Radio` / `RadioGroup`, `Switch`, `Tab` / `Tabs`, `Collapsible`, `Progress`, `Table` and its parts (`table.rs`: a table's roles, the look the app's), the charts' parts in the submodule `nsh/base/plot` (`Plot`, `Line`, `Area`, `Grid`), safe areas, the keyboard, the status
                       bar, `SelectionArea` (texts that select together: `nsh-core`'s `selection.rs`), `TextView` (Markdown / HTML documents: `text_view/`, docs/dev/text-view.md), `ResizablePanelGroup` / `ResizablePanel` (`resizable/`), `DockArea` (a dockable workspace: splits, tab groups and edge docks whose layout is
                       data, `dock/`, docs/dev/dock.md), `Editor` (a code editor: highlighting, several carets, folds, search, diagnostics;
                       `editor/`, docs/dev/editor.md), `DiffView` (the changes between two texts or of a patch, split or unified: `diff/`,
                       docs/dev/diff.md), `DataTable` (a table that scrolls both ways over any number of rows and columns: selection, sorting, resizing,
                       moving, fixed columns; `data_table/`, docs/dev/data-table.md),
                       the popups on the core's overlays (`Popover`, `Menu` / `ContextMenu` / `MenuItem` / `MenuSeparator` / `Submenu`,
                       `Tooltip`, `Sheet`; presented per device: docs/dev/components.md "Popups"), written in Rust (the navigation and `Dialog` in `nsh-js`); JS face and declarations made from their specs;
                       the theme (`theme.rs`: shadcn/ui's tokens and their defaults, `neutral`, read from shadcn's `cssVars` theme
                       files, which the core keeps as design tokens and no component of `nsh-base` draws with)
  nsh-macros/          `#[component]`, derives of Rust components (`Props`, `PropEnum`, `Event`, `JsObject`), `#[methods]`, `#[module]`, `#[class]`,
                       `#[native_module("…")]` (an app crate's UI set, which `rust_app.rs`'s generated code calls), `Styled`'s spacing methods;
                       `HostProps` (the host elements' props: decoding, defaults and TS), `JsOps` (recorded operations: canvas)
  nsh-js/              QuickJS host and NSH's runtime: console / timers, bytecode compilation and loading, limits (`sandbox.rs`);
                       the native modules apps import (`modules.rs`: module table and loader; docs/dev/js-modules.md), the
                       app's side of the channel with the embedding app (`host_channel.rs`: `nsh/host`), the
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
  nsh-engine/          Engine thread: drives nsh-js + nsh-core and hands one MountBatch per frame to the platform
  nsh-package/         Signed packages (`.nshpkg`): Ed25519 keys, release-key certificates, revocation lists, the trust store
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
                       nsh.json `web.host`, answers `nsh/host` there: `page_host.rs`) or a real host (`driver.rs`, `--target`),
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
                       (`net.rs`); feature `bytecode-only`: published apps' runtime (`nsh.wasm`, no QuickJS parser), feature
                       `dev`: the development host's (`nsh-dev.wasm`, source and hot updates, the model `nsh test --target web`
                       asks about); `web/index.html` is the demo
                       player (`cargo xtask web`); feature `compiler`: the playground's TSX compiler (`nsh-playground.wasm`)
                       (docs/dev/web.md)
  nsh-platform-linux/  GTK 4 backend (Linux): one `NshView` widget per node drawn with GSK, Pango text engine (typeset on the engine
                       thread, glyph runs drawn on the main thread), input, scroll views, navigation, video, native
                       components, AppView, standalone app; feature `dev`: dev server client, log forwarding, error overlay,
                       the test agent's platform part (`agent.rs`: `nsh test --target linux`) (docs/dev/linux.md)
  nsh-linux-host/      Development host on Linux (`nsh run --target linux`): connects to a dev server or runs a bundle
  nsh-linux-app/       Release runner on Linux: the executable of apps built by `nsh package --target linux`
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
  nsh-platform-tui/   Terminal backend (macOS, Windows, Linux): retained scene, terminal text measurement, focus and editing,
                       scrolling, navigation, native animation, worker-rendered images and canvas through detected graphics
                       protocols or half blocks;
                       AppView embeds in a Ratatui region, run_app owns a standalone terminal; feature `dev`: hot reload;
                       --script renders deterministic UTF-8 snapshots in memory (docs/dev/tui.md)
  nsh-tui-host/        Development host in a terminal (`nsh run --target tui`): connects to a dev server or runs a bundle
  nsh-tui-app/         Release runner in a terminal (`nsh package --target tui`)
  gpui/                The GPUI backend: a workspace of its own (`crates/gpui/Cargo.toml`, its own `Cargo.lock` and GPUI's dependencies),
                       excluded from the main one, so the main workspace's builds, tests and CI never build GPUI:
  gpui/nsh-platform-gpui/ GPUI backend (macOS, Windows, Linux): the Windows backend's retained `NshView` tree, input,
                       scrolling and editing logic, painted by one GPUI element per surface (`render.rs`: `SurfaceElement`,
                       `DrawCx` with the transform and opacity GPUI lacks), text shaped by GPUI's text system on the engine
                       thread, the main-thread queue (`rt.rs`), GPUI events (`events.rs`, keys as Windows VK codes);
                       `AppView` is a GPUI view for GPUI / GPUI Kit apps; features `webview` (wry), `video` (GStreamer),
                       `dev` as above, `shot` (screenshots on macOS / Windows: GPUI's test support); it is the
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
                       `web` (the WebAssembly runtime and the website's demos), `compat` (runs `nsh-compat` against this checkout;
                       `compat record <version>`: records a release there)
tests/compat/         The apps whose scripts check the API apps use (`nsh-compat` builds and runs them): `cases/<domain>/` (one app per
                      domain, a module per case, `script.txt`), `examples/<app>.txt` (the scripts of examples)
docs/                 Documentation; `docs/dev/`: for developers of nsh (architecture, internals, decisions, pitfalls)
website/              The documentation site (Astro; guides, element / component / API reference in English and zh-CN) and its
                      runnable demos (`website/demos/*.tsx`, live on the site through the WebAssembly runtime); see its README
examples/             Example apps (gallery: a demo index, one module per demo, `tests/` the reference for `nsh test` (storage,
                      inputs, a long list, stubbed requests, dark mode, a manual clock); gallery-rs: the same in Rust, the app's crate in `native/`,
                      TypeScript tests of its root (`*.test.tsx`, about a demo each); rust-exports: a TSX app using one of each export of its crate, the reference
                      for exporting components, modules and classes, with Rust and TypeScript tests of the TSX entry; counter,
                      with a test; host-echo: an app calling its web page's host (`nsh/host`, nsh.json `web.host`), the host
                      module and their tests), embedding samples
                      (embed-ios, embed-android; embed-gpui: a GPUI Kit app, its own workspace; `run/` the root's
                      `cargo run -p example-embed-gpui`) and the app they run (embedded: uses a native component the samples
                      register); bench: component benchmarks
```

The TSX gallery and website demos share their internal styled UI in `examples/nsh-gallery-ui/`: components,
icons, finishes, theme and table part classes. Change shared visual rules there. `examples/gallery/ui.tsx` keeps
the gallery shell/navigation; `website/demos/palette.ts` is the documentation adapter. See that layer's README.

Dependency direction: `nsh-core` ← `nsh-js` ← `nsh-engine` (also ← `nsh-package`) ← `nsh-platform-*` ←
`nsh-ios-host` / `nsh-ios-app` / `nsh-linux-host` / `nsh-linux-app` / `nsh-macos-host` / `nsh-macos-app` / `nsh-windows-host` / `nsh-windows-app` / `nsh-gpui-host` / `nsh-tui-host` / `nsh-tui-app`; `nsh-cli` depends on `nsh-bundler`, `nsh-js` and `nsh-engine`; `nsh-bundler`'s feature `bundle` depends on `nsh-js` (to check
imports against the names native modules export); `nsh-base` depends on `nsh-core` only and is used by the bundler
(declarations), the platforms and the CLI (registry). An app's own crates (its UI sets) depend on `nsh-core` only and
are never linked into the CLI: it reads their UI sets as data (`nsh_core::ui::description`); the hosts and runners
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
| VM limits, capabilities, signed packages | `docs/dev/sandbox.md`, `signed-packages.md` |
| packaging, the iOS / Android SDKs, native components | `docs/dev/embedding.md` |
| `.nsh/types`, the dev server, hot reload | `docs/dev/tooling.md` |
| the web runtime (`nsh-platform-web`), the website's demos | `docs/dev/web.md`, `website/README.md` |
| the Linux backend (`nsh-platform-linux`, GTK 4) | `docs/dev/linux.md` |
| the macOS backend (`nsh-platform-macos`, AppKit) | `docs/dev/macos.md` |
| the Windows backend (`nsh-platform-windows`, Win32 / Direct2D) | `docs/dev/windows.md` |
| the GPUI backend (`nsh-platform-gpui`, macOS / Windows / Linux) | `docs/dev/gpui.md` |
| the terminal backend (`nsh-platform-tui`, Ratatui) | `docs/dev/tui.md` |
| anything apps use: exports, `nsh:rt`, props, events, style keys, Tailwind, declarations, behavior, formats | `docs/dev/compatibility.md` |
| a hot path | `docs/dev/performance.md` (baselines) |
| anything platform-specific | `docs/dev/pitfalls.md` (verified constraints, by area) |
| Rust components (`nsh-base`'s, apps' UI sets) | `docs/dev/components.md` |
| `TextView`: Markdown / HTML documents, their parsers, parts and extensions | `docs/dev/text-view.md` |
| `DockArea` and `ResizablePanelGroup`: the layout data, render keys, drag and drop, compact presentation | `docs/dev/dock.md` |
| `Editor`: the code editor's model, display rows, input, keys, highlighting, search, diagnostics and parts | `docs/dev/editor.md` |
| `DiffView`: the line diff, pairing and inline changes, rows and separators, patches, parts | `docs/dev/diff.md` |
| `DataTable`: columns, the virtual rows and columns, huge extents, selection, the layers | `docs/dev/data-table.md` |
| Rust classes TS uses (`#[class]`), module functions' kinds, callbacks, how calls and Rust components' props cross (typed) | `docs/dev/rust-classes.md`, `docs/dev/components.md` |

Keep them current: a change that alters documented behavior updates its page (or the module doc) in the same commit,
including the user-facing pages in `website/` (English and `zh-CN`). User-facing pages and the README are written in
positive terms: what a platform or feature is and does, never what it is not or lacks, and name the product Native
Shell in formal places and NSH elsewhere (`nsh` only in code) ("Writing documentation" in `website/README.md`).

## Commands

```sh
cargo run [-- <app>] [-- --target catalyst|ios|android|gpui]                       # the gallery on this machine's backend (AppKit / GTK / Win32), hot reload; rebuilt and restarted on Rust changes
cargo xtask [<app>] [--target catalyst|ios|android|gpui] [-v]                      # the same without cargo's own two lines; -v (any nsh / xtask command): all output
cargo build -p nsh-cli                                                             # build the nsh CLI
./target/debug/nsh init my-app --template ts|rust|mixed                            # new app: TSX, Rust (a Cargo project, "root"), or TSX that is also a crate ("rust": "."); asks on a terminal without --template
cargo build -p nsh-ios-host --target aarch64-apple-ios-macabi                          # the Catalyst development host (nsh run builds it in a checkout)
cargo build -p nsh-ios-host --target aarch64-apple-ios-sim                             # the iOS simulator host (`nsh run --target ios`)
cargo build -p nsh-ios-app --target aarch64-apple-ios-sim                              # the release runner (`nsh package --target ios-simulator`)
cargo build -p nsh-linux-host                                                          # the Linux (GTK) development host (`nsh run` on Linux builds it in a checkout)
cargo build -p nsh-macos-host                                                          # the macOS (AppKit) development host (`nsh run --target macos` builds it in a checkout)
cargo build -p nsh-windows-host                                                        # the Windows development host (`nsh run` on Windows builds it in a checkout)
cargo build --manifest-path crates/gpui/Cargo.toml --target-dir target -p nsh-gpui-host                    # the GPUI development host (`nsh run --target gpui` builds it in a checkout)
cargo build --manifest-path crates/gpui/Cargo.toml --target-dir target -p nsh-gpui-host --features nsh-gpui-host/runtime-shaders   # the same on a Mac without Xcode's Metal Toolchain (GPUI compiles its shaders at run time)
cargo run -p example-embed-gpui                                                        # the GPUI Kit embedding example (a std-only runner that only runs `cargo run` in its own workspace)
./target/debug/nsh test examples/counter/App.tsx --trace                    # headless run: prints mount items and the time of every commit
echo 'await app.scroll("id:photos", 3000)' | ./target/release/nsh test examples/gallery/Bench.tsx --trace   # headless scrolling (10pt per frame): per-frame list cost
echo 'await app.press("label:Plan"); await app.wait(500)' | ./target/debug/nsh test examples/hopper/App.tsx --trace   # steps from stdin (`app`: nsh/test's App)
./target/debug/nsh test examples/gallery                                   # the app's tests (`*.test.tsx`, `nsh/test`), headless; --trace prints batches
./target/debug/nsh test examples/gallery --target macos                    # the same tests in macOS windows: native input at the views (`nsh_testing::agent`)
./target/debug/nsh test examples/gallery --target web                      # in a headless Chrome / Edge / Chromium (found, or --browser <PATH>): trusted input over CDP
xvfb-run -a ./target/debug/nsh test examples/gallery --target linux        # in GTK windows (a virtual display here); also windows, gpui
./target/debug/nsh test examples/gallery --target ios                      # in an iOS simulator: a finger's touches and the keyboard's typing, as UIKit gets them
./target/debug/nsh test examples/gallery --target android                  # on the first device adb lists: MotionEvents and KeyEvents at the window's views
echo 'await app.screenshot("a.png"); await app.press("label:Navigation"); await app.screenshot("b.png")' | ./target/debug/nsh test examples/gallery/App.tsx --target macos   # check a platform change: steps from stdin in its window
./target/debug/nsh check examples/hopper                                   # type check (TypeScript 7's native tsc, downloaded once; no Node)
./target/debug/nsh run examples/counter --trace                            # dev server + Catalyst host (390×844), hot reload on save
./target/debug/nsh run examples/gallery --target ios                       # in an iOS simulator (boots one; needs the nsh-ios-host sim build)
./target/debug/nsh run examples/gallery --target android                   # on an emulator / device (needs `cargo xtask android --dev`)
./target/debug/nsh run examples/gallery --target linux                     # in a GTK window (the default on Linux)
./target/debug/nsh run examples/gallery --target windows                   # in a Win32 window, 1200×800 (the default on Windows)
./target/debug/nsh run examples/gallery --target gpui                      # in a GPUI window (macOS, Windows, Linux), as GPUI apps embed it
./target/debug/nsh run examples/terminal-workbench --target tui            # in this terminal, with hot reload
./target/debug/nsh package examples/terminal-workbench --target tui        # console executable and resources, archived for this OS
./target/debug/nsh-tui-host --bundle build/bundle.nshc --size 120x40 --script "wait 300; shot screen.txt; quit"   # headless text snapshot
./target/debug/nsh run examples/gallery --target web                       # in the browser (the dev server serves the page)
./target/debug/nsh package examples/gallery --target web --run             # a static site (files named by content), served on this machine
./target/debug/nsh package examples/gallery --target ios-simulator --run   # installable app (.app / .ipa / .apk)
cargo xtask android [--release] [--dev]                                            # Android runtime into target/android/<profile>[-dev]
cargo xtask dist                                                                   # the distribution in dist/nsh
./target/debug/nsh dev examples/counter --server-only                      # dev server only (for simulators / devices); prints local and LAN URLs
./target/debug/nsh build examples/counter --release                        # writes bundle.js / bundle.nshc
./target/debug/nsh keygen keys/root && ./target/debug/nsh keygen keys/release      # signing keys (.secret / .pub)
./target/debug/nsh certify --root keys/root.secret --key keys/release.pub --apps 'com.example.*' -o keys/release.cert
./target/debug/nsh publish examples/counter --key keys/release.secret --cert keys/release.cert --build 2
./target/debug/nsh verify out/com.example.counter-2.nshpkg --root keys/root.pub     # as a device would check it
./target/debug/nsh revoke --root keys/root.secret --sequence 1 --package <sha256> -o revocations.json

cargo test --workspace
cargo test --release -p nsh-engine --test engine bench_gallery_scroll -- --ignored --nocapture   # gallery scroll benchmark (JS + core)
cargo test --release -p nsh-core bench_ -- --ignored --nocapture                # row / cell relayout benchmarks
cargo +nightly fmt --all                                                        # .rustfmt.toml uses nightly options
cargo clippy --workspace --all-targets
cargo clippy -p nsh-platform-ios -p nsh-ios-host -p nsh-ios-app --target aarch64-apple-ios-macabi --features nsh-platform-ios/embed,nsh-platform-ios/dev
cargo xtask ios-embed [--dynamic] [--x86-64-simulator] [--no-catalyst] [--no-dev]   # NativeShell(Dev).xcframework into dist/nsh/embed/ios
cargo xtask web                                                                 # nsh.wasm + player + website demos into website/public/play
cargo xtask compat                                                              # tests/compat's apps, and the API every recorded release froze (nsh-compat)
cargo xtask compat record <version>                                             # record this checkout as a release in nsh-compat (at release time)
cargo clippy -p nsh-platform-web --target wasm32-unknown-unknown --features compiler   # the web backend (empty off WebAssembly)
cargo clippy -p nsh-platform-linux -p nsh-linux-host -p nsh-linux-app --all-targets      # the Linux backend (on Linux; empty elsewhere)
cargo clippy -p nsh-platform-macos -p nsh-macos-host -p nsh-macos-app --all-targets --features nsh-platform-macos/dev   # the macOS backend (on macOS)
cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app --all-targets   # the Windows backend (on Windows; empty elsewhere)
cargo clippy -p nsh-platform-tui -p nsh-tui-host -p nsh-tui-app --all-targets   # the terminal backend (macOS / Windows / Linux)
cargo test -p nsh-platform-tui -p nsh-tui-host -p nsh-tui-app                  # tests and in-memory terminal rendering, no display needed
cargo test -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app               # its tests (on Windows; they open no window)
(cd crates/gpui && cargo clippy --all-targets --features nsh-platform-gpui/dev)        # the GPUI backend, its own workspace (empty off the desktops)
(cd crates/gpui && cargo test && cargo +nightly fmt --all)                              # its tests (they open no window) and formatting
cd website && bun run dev                                                       # the documentation site (builds the player too)
```

`nsh-platform-ios` only compiles for `target_os = "ios"` (iOS devices, the iOS simulator and Catalyst); on a macOS
host it is an empty crate, so always run clippy on platform code with the Catalyst target. Likewise
`nsh-platform-android` is empty off Android: check it with `cargo xtask android` (which sets up the NDK linker, `CC`,
`AR` and bindgen's sysroot) and `cargo xtask clippy-android`. `nsh-platform-linux` and its hosts are empty off Linux:
check them on Linux, with the GTK 4 (≥ 4.14) development packages installed. `nsh-platform-macos` and its hosts are
empty off macOS (`target_os = "macos"`, not Catalyst). `nsh-platform-windows` and its hosts are empty off Windows:
check them on Windows, with the MSVC Build Tools, the Windows SDK and LLVM (libclang for QuickJS' bindings);
`RUST_MIN_STACK=268435456` if rustc overflows its stack on the `windows` crate. The GPUI backend (`crates/gpui`) is
a workspace of its own: the main workspace's `cargo test --workspace` and clippy never build it, and its CI runs only when
it changes (and daily). Its crates build on all three desktops and are empty elsewhere; on Linux they need GPUI's X11 /
Wayland / xkbcommon / fontconfig packages plus GTK 3, WebKitGTK 4.1 (feature `webview`, on by default) and GStreamer
1.20+ with its base plug-ins (feature `video`, the host's); on macOS Xcode's Metal Toolchain, or the
feature `runtime-shaders` (`docs/dev/gpui.md`), which the CLI turns on when `xcrun metal` fails. It builds into the
repository's `target/`; dependencies only it uses are declared in `crates/gpui/Cargo.toml`, not the root. `.cargo/config.toml` sets
`IPHONEOS_DEPLOYMENT_TARGET = 15.0` for Rust and C alike.

The terminal backend is in the main workspace and builds on macOS, Windows and Linux using Rust libraries and the
OS console facilities. It needs the common C compiler / libclang setup for QuickJS when building with `js`, and
supports Rust-root embedding with `--no-default-features`. Layout stays in virtual points (one cell is 8×16 points
by default); only terminal IO, rendering, script input and embedding regions use cells. Keep those units explicit
when changing text measurement, clipping, pointer input or scripts (`docs/dev/tui.md`).

## Rules

- **Convention over configuration (CoC, a project constraint).** Follow the existing project and toolchain conventions
  before adding configuration, wrapper scripts, environment overrides or another cache directory. NSH-managed
  temporary/generated files belong in `.nsh/`. Cargo keeps its normal `target/` directory and the user's existing
  `CARGO_TARGET_DIR` behavior; do not add Cargo configuration or change that environment variable just to organize
  NSH files. Reuse the existing Cargo cache rather than creating a second one under `.nsh/`.
- **Three layers, as GPUI Kit's (an architecture rule).** `nsh-core` ↔ `gpui`: the primitives and the environment,
  `nsh` / `nsh/<module>` (native in `crates/nsh-js` or Rust modules of the runtime, `crates/nsh-core/src/runtime/`);
  TSX imports every primitive from `nsh`, as Rust does from `nsh_core::ui::prelude`.
  `nsh-base` ↔ `gpui-base`: `nsh/base` (`crates/nsh-base`), unstyled base components of `gpui-base`'s scope that own
  behavior, state, focus, keyboard and accessibility and leave every visual choice to the app (navigation, dialogs, a
  button, a checkbox, radios, a switch, tabs, popovers, menus, tooltips and sheets, safe areas, system alerts and the keyboard today, with the status bar a
  prop of pages and dialogs; controls such as toggles, sliders and selects as their behavior is written). Names follow `gpui-base`'s
  (`docs/dev/api-naming.md`). `gpui-component` ↔ nothing: a styled component library is never part of NSH; apps and
  the community build theirs on `nsh-base`, or style the UI in the app itself. Each export has one home (two
  registries exporting one name panic, `Registry::merged`). Platform-only APIs go to `nsh/ios` / `nsh/android`, what iOS and Android share to `nsh/mobile`, what the desktops share to `nsh/desktop`,
  platform-only props into `ios={{…}}` / `android={{…}}` / `desktop={{…}}`. `nsh` has no catch-all re-exports. Beside
  them sits a fixed catalog of eleven standard modules with bare specifiers (`nsh_core::js::STANDARD_MODULES`:
  `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`, `zlib`):
  Node-shaped subsets compatible with gpui-shell's, built on the same native machinery (typed registries, capability
  checks in Rust) with generated declarations. Exactly these names import; `node:` prefixes and other Node modules
  (`fs`, `events`, `util`, ...) are refused. Files and processes are these modules (`fs/promises`, `process`), never
  an `nsh/<module>`; the catalog grows only by a design decision.
- **Backward compatible, from the first recorded release on.** Apps are delivered to host apps as plugins and may
  never be built again, so every release runs every app built for an earlier compatible one. What a release recorded
  in [`longbridge/nsh-compat`](https://github.com/longbridge/nsh-compat) shipped is never removed or renamed: modules,
  exports and their members, `nsh:rt` (what compiled JSX calls: append-only, signatures and semantics kept), globals,
  props, events and payload keys, style keys and values, Tailwind utilities. A rename or move keeps the old name as a
  `@deprecated` alias of the same implementation, for good. Types only widen; inputs gain optional members only;
  behavior and defaults stay (new behavior is opt-in); formats (`.nshpkg`, certificates) are read forever. The record
  and its checks live in that repository, never here: a change to NSH cannot rewrite them, and the only removals are
  security closures in its `closed.txt`. No release is recorded yet, so nothing is frozen: what is on `main` may still
  change until 0.3.0, the first release recorded. A new API lands with its test, a case in
  `tests/compat/cases/<domain>/` whose script checks it (`cargo xtask compat`; `docs/dev/compatibility.md`).
- **Native views and interaction, app-owned design.** Common controls have one cross-platform home in `nsh/base`.
  A system-styled version of a common control does not justify another public component in a platform module.
  Extend shared behavior and styling parts instead. `nsh/mobile`'s `TabBar` is a mobile navigation capability,
  distinct in role from `Tabs`; platform modules expose platform-specific semantics, not parallel catalogs of
  system-styled form controls. See `docs/dev/js-modules.md` "Component scope and project goals" and
  `website/docs/goals.md` (with its Chinese counterpart).
- **No styles in NSH.** Nothing NSH ships has a look of its own: no default colors, paddings, radii, fonts or variants
  in `nsh-base`'s components (its theme's default tokens, shadcn/ui's, are the app's to draw with; the
  exceptions are `TextView`'s default reading typography, its colors the theme's shadcn tokens (alerts GitHub's alert
  colors, highlights a marker's yellow), every part overridable by the
  app's `classes` / `styles` / `TextViewParts`, and its built-in syntax highlighting colors, Allsum's code palette, which an app's
  `CodeHighlighter` or `renderCodeBlock` replaces, and the `Editor`'s default look, its colors the theme's shadcn tokens
  (search matches amber, warnings amber, information blue), its font the theme's `font-mono`, every part overridable by
  the app's `classes` / `styles`, and the same built-in syntax highlighting colors, which the app's `decorations` style over, and `DiffView`'s default look: theme tokens, added green, deleted red, every part
  overridable by `classes` / `styles`); a component takes the app's styles (`class`, `style`, styles per state) and children, and exposes its
  parts instead of fixed markup. Its state is controlled (it reports changes, the app owns the value). The platforms
  draw nothing of NSH's either: no header where the system has none (the desktops and the web place a page's `header`
  slot), no dialog card, scrim or shadow, no native press fade (press feedback is the app's `activeStyle` /
  `active:`), no built-in strings (every label comes from the app); system UI keeps the platform's look (iOS / Android
  headers; `AlertDialog`, drawn in the platform's dialog style where the system has no dialog to show). React Native and
  UIKit are references for which capabilities exist, not APIs to be compatible with.
- **CSS and Tailwind as in a browser.** CSS values (colors, lengths, gradients, filters, shadows, transforms,
  alignment keywords, ...) and Tailwind utilities and variants mean exactly what they mean in a browser and in
  Tailwind CSS (v4); Tailwind's generated CSS is the reference for each utility. What NSH cannot support is
  unsupported (an unknown class, a rejected value with a warning), never given a different meaning: nothing
  NSH-specific, so there are no traps (`docs/dev/styles.md`).
- **Components are Rust.** Rust components live in `crates/nsh-base` or in an app's own crate (its UI set,
  `#[native_module("…")]`), run in the core and render primitives with typed styles (GPUI-style `Styled` methods,
  never class strings); props and events are derived types, their JS face is made from the specs (`nsh-js`
  `components.rs`) and their TypeScript declarations generated from them (`nsh_core::ui::declarations`), never
  hand-written per component. JS allocates even node ids, the core odd ones for what components expand
  (`docs/dev/components.md`).
- **The main thread never waits for JS.** Callbacks the system wants answered on the spot (may this text change, may
  the back button pop, may the sheet close, ...) are answered natively from props mounted beforehand; events tell JS
  afterwards (`docs/dev/elements.md`).
- **One surface / `NshView` is one engine**, with no global singletons (NSH is embedded with several instances).
- **Limits and checks are enforced in Rust, never in JS**: a bundle holds only the app's code, so nothing in JS is
  trusted. QuickJS bytecode is trusted input (`Bundle::bytecode` is `unsafe`): it only loads from the app's own
  resources, the dev server and verified packages (`docs/dev/signed-packages.md`).
- **Generated, never hand-copied**: the codes of encoded operations (`ANIMATION_*`, `CV_*`), the canvas's recording
  methods and properties (made natively from `CanvasOp`'s `#[derive(JsOps)]` specs, which also decode them), the style
  types, the host elements' props and events and the easings / layout animation presets come from
  `crates/nsh-core/src/js/`, and so do their declarations, as do those of the runtime's Rust modules, of `nsh/base` and of apps'
  UI sets. No `.d.ts` is checked in: a native module's export carries its declaration (`modules::Ts`), a web
  class's spec its members' (`web::ClassTs`), and tests load every module and global and check that what exists is
  what is declared (`nsh-js` `declarations.rs`). A new style property is one line of `style_keys!` (`style.rs`) with
  its TS type, a new host prop one variant of `Prop` with `#[prop(js = …)]`, a new event a row of `host::EVENTS` (or
  `INTERNAL_EVENTS`) (`docs/dev/elements.md`).
- **Keep in sync**: the handler types of `host::EVENTS` ↔ the payloads of `nsh-js`'s `dispatch_event`; the order of `EventKind` ↔ `Native.java`; `encode.rs`
  opcodes ↔ `Mounter.java`; new event payload keys ↔ the JNI event map's key list; `BUNDLE_NAME` /
  `BYTECODE_VERSION` ↔ the linked QuickJS; `nsh-macros`' `VARIANT_SCALES` ↔ `IMAGE_SCALES` above 1.

## Code conventions

- Name context bindings and parameters `cx`.

- Formatting: `cargo +nightly fmt --all`, configured in `.rustfmt.toml`.
- Units and geometry are typed, as GPUI's are (`nsh_core::geometry`): a length is `Points` (GPUI's `Pixels`), `Rems`,
  a `Percentage` (a fraction, 0.5 is 50%) or a style length (`AbsoluteLength`, `DefiniteLength`, `Length`), an angle is
  `Radians`, shapes are `Point` / `Size` / `Bounds` / `Edges` / `Corners` of a unit. Public API never takes or returns a
  bare `f32` / `f64` for a length, an angle or a fraction; platform boundaries (taffy, the toolkits, JS decoding) convert.
  Enforced: nsh-core's `unit_types` test (and nsh-js's and nsh-engine's `public_api_is_typed`) fails on a bare float
  in public API that the crate's `unitless.txt` (unitless quantities, with reasons) or its shrinking `untyped.txt`
  (legacy, to migrate) does not list (`docs/dev/geometry.md`).
- TSX tags are PascalCase, everywhere (examples, docs, tests): every tag names a binding in scope, only `<If>` and
  `<Each>` are globals that need no import. Imports mirror the Rust crates' layers: every primitive comes from `nsh`
  (`View`, `Text`, `Scroll`, `Input`, `Overlay`, `Image`, `List`, `Canvas` and its classes, `WebView`, `Video`), as
  `nsh_core::ui::prelude` holds them, every base component from `nsh/base` (`Dialog`, `Button`, `NavStack`, ...), and
  `InputAccessoryView` from `nsh/ios`; the compiler makes their tags in place (`jsx::PRIMITIVES`). `nsh/image`,
  `nsh/list`, `nsh/canvas`, `nsh/webview` and `nsh/video`, where primitives were first, still export them (the same
  values, deprecated): new code imports them from `nsh`. Lowercase tags are compile errors: TypeScript checks a lowercase tag
  against one global type per name, so generic components (`List`, `Each`) and local ones would lose their types.
- Workspace lints: `missing_docs = warn`, `unreachable_pub = deny`, `private_interfaces = deny`. New crates must set `[lints] workspace = true`.
  They cover NSH's own Rust crates only: not the Java / Swift / TS sources, and never the apps built with NSH.
  - Every public API has a doc comment.
  - Items in private modules are `pub(crate)`, never `pub`.
- Everything is written in English: code comments, docs, logs and this file. Comments explain why, not what the code says.
- Colors in Rust are GPUI's: `Hsla` (`nsh_core::color`) is the color code holds, passes and computes with (theme
  colors, typed styles, props, every new signature: `impl Into<Hsla>` or `AdaptiveColor`), `Rgba` is only for
  conversions; the packed `Color` (`0xRRGGBBAA`) is only the storage and wire form (styles, mount items, the
  platforms) (`docs/dev/styles.md` "Colors").
- Library crates only log through the `log` facade (no `eprintln!`); performance logs use target `nsh::perf`, JS logs target `js`. Binaries install the logger.
  The CLI prints through `nsh-cli`'s `ui.rs` (steps, captured tools, `error` reports), xtask through `term.rs`.
- Dependencies are declared once in the root `Cargo.toml` `[workspace.dependencies]` (the GPUI backend's in `crates/gpui/Cargo.toml`); crates only write `.workspace = true`.
- Every `unsafe` block has a `// SAFETY:` comment.
- A crate's integration tests are one test binary (`tests/<name>/main.rs` with a module per area, as
  `nsh-engine/tests/engine/`), never a new `tests/*.rs`: each binary links its own copy of the bundler, QuickJS and
  the core (about 1 GiB of debug objects apiece).

## Public Rust structs

- New `pub struct` types use `#[non_exhaustive]` and implement `Default`, deriving it when possible.
- Set only the fields needed and leave the rest at their defaults. Within the defining crate, use `..Default::default()`; callers in other crates start with `Type::default()` and assign fields, because non-exhaustive structs cannot be constructed with external struct literals.
- New fields have sensible defaults so extending a struct does not break downstream construction.

## Commits and pull requests

Details and examples: "Commits and pull requests" in `CONTRIBUTING.md`.

- **All changes go through a pull request. Never push commits directly to `main`.** This includes code,
  documentation, release / version updates and CI / workflow fixes. Create a topic branch, push it and open a PR
  targeting `main`; merge through the PR after required checks pass. Do not use administrator bypass to skip this
  workflow. A request to release or push changes does not authorize a direct push to `main`.

- Subjects and PR titles are `<area>: <What the change does>`: the area in lower case (a crate without `nsh-`:
  `core`, `js`, `engine`, `bundler`, `cli`, `base`, ...; one platform: `ios`, `android`, `macos`, `windows`,
  `linux`; `desktop` for macOS, Windows and Linux together, `mobile` for iOS and Android together; `runtime`, a module;
  `tailwind`, `text`, `docs`, `examples`, `gallery`). One area only, never several separated by commas: for a change
  that spans parts, judge it as a whole and name the part it is mostly about (a feature the core adds and the platforms
  carry out is `core`); then an imperative sentence starting with a capital letter, no trailing period, about 72 characters in all. Say what it does for NSH's users, not which
  files changed. Never conventional prefixes (`fix:`, `feat:`); check `git log` and match it.
- The body explains why (wrapped at 72 columns); hot path changes include their before / after `nsh test --trace` numbers.
- One commit / PR does one thing; no unrelated refactors, cleanup or formatting.
- A PR that adds, changes or removes public API (Rust items, JS exports, elements, props, style keys, Tailwind
  utilities, `nsh.json` keys, CLI flags, SDK APIs) lists every item under `## Public API` with its signature and one
  line on its purpose; changes to existing items also go under `## Breaking Changes` with `diff` blocks
  (`.github/pull_request_template.md`).
- A PR review presents, in order: the PR's purpose (the problem and the scope of the changes), whether the requirement
  and approach are reasonable, then concrete findings, the validation performed and its limits.

## Performance rules (the project's first priority)

1. **QuickJS is the slowest link: JS does as little as possible.** Only the app's code is JS: the reactive graph, the renderer and
   the modules are native, and compiled JSX calls them directly. Parsing, diffing and string processing all happen in Rust. No JSON
   serialization on the JS side.
2. **Cross threads in batches.** One JS turn → its ops queued natively (`Shared.ops`) → one `Core::commit` → one `MountBatch` → one
   main-thread hop. Never cross FFI or threads per item.
3. **No needless allocation on hot paths.** Node ids are dense: index `Vec`s (`slots`), not hash maps. Internal links use slab keys. Reuse
   buffers (`take_ops`, `queue`).
4. **Do not send mount items that are not needed.** New views get no default style and no empty event mask; unchanged styles and frames are not
   sent. Check item counts with `nsh test --trace`.
5. **Text**: measurements are cached per constraint (`TextContext.cache`); platforms cache font objects (`FontCache`).
6. **Changes to hot paths come with before / after `nsh test --trace` timings and item counts**, compared with the baselines
   in `docs/dev/performance.md` (update them when they move).

## CI

Each workflow runs only when what it builds changes: the Rust workflows list their crates one by one in `paths`,
derived from the dependency graph. A new crate, a new path dependency or a new workflow updates those lists
(`python3 .github/ci/paths.py --print`); the `CI paths` workflow fails when a list misses a crate its workflow builds.
It runs on every pull request: its `check` job is the status check main requires, so a pull request no other workflow
reports `check` for (one touching only `crates/gpui`) can still merge. The Compat workflow's `compat` job is required
too, so it also runs on every pull request, and its `dorny/paths-filter` step (held to the graph by `paths.py` the same
way) decides whether it builds and checks or passes at once.
Every pull-request workflow also handles `merge_group: checks_requested`, so GitHub's merge queue tests the
combined commit. Queue runs execute the full workflow without PR path filters; Compat always builds on a queue
run. Website deployment runs only on pushes and manual dispatches. `.github/ci/paths.py` checks the queue
trigger alongside the dependency paths.
CI builds without incremental state or debug info, caches dependencies only (`Swatinem/rust-cache`, saved by `main`,
restored by pull requests) and ignores the toolchain file's mobile targets (`RUSTUP_TOOLCHAIN=stable`) except in the
release. Files a crate reads from outside its directory (`include_bytes!`, test fixtures) go into its workflows'
`files` in `paths.py`.

## Parallel agents

Subagents and teammates never run `cargo build`, `cargo test`, `cargo clippy`, `cargo xtask` or `nsh test` (several
at once overload the machine); at most an occasional `cargo check -p <crate>` for compile errors. They write the
code and its tests and report which tests to run; the main session runs builds and tests itself, one at a time.

## Review and parallel workspaces

For PR reviews and work involving multiple agents, **consider LayerFS before creating a Git worktree**. When
isolated workspaces are needed and the workload fits the available Linux environment, prefer separate LayerFS
branches and mounted Workspaces from the same committed input. Give each agent its own Workspace; reuse a warm
snapshot only when its OS, architecture, toolchain and dependencies match the task.

Reuse an existing prepared LayerFS deployment first. Start with `./scripts/layerfs status` and follow
`docs/dev/layerfs.md`; use `./scripts/layerfs prepare` when setup is needed. The script's `prepare`, `smoke` and
`status` commands prepare and validate the deployment. Create agent
branches and mount Workspaces through the pinned LayerFS SDK described in that guide; a smoke run is a validation
trial, not an agent's development Workspace. Keep source changes in Git and submit them through pull requests.

Use a Git worktree when a concrete constraint makes LayerFS unsuitable, such as an unavailable Docker/FUSE
environment or a task requiring native macOS, iOS or Windows tooling. State the reason briefly and proceed without
an extra approval checkpoint. Read-only reviews that need no isolated workspace can inspect the checkout or Git
objects directly. Preserve the existing parallel-agent build and test limits whichever workspace mechanism is used.

## Verification after changes

1. `cargo test --workspace`, plus fmt and clippy as listed above (including the Catalyst target, the macOS crates, `cargo xtask clippy-android`, on Linux the Linux crates, on Windows the Windows crates; for changes in `crates/gpui` or to what it uses, its own tests and clippy there).
2. Changes to the runtime (`nsh-js`), engine or core: run `nsh test --trace` and check item counts and timings. Changes to
   anything apps use: `cargo xtask compat` passes, and `tests/compat/` checks the change (`docs/dev/compatibility.md`).
3. Changes to the platform layer: launch with `nsh run`, check screenshots and simulate input where needed (the terminal needs the Screen
   Recording and Accessibility permissions; while the screen is locked the frontmost app is `loginwindow` and clicks fail, but window
   screenshots still work). iOS simulator: `xcrun simctl io booted screenshot`, `xcrun simctl ui booted appearance dark`.
   Android: `adb exec-out screencap -p`, `adb shell input tap|swipe|text|keyevent` (all work with the screen locked).
   The desktops: `nsh test <entry> --target macos|linux|windows|gpui` with steps on standard input
   (`await app.screenshot("a.png"); await app.press("label:Plan")`) opens the app in the platform's window, acts with
   its input at the views the selectors name and takes screenshots, without touching the screen; the app's tests run
   there the same way (`docs/dev/tooling.md` "On a real platform"). Linux: under Xvfb (`xvfb-run -a`) on a machine
   without a display (`docs/dev/linux.md`). GPUI on Linux: on a rootful Xwayland display of its own started with
   `-shm` (`DISPLAY=:N`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` for web views); screenshots are read from the X server
   (`docs/dev/gpui.md`).
   Terminal: `nsh-tui-host --bundle … --size 120x40 --script "wait 300; shot screen.txt; key Tab; type 你好; quit"`
   renders in memory and saves UTF-8 text; coordinates and resize dimensions use cells (`docs/dev/tui.md`).
