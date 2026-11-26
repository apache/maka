---
title: Comparing approaches
description: "For Electron, Tauri, React Native, Flutter, GPUI, Qt and Slint teams: where Native Shell comes from, how it compares in capabilities and measured numbers, what moving gains and costs, how to run a pilot, and how it compares with web views and server-driven UI for UI delivered after release."
order: 2
group: start
---

# Comparing approaches

NSH is a framework for whole apps on iOS, Android, macOS, Windows, Linux and the web, and a runtime for UI delivered to apps after release. This page compares it first with the cross-platform frameworks people write apps in, then with the ways apps take UI they did not ship with. Green means the capability is available, yellow that it needs more of the app's own work or a separate project, and red that it is not provided; the marks describe availability, not performance. Versions are each framework's documented minimums at the time of writing: check them for the release you use.

This page is written for teams on Electron, Tauri, React Native, Flutter, GPUI, Qt or Slint: where NSH comes from, what each cell of the comparison rests on, the challenge NSH puts to each framework, what moving to NSH gains and costs, and when another option fits better.

**Native UI, a web-style developer experience, Rust performance, low resource use, and one framework for desktop, mobile, web and terminal.**

Cross-platform UI frameworks have long faced the same trade-off: developer experience, native interaction, platform reach, performance or resource use — which comes first? Electron chose the browser; Tauri kept web UI but switched to the system web view; React Native brought React to native views; Flutter traded for consistency with its own renderer; GPUI gives desktop apps high-performance UI with Rust and the GPU; Qt built a mature system for professional desktop and embedded software; Slint keeps pushing lightweight, embedded and declarative UI. Each has real strengths and clear architectural trade-offs. **The question NSH sets out to answer: can developers stop having to pick one of these needs over the others?**

## Where NSH comes from

[Longbridge](https://longbridge.com) needed a desktop client first. To get away from what Electron costs on the desktop — high memory, slow start, unsteady frame rates, a loose fit with the system — Longbridge built [Longbridge Pro](https://longbridge.com/desktop) on [GPUI](https://gpui-kit.com), the Rust GPU UI framework behind the [Zed](https://zed.dev) editor, and grew the [GPUI Kit](https://gpui-kit.com) components and the [GPUI Fast](https://github.com/longbridge/gpui-fast) fork on top of it. A trading client is demanding: high-frequency quotes, order books, candlesticks and linked charts stay open for hours without dropping frames or holding the CPU, and the desktop needs dependable windows, text input and system integration.

NSH started as a plugin layer for the mobile clients (the idea of [GPUI Shell](https://gpui-kit.com/shell), taken to phones) and then carried the same app model — components, signals, layout, modules — to iOS, Android, macOS, Windows, Linux and the web ([Introduction](./index.md#native-shell-and-gpui-shell)). So:

- **The desktop is not an add-on.** macOS (AppKit), Windows (Win32 with Direct2D) and Linux (GTK 4) are backends of the same framework as phones and the web, built from one repository, tested by one suite and shipped in one release.
- **Performance is a constraint of the architecture, not a later pass.** The renderer, layout, animation and list virtualization run in Rust; Rust apps link no JavaScript engine, and in TSX apps the main thread never waits on JS ([Architecture](./architecture.md)).
- **Delivered UI was required to be safe from day one.** A plugin layer runs code someone else wrote, so signed packages, revocation lists, a sandboxed virtual machine and capability grants were design goals from the start ([Signed packages](./signed-packages.md), [Sandbox and capabilities](./sandbox-and-capabilities.md)).

Legend: <span class="status status--yes" role="img" aria-label="Yes"></span> Yes · <span class="status status--partial" role="img" aria-label="Partial"></span> Partial · <span class="status status--no" role="img" aria-label="No"></span> No.

## Cross-platform frameworks

| Capability | NSH | Electron | React Native | Flutter | Qt 6 | GPUI / GPUI Fast | Slint |
|---|---|---|---|---|---|---|---|
| **Platforms** | | | | | | | |
| iOS | <span class="status status--yes" role="img" aria-label="Yes"></span> 15+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> 15.1+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 15+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 17+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Rust |
| Android | <span class="status status--yes" role="img" aria-label="Yes"></span> 9+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> 7+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 7+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 9+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| macOS | <span class="status status--yes" role="img" aria-label="Yes"></span> 14+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 12+ | <span class="status status--partial" role="img" aria-label="Partial"></span> Separate project | <span class="status status--yes" role="img" aria-label="Yes"></span> 12+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 13+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 12+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 13+ |
| Windows | <span class="status status--yes" role="img" aria-label="Yes"></span> 10 1809+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ | <span class="status status--partial" role="img" aria-label="Partial"></span> Separate project | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10 1809+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ |
| Linux | <span class="status status--yes" role="img" aria-label="Yes"></span> GTK 4.14+ | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Vulkan | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| Web | <span class="status status--yes" role="img" aria-label="Yes"></span> HTML | <span class="status status--partial" role="img" aria-label="Partial"></span> Separate web app | <span class="status status--partial" role="img" aria-label="Partial"></span> Library | <span class="status status--yes" role="img" aria-label="Yes"></span> Canvas | <span class="status status--yes" role="img" aria-label="Yes"></span> Canvas | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Canvas |
| Terminal (TUI) | <span class="status status--yes" role="img" aria-label="Yes"></span> ratatui | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> |
| **Rendering and runtime** | | | | | | | |
| Drawn by | Platform UI | Chromium | Platform views | Own engine | Own (Widgets, Quick) | Own, GPU | Own renderer |
| Update model | Fine-grained signals, retained views | Web framework on the DOM | React re-render and diff | Widget rebuild and diff | Property bindings | Rebuilt every frame; Fast reuses unchanged views | Property bindings |
| Where layout, animation, lists run | Rust | JS and Chromium | Yoga (C++), list logic in JS | Dart | C++ | Rust | Rust |
| App language | Rust, TSX | JS, TS | JS, TS | Dart | C++, QML, Python | Rust | Slint + Rust, C++, JS, Python |
| No JS runtime | <span class="status status--yes" role="img" aria-label="Yes"></span> Rust apps | <span class="status status--no" role="img" aria-label="No"></span> Node + Chromium | <span class="status status--no" role="img" aria-label="No"></span> Hermes | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> C++ Widgets | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| **Text, input and accessibility** | | | | | | | |
| System text editing | <span class="status status--yes" role="img" aria-label="Yes"></span> Platform editors | <span class="status status--partial" role="img" aria-label="Partial"></span> Chromium's | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Own | <span class="status status--partial" role="img" aria-label="Partial"></span> Own | <span class="status status--partial" role="img" aria-label="Partial"></span> Own | <span class="status status--partial" role="img" aria-label="Partial"></span> Own |
| System accessibility tree | <span class="status status--yes" role="img" aria-label="Yes"></span> Native views | <span class="status status--yes" role="img" aria-label="Yes"></span> Chromium | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Semantics tree | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Limited | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| Per-device interaction | <span class="status status--yes" role="img" aria-label="Yes"></span> Built into base components | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| **Desktop and embedding** | | | | | | | |
| Windows, menus, tray | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Separate projects | <span class="status status--partial" role="img" aria-label="Partial"></span> Plugins | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> No tray | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| Embed in an existing native app | <span class="status status--yes" role="img" aria-label="Yes"></span> One view | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Brownfield | <span class="status status--yes" role="img" aria-label="Yes"></span> Add-to-app | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| Embed in a GPUI app | <span class="status status--yes" role="img" aria-label="Yes"></span> GPUI backend | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Native | <span class="status status--no" role="img" aria-label="No"></span> |
| **Tooling and delivery** | | | | | | | |
| Toolchain | One nsh executable, no Node | Node, npm, packager | Node, Metro, CocoaPods, Gradle | flutter CLI, Xcode, Gradle | CMake, Qt Creator | cargo | cargo, CMake |
| Hot reload | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Fast Refresh | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> QML | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Live preview |
| Signed, sandboxed delivered UI | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> OTA of trusted code | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Loads QML | <span class="status status--partial" role="img" aria-label="Partial"></span> GPUI Shell | <span class="status status--no" role="img" aria-label="No"></span> |
| License | Apache-2.0 | MIT | MIT | BSD-3-Clause | LGPL, GPL, commercial | Apache-2.0 | GPL, royalty-free, commercial |

GPUI and GPUI Fast share a column: they run on the same platforms, and GPUI Fast adds retained rendering on top of GPUI. "GPUI Shell" is [GPUI Shell](https://gpui-kit.com/shell).

Read down the NSH column: it is the only one green in every group. In particular, no other framework here combines

- **seven targets from one app** — iOS, Android, macOS, Windows, Linux, the web as HTML, and terminals — in one repository and one release;
- **the platform's own views, text editors and accessibility tree** with **no JavaScript runtime** for Rust apps;
- **interaction that adapts per device inside the base components**, instead of in each app;
- **embedding as a single view** into existing iOS, Android, desktop and GPUI apps;
- **signed, sandboxed UI delivered after release**, with revocation and rollback;
- **one executable for the whole toolchain**.

### What the rows mean

- **Electron.** Chromium plus Node in every app: the desktop's widest web-content path, with no phones. Minimums follow [Electron's supported platforms](https://www.electronjs.org/docs/latest/tutorial/support#supported-platforms); its web version is the same code deployed as a separate site.
- **Drawn by, update model.** NSH mounts each platform's own views and keeps them (retained mode): a change updates only the views it touched. React Native also mounts platform views, on iOS and Android. Flutter, Qt Quick, GPUI and Slint draw with their own renderers; GPUI builds the element tree each frame (immediate mode), and [GPUI Fast](https://github.com/longbridge/gpui-fast) reuses what did not change.
- **Platforms.** NSH's minimums are its own ([Platforms](./platforms.md)). The others come from [React Native 0.76](https://reactnative.dev/blog/2024/10/23/release-0.76-new-architecture) (iOS 15.1, Android 7 / API 24; macOS and Windows through the separate react-native-macos and react-native-windows projects, the web through the react-native-web library), [Flutter 3.47](https://docs.flutter.dev/reference/supported-platforms), [Qt 6.10](https://doc.qt.io/qt-6.10/supported-platforms.html), [Zed's requirements](https://zed.dev/docs/installation) for GPUI, and [Slint's platform guides](https://docs.slint.dev/latest/docs/slint/guide/platforms/mobile/general/) (iOS from Rust). "Canvas" means the framework draws into a canvas on the page; NSH's web apps are HTML elements styled with CSS, which the browser scrolls, selects and edits ([Web](./web.md)). Layout is computed in Rust by Taffy; it is not full browser CSS layout.
- **System text.** NSH's text fields are the platform's editors — `UITextView`, `EditText`, `NSTextView`, GTK's `TextView`, the browser's — with the system's input methods, selection handles and editing menus; on Windows, NSH's own editor works with DirectWrite and the system's input methods (IMM32). React Native also uses the platform's text inputs. The self-drawn frameworks implement text editing themselves and connect it to the system's input methods.
- **Per-device UX.** NSH's base components follow the device: the same `Menu` is a popup at its trigger with a pointer and a sheet from the bottom on a phone, and a `ContextMenu` opens on a right click or a held finger. In the others, adapting interaction per device is mostly the app's own work.
- **Where layout, animation and lists run.** In NSH they run in Rust off the JavaScript path: a busy TSX handler does not stall scrolling or an animation ([Architecture](./architecture.md)). React Native lays out with Yoga in C++ while list windowing and most animation logic stay in JS unless a library moves them.
- **Accessibility.** NSH's elements are native views, so VoiceOver, TalkBack and the desktop screen readers read the real hierarchy; apps add labels, roles and actions ([Accessibility](./accessibility.md)). GPUI exposes little to assistive technology today.
- **Windows, menus, tray.** `nsh/desktop` provides windows, menus, the tray and Dock badges on macOS, Windows and Linux ([nsh/desktop](../modules/nsh-desktop.md)). GPUI has windows and menus but no tray; Flutter takes them from plugins.
- **Embedding.** An NSH app embeds as one view in an existing iOS, Android or desktop app ([Embedding](./embedding.md)), and as a view in GPUI and GPUI Kit apps through its GPUI backend ([GPUI](./gpui.md)). React Native (brownfield) and Flutter (add-to-app) also embed, each bringing its own runtime.
- **Terminal.** The same component model renders terminal apps through ratatui ([TUI](./tui.md)).
- **Toolchain, hot reload.** One `nsh` executable creates, runs with hot reload, tests on real platforms, packages and signs for every target, and TSX needs no Node or npm ([CLI](./cli.md)).
- **Native engine, thin script.** In a TSX app only the app's own code is JavaScript; the reactive graph, layout, rendering and modules are Rust, and a Rust app's runners link no JavaScript engine on any platform. Qt Quick's QML runs on Qt's JavaScript engine; Qt Widgets in C++ do not.
- **Signed delivery.** NSH verifies signed `.nshpkg` packages against the keys it trusts and a revocation list, and runs each in a VM with the limits and capabilities the host grants ([Signed packages](./signed-packages.md), [Sandbox and capabilities](./sandbox-and-capabilities.md)). A packaged NSH app takes its own TSX over the air the same way, iOS and Android included, and rolls back a release that fails to start ([OTA Updates](./ota-updates.md)). React Native's over-the-air updates ship trusted app code; Qt can load QML files; GPUI apps take JavaScript modules through [GPUI Shell](https://gpui-kit.com/shell).

### What sets NSH apart

- **Native on every platform, in both senses.** Each backend builds on its platform's own views, text and input methods — UIKit, Android views, AppKit, Win32 with Direct2D, GTK 4, HTML — and each platform's interaction comes with them. Text selection, input methods and accessibility are the system's, and what a new OS release brings to them reaches the app ([Introduction](./index.md#what-native-means)).
- **Phones, desktops and the web from one app.** Six platforms are backends of one framework, sharing one reactive graph, renderer, Taffy layout and module system, with layouts that reshape and input that follows the device; on the web, the app is HTML, published as a static site.
- **Rust first, with apps in TSX.** The engine is Rust, compiled to native code. Apps are written in TSX with hot updates, and only their own code is JavaScript. Rust [nshm](./nshm.md), the app's own or published, give the TSX native components and modules where speed, the platform or crates.io are needed, and a whole app can be Rust from start to end, with no JavaScript runtime ([Building with Rust](./rust.md)).
- **Retained views for everyday apps.** Components run once and fine-grained signals send only the properties that changed, so chats, forms, lists and documents sit near idle at rest ([Introduction](./index.md#retained-views), [Reactivity](./reactivity.md)).
- **UI delivered after release, signed and sandboxed.** Apps built with NSH — and native apps written with each platform's own tools — take TSX modules at run time, written by a team or generated by AI ([Dynamic UI](./index.md#dynamic-ui-and-ai-generated-ui)).
- **One toolchain, for people and agents.** One `nsh` executable creates, runs, hot-reloads, tests on real platforms, packages and signs apps for every target; TSX needs no Node or npm ([CLI](./cli.md), [Installation](./installation.md)).

### Components for professional applications

Consider a research workstation. A trader selects cells while quotes arrive, reads a report as it streams in, and moves a panel while editing a note. Each interaction needs a durable implementation. NSH carries the layering developed in GPUI Kit across its hosts. [NSH Base](../modules/nsh-base.md) owns behavior, state, focus and accessibility. Product teams build their visual language above it and can use the same interaction conventions across applications.

| Base component | What an application can reuse |
|---|---|
| [DataTable](../elements/data-table.md) | Virtualization on both axes creates only visible cells. A quote grid can combine pinned columns, paged data and keyboard selection. |
| [Editor](../elements/editor.md) | Visible rows and incremental highlighting limit work after an edit. A strategy editor can reuse multiple carets, folding, diagnostics and find-and-replace. |
| [TextView](../elements/text-view.md) | Rust parses streamed Markdown into text and views, including tables, code and links, so a research assistant can render a reply as it arrives. |
| [RichEditor](../elements/rich-editor.md) | A schema constrains document structure and transactions record edits. Teams can add mentions or commands while retaining edit history. |
| [DiffView](../elements/diff-view.md) | Render a patch or compare two texts with aligned or unified views, word-level highlights and review annotations. |
| [Dock](../elements/dock.md) | The component handles splitting, resizing and moving tabs. Panels retain their content when moved and the app owns the layout data. |

These choices affect performance, stability and extensibility in different ways. The grid bounds cell creation, the document schema keeps edits valid, and moving a tab preserves its content. Apps can supply cells, document types and panels while reusing scrolling, undo and drag behavior. The quote workload below measures runtime performance; the linked component examples demonstrate the individual behaviors.

### Measured numbers

These come from the [performance report](./performance-report.md) and the [NSH performance benchmark](https://github.com/longbridge/nsh-perf-bench), all release builds; reproduce them on your own devices with `nsh`'s trace ([Measuring an app](./performance-report.md#measuring-an-app)).

| Measurement | Result |
|---|---|
| Engine start | ~75–155 µs |
| Counter app first frame (Mac Catalyst) | ~1.05–1.15 ms |
| One tap (JS plus commit) | ~0.12 ms |
| Rust app memory on macOS | ~19 MB, against ~17 MB for an AppKit window with one label |
| Sorting 100,000 rows in a Rust module called from TSX | ~3 ms, on par with pure Rust |
| 500-row quote table, 1,000 updates a second (Linux) | NSH Rust 18% of one core, GPUI Fast 20% |
| Stocks demo: 22 live sparklines, intraday chart, order book, trades (Linux) | 117–120 FPS, 25–29% CPU |

## Challenging the mainstream UI frameworks

Each section below puts a question to one framework: what it does well, where it costs, how NSH handles the same problem, and what carries over or costs when moving. For performance data, see the [measured numbers](#measured-numbers) above.

> This compares architectural choices and fit for typical apps; it does not claim any framework loses under every workload. Performance numbers come from NSH's own tests or development experience, and are a strict cross-framework benchmark only when device, app, workload and measurement method are the same.

## Challenging Electron: why ship a whole browser to build a native app?

Electron's success is beyond question: HTML, CSS, JavaScript, React and the web ecosystem made desktop development very productive. Its costs are just as clear.


**Electron apps bundle Chromium and Node.js.** Electron "inherits its multi-process architecture from Chromium": every app has a Node.js main process and spawns "a separate renderer process for each open `BrowserWindow`" ([Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)). Every Electron app therefore carries its own copy of Chromium and Node.js.

Where that hurts:

- **Size and memory.** A browser engine and a JavaScript runtime come with every app and every window, before the app draws anything. In practice a typical Electron app starts at an installer of around 150 MB and often uses 1 GB of memory or more once in use (typical figures from experience, not a benchmark); a desktop with several Electron apps runs several browsers. For comparison, NSH's measured Linux packages are 9.7–11.7 MB archives (hello worlds, and real apps such as sysmon and Omasend), and a Rust app on macOS uses ~19 MB of memory ([App size](./performance-report.md#app-size)).
- **Memory can grow after a tab closes.** Suppose a global quote feed still holds a callback for a closed panel. If the callback references a detached DOM node, the garbage collector can see a path to it and the whole subtree can stay alive. Reopening and closing the panel can accumulate old views and callbacks that still run on every tick. Both memory use and input latency can grow over a long session. [Chrome DevTools memory guide](https://developer.chrome.com/docs/devtools/memory-problems)
- **Start-up.** The app waits for Chromium and Node.js to start, then for its JavaScript to load, parse and run, before the first frame.
- **Steady-state CPU.** Live data updates the DOM, which goes through style recalculation, layout and painting in the page; long lists and frequent updates are exactly what web pages handle worst.
- **The page is not the system.** Text fields, selection, context menus, scrolling and accessibility are the browser's implementations inside a window, not the operating system's controls. Native menus, dialogs and tray icons exist, but only through the main process, across an IPC boundary from the UI.
- **No phones.** Electron is desktop only; a mobile client is a second project.
- **Security is the app's job.** Renderers can be given Node.js access, and Electron's own security checklist (context isolation, sandboxing, no remote content with Node integration) is something every app has to follow correctly.

How NSH answers:

| Electron's cost | NSH |
|---|---|
| Chromium + Node.js in every app | No browser engine. Rust apps link no JavaScript engine at all; TSX apps run app code in QuickJS while rendering, layout and animation run in Rust ([Architecture](./architecture.md)) |
| ~150 MB installers, often 1 GB+ memory (typical) | 9.7–11.7 MB Linux archives for hello worlds, sysmon and Omasend ([App size](./performance-report.md#app-size)); ~19 MB for a Rust app on macOS, against ~17 MB for an AppKit window with one label ([Performance report](./performance-report.md)) |
| Detached DOM retained after closing a panel | Native NSH controls run on the Rust runtime and create no DOM subtree to retain. Pure Rust apps also avoid JS garbage collection. TSX apps still need to release callbacks held by application code. |
| Slow start | Engine start ~75–155 µs; counter app first frame ~1.05–1.15 ms |
| DOM layout under live data | Fine-grained signals push only the properties that changed to platform views; a 500-row quote table at 1,000 updates a second uses 18% of one core on Linux |
| Browser text, menus and accessibility | AppKit, Win32 + Direct2D and GTK 4 controls, input methods and accessibility ([Introduction](./index.md#what-native-means)) |
| Desktop only | The same app on iOS, Android and the web ([Platforms](./platforms.md)) |
| App-managed security | Delivered UI runs in a sandboxed VM with host-granted capabilities and signed, revocable packages ([Sandbox and capabilities](./sandbox-and-capabilities.md)) |

**What carries over.** TSX reads like JSX and styling reads like CSS and [Tailwind](./tailwind.md), so most of a web team's experience applies; an existing page can still be shown in a [web view](./web-view-and-video.md). **What it costs.** DOM code and npm component libraries that depend on a browser do not carry over; screens are rewritten with NSH elements.

Chat and AI apps gain the most. Many AI products render their conversations as web pages, and long sessions bring dropped frames while scrolling, awkward input methods and selection, and weak integration with system accessibility and gestures. NSH renders rich text, code blocks, tables, images and streamed output with the platform's text views and editors ([Text](./text.md), [Lists](./lists.md)).

For a multi-pane review tool, inventory the web grid, docking library and diff renderer separately. Map them to DataTable, Dock and DiffView, then port custom cells and review actions. Existing DOM widgets need replacement or an embedded web view.

**The challenge: The Web development experience. Without the browser.**

## Challenging Tauri: Chromium is gone, so why is the UI still a web view?

Tauri's system web view and Rust backend changed Electron's runtime cost structure, and suit teams that already have a web app and want a light desktop or mobile client quickly. The UI is still a web page.


**Tauri uses the system webview.** Tauri avoids bundling Chromium by using whatever the OS provides: WebView2 (Chromium) on Windows, WKWebView (WebKit) on macOS and iOS, `webkit2gtk` (WebKit) on Linux, and the device's Android WebView ([Tauri webview versions](https://v2.tauri.app/reference/webview-versions/)). Apps get smaller; the UI is still a web page.

Where that hurts:

- **Three engines, many versions.** The same app runs on Chromium on Windows and Android and on WebKit on Apple platforms and Linux. Tauri's own reference notes that on Android "the runtime version depends on the device's currently selected WebView provider", that "unsupported macOS versions **do not** receive WebKit updates", and that on Linux "it is very hard to compile accurate information about WebKitGTK on the various distros" ([source](https://v2.tauri.app/reference/webview-versions/)). Rendering bugs and missing web features are tested per engine and per OS version.
- **Still a page.** Text, scrolling, selection and accessibility are the web view's, not the system's controls; performance under live data is the DOM's.
- **A Rust backend cannot release references inside the page.** For example, after navigating away from a chart, a timer in the WebView can keep the old chart and its price history alive through a closure. Leaving one timer behind on each visit accumulates both memory and background redraw work. Even after the Rust backend releases its resources, the page still needs to cancel the timer and release its references. [Tauri process model](https://v2.tauri.app/concept/process-model/)
- **Two languages across a bridge.** UI in JavaScript, logic in Rust, joined by IPC calls and serialization.

How NSH answers: the UI is the platform's own views, the same on every OS version the platform supports, with no web engine in between; TSX and Rust run in one process on one reactive graph, and a TSX screen calls a Rust module directly — sorting 100,000 rows from TSX takes ~3 ms, on par with pure Rust ([Performance report](./performance-report.md)). Tauri's best idea — Rust for the core — is NSH's default, and Rust is the core of the whole UI rather than a backend: heavy computation, file indexing, audio and video processing and OS APIs come in as [nshm](./nshm.md) modules. When an app needs to show a real web page, NSH still embeds a [web view](./web-view-and-video.md) without turning the whole app into one.

**What it costs.** An existing web UI is rewritten with NSH elements. If the goal is to wrap an existing website as a client as quickly as possible, Tauri's reuse still wins; NSH fits products that want a native UI from the start.

On native NSH targets, a chart can draw into a native Canvas and tie its update logic to a reactive scope. Disposing the scope tears down its owned computations and runs registered cleanup callbacks. Application-created timers and external quote subscriptions still need cancellation handlers. A screen that embeds a WebView still manages browser resources inside that view. [Reactive runtime implementation](https://github.com/longbridge/nsh/blob/d2c6e800dac5985c112e61626b89e30ace2d2f83/crates/nsh-core/src/reactive.rs#L1169)

A Rust backend can keep producing report data. Replace a Markdown web panel with TextView first, then check links, tables and streamed updates using the same documents on each target.

**The challenge: Rust at the core. Native UI, not a WebView.**

## Challenging React Native: a native framework, so why are desktop, mobile and web still separate?

React Native is one of NSH's most direct competitors. It proved that TypeScript/JavaScript and native platform views fit together well, and its iOS and Android ecosystem is mature. The issue is not that it is not native enough; it is how its platforms are organized and its default update model.


**React Native drives native views from JavaScript.** React Native is closest to NSH in intent: both aim to cut duplicated client work and both use platform views. But app logic and React reconciliation always run in a JavaScript engine, and the New Architecture (Fabric, TurboModules, JSI) makes the bridge faster without changing that ([React Native architecture](https://reactnative.dev/architecture/landing-page)).

Where that hurts:

- **The JS thread is the frame budget.** React Native's own performance guide treats a JavaScript thread that is busy for a frame as a dropped frame ([Performance](https://reactnative.dev/docs/performance)). Every state change re-renders components and diffs the result in JavaScript, so frequent updates — quotes, chat streams, timers — compete with input handling on that thread. Teams fight it with `memo`, `useMemo`, `useCallback` and dependency arrays.
- **Desktop and web are other people's projects.** macOS and Windows are `react-native-macos` and `react-native-windows`, maintained by Microsoft; the web is the community `react-native-web`; there is no Linux platform except through the community React Native Skia renderer ([Out-of-tree platforms](https://reactnative.dev/docs/out-of-tree-platforms)). Each has its own release train, gaps and lag behind the core.
- **The app owns per-device behavior.** A phone and a desktop need different menus, hover, keyboard and pointer behavior; React Native's components leave that to the app.
- **Over-the-air updates are trusted code.** Code-push style updates replace the app's own JavaScript; there is no sandbox for code written by someone else.
- **A long toolchain.** Node, npm, Metro, CocoaPods, Gradle and native build tools, each with its own versions to keep aligned.

How NSH answers:

| | React Native | NSH |
|---|---|---|
| Runtime | Always a JS engine (Hermes), with app logic and reconciliation in JS | Rust apps have no JS engine; TSX apps run only app code on QuickJS, while the reactive graph, renderer, layout, animation and list virtualization run in Rust |
| Update model | Re-render after a state change, then diff | Fine-grained signals (Solid-style): components run once and push only changed properties; no memoization, no dependency arrays ([Reactivity](./reactivity.md)) |
| One tap | — | ~0.12 ms, JS plus commit ([Performance report](./performance-report.md)) |
| Desktop | Separate Microsoft-maintained projects, no Linux | AppKit, Win32 + Direct2D and GTK 4, in the same framework, tests and release as phones |
| Web | Community react-native-web | A framework backend producing HTML and CSS |
| Per-device UX | Left to the app | Base components adapt: `Menu` pops at the pointer on desktop and rises from the bottom on phones |
| Heavy computation | Native module plus bridge code | Write it in Rust in the same app and call it from TSX: 100,000 rows sorted in ~3 ms |
| Updates after release | OTA delivery of a trusted JS bundle | Signed `.nshpkg`, revocation lists, a sandboxed VM with host-set capabilities and limits, automatic rollback of versions that fail to start ([OTA Updates](./ota-updates.md)) |
| Toolchain | Node, Metro, CocoaPods, Gradle and more | One `nsh` executable; TSX needs no Node or npm ([CLI](./cli.md)) |

Fabric, JSI, TurboModules and Reanimated have removed many bottlenecks, and React Native can reach Rust through native modules. The difference is not that only NSH can call Rust, but where Rust sits: an NSH app can be written entirely in Rust with no JavaScript VM, and a TSX app's reactive graph, scheduling and mount batches run in Rust too. For a product that needs professional desktop windows, live quote tables, phones and an HTML web build at once, these are official backends of one framework rather than several projects stitched together.

**What carries over.** TSX looks much like JSX, and components, props and events stay; hooks become signals. **What it costs.** NSH is not a compatibility layer for React Native, by design: it replaces React reconciliation with a more efficient model, so React Native packages do not run on it. The framework provides lists, navigation, animation, gestures, text, canvas, web views and video natively, visual components are the app's own ([Design guides](./design-guides.md)), and an existing native SDK becomes a [native component](./native-components.md) or a Rust [module](./platform-extensions.md).

The [core component catalog](https://reactnative.dev/docs/components-and-apis) includes lists and text inputs. A virtualized two-axis quote grid with pinned columns, or a schema-driven editor with undo, requires additional choices. With NSH the starting points are DataTable and RichEditor. Port the data source, document schema and product styling, and test selection and undo on the target devices.

**The challenge: Beyond React Native. One framework for desktop, mobile, and Web.**

## Challenging Flutter: why reimplement UI the operating system already does well?

Flutter draws with its own engine for highly controllable, consistent visuals across platforms — a strength, especially for heavily customized UI. Drawing everything also means the framework has to adapt many system behaviours itself.


**Flutter draws widgets with its own rendering engine.** Flutter renders the whole UI itself, so an app looks the same everywhere — and none of it is the platform's.

Where that hurts:

- **Text and input are reimplemented.** Text editing, input methods, the selection menu, focus, keyboard navigation and accessibility semantics are Flutter's reimplementation of each platform's behavior. Flutter has mature implementations of all of them; the question is who maintains them over time, since what a new OS release brings waits for Flutter to rebuild it.
- **Native views are expensive guests.** Flutter's own documentation says "platform views in Flutter come with performance trade-offs": with hybrid composition on Android, Flutter "merges the raster thread into the platform thread", "potentially causing lower application FPS and frame drops"; the texture-layer mode may cause "jankiness on quick scrolling (such as a web view)" and "broken accessibility for `SurfaceView`s" ([Hosting native Android views](https://docs.flutter.dev/platform-integration/android/platform-views)). Maps, web views, video and payment SDKs are exactly these views.
- **The web is not the web.** Flutter "is not suitable for static websites with text-rich flow-based content", and its output "doesn't align with what search engines need to properly index"; the Flutter team itself recommends Jaspr or plain HTML for document-like content, and moved its own docs to Jaspr ([Flutter web FAQ](https://docs.flutter.dev/platform-integration/web/faq)).
- **Dart only.** Logic and UI are Dart; systems code and existing native libraries go through platform channels or FFI.

How NSH answers: each backend is the platform's own views — UIKit, Android views, AppKit, Win32, GTK 4 — so a map or web view is just another view in the tree, not a composited guest; text editing, input methods, selection and accessibility are the system's ([Introduction](./index.md#what-native-means)); the web build is real HTML that can be selected, indexed and read by screen readers, with semantic markup, links and ARIA; and the languages are Rust, with its crates and native threads, plus TSX for quick screens. **What it costs.** Apps can share branded styles across platforms. System fonts and materials can still render differently on each platform. On Windows some controls are drawn by NSH with Direct2D, so evaluate them control by control; on the web, layout is computed by Taffy and is not full browser CSS layout.

Flutter already offers tables and text fields. For a code-review screen, compare the work above those widgets: Editor supplies diagnostics and folding, and DiffView supplies aligned hunks and annotations. Dart widget implementations still need porting.

**The challenge: Why recreate what the operating system already does best?**

## Challenging GPUI: high-performance UI, so why keep the CPU and GPU busy?

GPUI proved that Rust and the GPU can build an app as complex as Zed, and it matters for high-performance custom drawing, complex editor UI and GPU control. But real performance is more than frame rate: it is also low idle cost, low power and longer battery life.


**GPUI provides GPU rendering for the Zed desktop editor.** [GPUI](https://github.com/zed-industries/zed/tree/main/crates/gpui) is the Rust UI framework of the Zed editor; [GPUI Fast](https://github.com/longbridge/gpui-fast) is Longbridge's fork with retained rendering, scroll layers and native window compositing, and NSH comes from the same team.

Where that hurts, for a general app:

- **Desktop only.** GPUI's README covers macOS, Linux/FreeBSD and Windows; phones and the web are not targets ([GPUI README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)).
- **An editor's framework, moving with the editor.** GPUI is "still pre-1.0" and "there will often be breaking changes between versions"; the README's advice for learning it is to "read the Zed source code or drop a question in the Zed Discord" ([same source](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)).
- **Everything is drawn.** Text fields, selection and menus are drawn by the framework rather than being the platform's controls, so system text behavior is reimplemented, as in Flutter.
- **Rust only, nothing delivered.** There is no scripting path for quick screens and no sandbox for UI delivered after release (GPUI Kit adds JavaScript modules through [GPUI Shell](https://gpui-kit.com/shell), the idea NSH grew from).

- **High frame rates are not low cost.** Rebuilding the element tree every frame can mean rebuilding and redrawing when nothing changed. That costs CPU, and GPU drawing, compositing and wake-ups cost power too. For everyday apps, performance also means idle cost, power use and battery life.
- **No terminal.** A drawn architecture could in principle reach more platforms, but today there are no iOS, Android, HTML web or TUI backends like NSH's.

How NSH answers: the same Rust-first engine, with apps in TSX and Rust where it pays, reaches iOS, Android, the web and the terminal; retained mode with fine-grained signals skips recomputing and redrawing unrelated parts when little changes, cutting CPU and unnecessary GPU work; tab focus, keyboard navigation and accessibility are left to the platform where possible; text input, selection and input methods are the platform's; TSX with hot updates and signed, sandboxed delivery are built in. NSH's GPUI backend embeds NSH apps in existing GPUI and GPUI Kit apps, so screens can move one at a time instead of in a rewrite ([GPUI](./gpui.md)).

**The numbers, honestly.** In the [NSH performance benchmark](https://github.com/longbridge/nsh-perf-bench) (Linux, a 500-row quote table, NSH on GTK 4), everyday load costs the same: at 1,000 quotes a second NSH Rust uses 18% of one core and GPUI Fast 20%. Under sustained heavy updates GPUI Fast leads: at 20,000 quotes a second it uses 25% against NSH's 73–78%, and on an animation of 1,000 boxes computed every frame about a third of NSH's CPU. During development we have also observed the CPU use below in specific scenarios. They come from different scenarios and past experience, without a common device, workload or measurement method, and **are not a like-for-like comparison under one load**:

| Scenario | CPU (development observation) |
|---|---:|
| Upstream GPUI, some continuously updating screens | 40%–60% |
| GPUI Fast (after retained rendering and other work) | ~20% |
| NSH, comparable updating screens | under 15% |
| Upstream GPUI, some low-frequency updates | ~20%–40% |
| NSH, some low-frequency updates | under ~5%–10% |

GPU power has not been measured separately, and a drop in CPU should not be read as the same drop in GPU power. We built GPUI Fast precisely to reduce these costs in upstream GPUI; it is not what this comparison targets.

For a desktop-only terminal dominated by thousands of views updated every frame, stay on GPUI Fast; for phones, the web, everyday screens or delivered UI, use NSH.

GPUI Kit users already have advanced desktop components. The gain is carrying the same interaction model to additional hosts. Embed one NSH panel first and verify its document state and keyboard behavior before moving the surrounding workspace.

**The challenge: Less CPU. Less GPU work. More Native. Desktop, Mobile, Web, and TUI.**

## Challenging Qt: can mature professional desktop reach phones and the web?


**Qt offers two UI technologies, Widgets and Qt Quick.** Qt Widgets and Qt Quick draw their own controls styled to resemble each platform, with long-built tooling. NSH differs in foundation and model: platform controls rather than styled look-alikes, TSX on a Rust core, with Rust for the parts that need it, instead of C++ and QML, HTML on the web, one component model that adapts interaction across mobile, desktop and web, a toolchain designed for automated and AI-driven development, and an Apache-2.0 license for every use.

Qt is one of the most mature and complete UI frameworks, with rich components, system integration and decades of engineering in professional desktop software, industrial applications and embedded devices. Where that hurts:

- **Its center of gravity is not consumer mobile or the web.** Qt supports iOS, Android and WebAssembly, but on phones it has not become as common a choice as native development, React Native or Flutter, and its main UI paths are not built on UIKit and Android views. Qt's WebAssembly output draws into a canvas rather than producing HTML.
- **Licensing needs case-by-case review.** Qt combines LGPL, GPL and commercial licenses; teams evaluate obligations per module, linking method and distribution, and some modules are GPL or commercial only ([Qt licensing](https://www.qt.io/licensing)).
- **Shipping means shipping the runtime.** The common dynamically linked deployment bundles Qt libraries, platform plugins and resources, and on Windows that means managing DLLs, plugin directories and version compatibility. Static linking is possible, with its own build and license conditions.
- **The toolchain is assembled by hand.** The Qt SDK, CMake, compilers, platform plugins, runtime libraries and per-platform deployment configuration all need maintaining.

NSH's approach: on the desktop it provides multiple windows, Dock, DataTable, Editor, RichEditor and DiffView; on phones it builds on UIKit and Android views; on the web it outputs real HTML and CSS; and it also targets the terminal. The NSH core is Apache-2.0, usable in closed-source commercial apps with no framework license to buy and no LGPL relinking requirement — third-party nshm modules keep their own licenses. One `nsh` executable creates, runs, tests, packages and signs apps; TSX needs no Node or npm, and pure Rust apps carry no JavaScript VM. Platform tools such as Xcode and the Android SDK are still required.

**The numbers, honestly.** Qt's desktop ecosystem is still ahead, and NSH does not replace every Qt component. NSH has Linux packages around 10 MB and a Rust app using about 19 MB on macOS, but the size, memory and CPU differences against Qt Widgets or Qt Quick can only be quantified by measuring the same features on the same platform.

For a Qt Widgets workspace, map dock widgets to Dock and test saved layouts and panel state; existing Qt widget code still needs an integration or rewrite.

**The challenge: Professional Desktop. Native Mobile. Real HTML Web. Apache 2.0.**

## Challenging Slint: beyond lightweight, who carries a complete cross-platform product?


**Slint provides its own declarative language and renderer**, aimed at desktop and embedded devices and usable from Rust, C++, JavaScript or Python. Both value native performance; NSH's path is each platform's own UI and interaction, HTML on the web, TSX and Rust as app languages instead of a separate markup language, and phones as first-class targets.

Slint's dedicated language is not a flaw: it makes the UI analyzable and optimizable, and for dashboards, device control panels and resource-constrained devices Slint is competitive. The difference shows when moving from building a screen to shipping a complete application:

- **Depth of professional components.** Picture a cross-platform code-review tool: a draggable multi-column Dock, a diff of tens of thousands of lines, an editor with syntax highlighting and undo history, keyboard movement between tables and panels, multiple windows and system menus. NSH provides Dock, DiffView, Editor, RichEditor and DataTable directly; Slint has standard widgets, lists and models, and the fair comparison is how much editor, table, docking and desktop interaction work remains to be built.
- **Native interaction on phones.** Slint's mobile UI is drawn by its own renderer, so input methods, text selection, touch gestures, system accessibility and platform conventions are the framework's to keep up with. NSH builds on UIKit and Android views on iOS and Android, which everyday apps such as chat, forms and document editing benefit from directly.
- **The web is HTML, not a canvas.** Slint's web path is WebAssembly with its own rendering; NSH's web build outputs HTML elements and CSS, so the DOM, semantic structure, native input, text selection and web APIs all take part.
- **Layout model.** NSH offers Flexbox, Grid, percentages, responsive state and Tailwind-style styling, so teams fluent in web layout can reuse their design and layout thinking. Slint's layouts and property bindings are mature too; they just do not aim at CSS layout.

On embedded and very low-resource devices Slint keeps its edge; NSH's main ground is applications that need rich interaction and delivery to many platforms.

For a table-heavy tool, compare the existing table with DataTable using the same model and check paging, column pinning and keyboard selection before porting custom cells.

**The challenge: From lightweight UI to a complete application platform: professional desktop components, native mobile interaction, real HTML on the web, and one layout and development model.**

## Summary: one row per framework

| Framework | Its structural limit | What NSH does instead |
|---|---|---|
| Electron | A browser and Node.js in every app; desktop only | Platform views, no browser; ~19 MB Rust app; phones and web from the same code |
| Tauri | A different web engine per OS and version | Platform views, the same on every supported OS; TSX and Rust in one process |
| React Native | JS thread and reconciliation on every update; desktop and web as separate projects | Rust core with fine-grained signals; six platforms in one framework and release |
| Flutter | Self-drawn text and input; costly native views; canvas-like web | The system's text, input and accessibility; native views in the tree; HTML web |
| GPUI | Desktop only, pre-1.0, editor-driven; text, focus and accessibility built by hand | Same Rust model on phones, the web and the terminal; embeds in GPUI apps |
| Qt | Centered on desktop and embedded; licensing and runtime distribution need case-by-case review | Native phones and HTML web; Apache-2.0; one `nsh` toolchain |
| Slint | Professional app components left to build; phones and web are drawn | Built-in professional components; native phone views; HTML on the web |

## One framework, more of the product

Each mainstream framework proved something important:

- **Electron**: a web developer experience can greatly lower the bar for desktop apps.
- **Tauri**: Rust plus the system web view can cut Electron's runtime cost.
- **React Native**: TSX/JavaScript and native UI can work together.
- **Flutter**: one rendering system can give highly consistent visuals.
- **GPUI**: Rust and the GPU can build complex, high-performance desktop apps.
- **Qt**: professional desktop apps can have a deeply mature component and engineering system.
- **Slint**: lightweight declarative UI can cover embedded and resource-constrained devices.

But real product requirements do not arrive along framework boundaries. A typical product meeting produces a list like this:

- macOS, Windows and Linux, and iOS and Android, and the web, and even the terminal.
- One codebase, sharing as much of the components, layout, business logic and tooling as possible.
- Native UI, not the whole app wrapped as a web page.
- A TSX and CSS-style developer experience, and Rust's performance and system access.
- Low CPU, low GPU work, low power, fast start-up and a small package.
- Professional desktop Dock, tables, editors, complex layouts and multiple windows, and natural touch, input methods, focus and accessibility on phones.
- Rust extensions for file indexing, audio and video processing, heavy computation and OS APIs.
- Embedding into existing apps, and dynamic UI that is signed, authorized and revocable.

NSH aims to stop these needs forcing a team to maintain several incompatible UI frameworks at once. It does not stitch existing frameworks together; on one Rust core it organizes native UI, a web-style developer experience, fine-grained retained mode, professional components, cross-platform backends and module extensions into one application system:

| You want | How NSH does it |
|---|---|
| Professional desktop | macOS, Windows, Linux; multiple windows, Dock, editors, tables |
| Native mobile | UIKit on iOS, Android views |
| A real web build | HTML elements, CSS, the browser DOM and web APIs |
| Terminal | A [TUI](./tui.md) backend |
| One codebase | Shared components, layout, reactive model and business logic |
| A web-style developer experience | TSX, Flexbox, Grid, [Tailwind](./tailwind.md)-style styling |
| Rust performance | Rust core, pure Rust apps, [nshm](./nshm.md) modules |
| Low resource use | Retained mode, fine-grained updates, no Chromium for native UI |
| Full native interaction | System views, input, focus and accessibility reused where possible |
| A simpler toolchain | One `nsh` CLI, an Apache-2.0 core |
| UI delivered after release | Signed packages, capability grants, sandboxing and revocation (subject to platform and app store rules) |

These are not independent wish-list items; a real product can face all of them at once.

**Build once, native everywhere.**

## Evaluating it: start with a pilot

No rewrite is needed to find out. An NSH app can ship on its own or embed as one view in an existing iOS, Android or desktop app ([Embedding](./embedding.md)), so start with one screen:

1. **Pick the scenario that matters most to you**: live data and charts, a rich-text or AI chat screen, a module you need to deliver after release, or one module of a desktop client.
2. **Build it in NSH alongside the current one**: screens in TSX to begin with, key logic and computation in Rust.
3. **Compare with your own data**: start time and memory; CPU and frame rate under frequent updates; scrolling of long content and whether selection and input methods feel natural; whether menus, windows and text input are consistent across platforms; and, for delivered UI, signature checks, capability limits and rollback.

`nsh`'s trace and the methods in the [performance report](./performance-report.md) apply directly to these comparisons.

## UI delivered after release

An app that wants UI it did not ship with — answers generated by a model, features from partners or other teams, screens that change without a release — has a handful of established options, on phones and desktops alike. They differ in what draws the UI, what the delivered code may do, and how much of the app has to change to host them.

NSH is designed for custom UI. The app styles its components and can use system materials such as Liquid Glass on supported platforms. Text editing, input methods and selection follow platform conventions.

| Capability | NSH | Web view | Server-driven UI | Mini-programs | OTA updates |
|---|---|---|---|---|---|
| Drawn by | Platform UI | Browser engine | The app's views | Web engine + layer | Framework renderer |
| Native interaction behavior | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| Own state, logic and layout | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| Host's native components | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Bridge | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| Sandbox the host configures | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Same-origin | <span class="status status--yes" role="img" aria-label="Yes"></span> Schema | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> |
| Signed, revocable packages | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| Fit for AI-generated UI | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Web pages | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--no" role="img" aria-label="No"></span> |
| Cost to the host app | One view and a library | A browser engine per view | A renderer per component | A container SDK | The whole app in the framework |

- **Web view (H5).** A page in a browser engine: anything HTML can express, with the browser's look and a hand-written bridge to native code.
- **Server-driven UI.** JSON that recombines the components and actions the app already ships: easy to generate, with no local state or logic beyond what the schema provides.
- **Mini-program containers.** A platform-specific framework and API on a web engine, inside a large container SDK.
- **Over-the-air updates** (React Native with a code-push service, for example). The whole framework, but updates are trusted app code, and the app has to be written in that framework.
- **NSH.** A TSX module with its own state, logic, animation and layout, rendered with the platform's own UI, that can use the host's registered native views. It arrives as a signed package the app verifies, runs in its own VM with memory, call-time and node limits, and reaches only the network hosts, web pages and system settings the host grants ([Sandbox and capabilities](./sandbox-and-capabilities.md)). The host adds one view where the module appears ([Platforms](./platforms.md#embed-in-a-native-app)), and the same bundle runs on every platform. This is the reason NSH exists next to [GPUI Shell](./index.md#native-shell-and-gpui-shell).

## When another option fits better

- The screen is dominated by sustained, dense updates of thousands of views — a market-data terminal streaming tens of thousands of quotes a second, a custom visualization redrawn every frame: GPUI Fast's retained GPU rendering uses a fraction of the CPU (see the GPUI section above).
- The app must look pixel-identical on every platform: a framework that draws everything itself, such as Flutter or Slint, gives that by design.
- You need a large ecosystem of third-party packages today: React Native, Flutter and Qt have years of them.
- The UI is a document or an existing web page: a web view shows it as it is.
- The set of screens is fixed and small, and only content and order change: server-driven UI needs no runtime at all.

## See also

- [Introduction](./index.md): what NSH is, and what native means in it.
- [Architecture](./architecture.md): what runs where inside NSH.
- [Performance](./performance.md): the rules NSH follows, and how to measure an app.
