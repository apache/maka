---
title: Comparing approaches
description: "How Native Shell compares with React Native, Flutter, Qt, GPUI and Slint, with Electron and Tauri, and with web views and server-driven UI for UI delivered after release."
order: 2
group: start
---

# Comparing approaches

NSH is a framework for whole apps on iOS, Android, macOS, Windows, Linux and the web, and a runtime for UI delivered to apps after release. This page compares it first with the cross-platform frameworks people write apps in, then with the ways apps take UI they did not ship with. Green means the capability is available, yellow that it needs more of the app's own work or a separate project, and red that it is not provided; the marks describe availability, not performance. Versions are each framework's documented minimums at the time of writing: check them for the release you use.

Legend: <span class="status status--yes" role="img" aria-label="Yes"></span> Yes · <span class="status status--partial" role="img" aria-label="Partial"></span> Partial · <span class="status status--no" role="img" aria-label="No"></span> No.

## Cross-platform frameworks

| Capability | NSH | React Native | Flutter | Qt 6 | GPUI | GPUI Fast | Slint |
|---|---|---|---|---|---|---|---|
| Drawn by | Platform UI | Platform views | Own engine | Scene graph | Own, GPU | Own, GPU | Own renderer |
| UI model | Retained | Retained | Retained | Retained | Immediate | Immediate + Retained | Reactive, retained |
| Language | Rust, TSX | JS, TS | Dart | C++, QML | Rust | Rust | Slint + Rust, C++ |
| iOS | <span class="status status--yes" role="img" aria-label="Yes"></span> 15+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 15.1+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 15+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 17+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> Rust |
| Android | <span class="status status--yes" role="img" aria-label="Yes"></span> 9+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 7+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 7+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 9+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| macOS | <span class="status status--yes" role="img" aria-label="Yes"></span> 14+ | <span class="status status--partial" role="img" aria-label="Partial"></span> Separate | <span class="status status--yes" role="img" aria-label="Yes"></span> 12+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 13+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 12+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 12+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 13+ |
| Windows | <span class="status status--yes" role="img" aria-label="Yes"></span> 10 1809+ | <span class="status status--partial" role="img" aria-label="Partial"></span> Separate | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10 1809+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ | <span class="status status--yes" role="img" aria-label="Yes"></span> 10+ |
| Linux | <span class="status status--yes" role="img" aria-label="Yes"></span> GTK 4.14+ | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Debian 10+ | <span class="status status--yes" role="img" aria-label="Yes"></span> Debian 11+ | <span class="status status--yes" role="img" aria-label="Yes"></span> Vulkan | <span class="status status--yes" role="img" aria-label="Yes"></span> Vulkan | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| Web | <span class="status status--yes" role="img" aria-label="Yes"></span> HTML | <span class="status status--partial" role="img" aria-label="Partial"></span> Library | <span class="status status--yes" role="img" aria-label="Yes"></span> Canvas | <span class="status status--yes" role="img" aria-label="Yes"></span> Canvas | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> Canvas |
| System text | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| Per-device UX | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> |
| No JS runtime | <span class="status status--yes" role="img" aria-label="Yes"></span> Rust apps | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> C++ | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
| Signed delivery | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> OTA | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> QML | <span class="status status--partial" role="img" aria-label="Partial"></span> Shell | <span class="status status--partial" role="img" aria-label="Partial"></span> Shell | <span class="status status--no" role="img" aria-label="No"></span> |
| License | Apache-2.0 | MIT | BSD-3-Clause | LGPL, GPL, commercial | Apache-2.0 | Apache-2.0 | GPL, commercial |

Immediate mode builds the UI description again every frame; retained mode keeps it and updates only what changed. GPUI Fast combines the two on GPUI and runs where GPUI runs. "Shell" is [GPUI Shell](https://gpui-kit.com/shell).

NSH is the one framework here that brings all of these together: each platform's own UI and text input, phones, desktops and the web from one app — the web as HTML — Rust apps with no JavaScript runtime, and signed, sandboxed UI delivered after release.

### What the rows mean

- **Drawn by, UI model.** NSH mounts each platform's own views and keeps them (retained mode): a change updates only the views it touched. React Native also mounts platform views, on iOS and Android. Flutter, Qt Quick, GPUI and Slint draw with their own renderers; GPUI builds the element tree each frame (immediate mode), and [GPUI Fast](https://github.com/longbridge/gpui-fast) reuses what did not change.
- **Platforms.** NSH's minimums are its own ([Platforms](./platforms.md)). The others come from [React Native 0.76](https://reactnative.dev/blog/2024/10/23/release-0.76-new-architecture) (iOS 15.1, Android 7 / API 24; macOS and Windows through the separate react-native-macos and react-native-windows projects, the web through the react-native-web library), [Flutter 3.47](https://docs.flutter.dev/reference/supported-platforms), [Qt 6.10](https://doc.qt.io/qt-6.10/supported-platforms.html), [Zed's requirements](https://zed.dev/docs/installation) for GPUI, and [Slint's platform guides](https://docs.slint.dev/latest/docs/slint/guide/platforms/mobile/general/) (iOS from Rust). "Canvas" means the framework draws into a canvas on the page; NSH's web apps are HTML elements styled with CSS, which the browser scrolls, selects and edits ([Web](./web.md)).
- **System text.** NSH's text fields are the platform's editors — `UITextView`, `EditText`, `NSTextView`, GTK's `TextView`, the browser's — with the system's input methods, selection handles and editing menus; on Windows, NSH's own editor works with DirectWrite and the system's input methods (IMM32). React Native also uses the platform's text inputs. The self-drawn frameworks implement text editing themselves and connect it to the system's input methods.
- **Per-device UX.** NSH's base components follow the device: the same `Menu` is a popup at its trigger with a pointer and a sheet from the bottom on a phone, and a `ContextMenu` opens on a right click or a held finger. In the others, adapting interaction per device is mostly the app's own work.
- **No JS runtime.** A Rust app's runners link no JavaScript engine on any platform; TSX is the second path, on the same engine. Qt Quick's QML runs on Qt's JavaScript engine; Qt Widgets in C++ do not.
- **Signed delivery.** NSH verifies signed `.nshpkg` packages against the keys it trusts and a revocation list, and runs each in a VM with the limits and capabilities the host grants ([Signed packages](./signed-packages.md), [Sandbox and capabilities](./sandbox-and-capabilities.md)). A packaged NSH app takes its own TSX over the air the same way, iOS and Android included, and rolls back a release that fails to start ([OTA Updates](./ota-updates.md)). React Native's over-the-air updates ship trusted app code; Qt can load QML files; GPUI apps take JavaScript modules through [GPUI Shell](https://gpui-kit.com/shell).

### What sets NSH apart

- **Native on every platform, in both senses.** Each backend builds on its platform's own views, text and input methods — UIKit, Android views, AppKit, Win32 with Direct2D, GTK 4, HTML — and each platform's interaction comes with them. Text selection, input methods and accessibility are the system's, and what a new OS release brings to them reaches the app ([Introduction](./index.md#what-native-means)).
- **Phones, desktops and the web from one app.** Six platforms are backends of one framework, with layouts that reshape and input that follows the device; on the web, the app is HTML, published as a static site.
- **Rust first, with no JavaScript runtime.** A whole app can be Rust from start to end, compiled to native code with Rust's types, threads and crates. TSX is the second path, on the same engine, for screens written quickly ([Building with Rust](./rust.md)).
- **Retained views for everyday apps.** Chats, forms, lists and documents sit near idle at rest, because a change sends only the views it touched ([Introduction](./index.md#retained-views)).
- **UI delivered after release, signed and sandboxed.** Apps built with NSH — and native apps written with each platform's own tools — take TSX modules at run time, written by a team or generated by AI ([Dynamic UI](./index.md#dynamic-ui-and-ai-generated-ui)).
- **One toolchain, for people and agents.** One `nsh` executable creates, runs, tests on real platforms, packages and signs apps for every target.

### React Native

React Native is the closest in intent: both reduce duplicated client work and use the platform's views. React Native's center is JavaScript or TypeScript with React and its package ecosystem, on iOS and Android, with desktop support in separate projects. NSH's center is Rust: its runtime, renderer and modules are Rust, Rust is an app language of its own, and TSX is one path among two; its six platforms, the desktops and the web included, are backends of the same framework.

### Flutter

Flutter draws every pixel with its own engine, so an app looks the same on every platform. NSH takes the other path: the views, text and text input of each platform, and on the web HTML elements and the browser's own scrolling, selection and input. Text editing, input methods and selection are the platform's, rather than reimplemented per platform.

### Qt

Qt is a mature toolkit with two UI technologies, Qt Widgets and Qt Quick, and long-standing tools and platform support. NSH differs in its base and its model: Rust as the core language with a TSX path, a toolchain designed for automated (and AI-driven) development, the web rendered as HTML, and mobile, desktop and web interaction adapted inside one component model.

### GPUI and GPUI Fast

[GPUI](https://gpui-kit.com) is a Rust UI framework that draws with the GPU, built for demanding desktop apps; [GPUI Fast](https://github.com/longbridge/gpui-fast) is Longbridge's fork with retained rendering — it reuses unchanged views, layout and text measurements — scroll layers and native window composition. NSH builds on each platform's views instead, so text input, selection, input methods and system interaction are the platform's own, and it covers phones and the web as well; NSH's GPUI backend embeds NSH apps in GPUI and GPUI Kit apps ([GPUI](./gpui.md)).

The two suit different loads. In the [NSH performance benchmark](https://github.com/longbridge/nsh-perf-bench) (Linux, a 500-row quote table, NSH on its GTK 4 backend), everyday loads cost the same: at 1,000 quotes a second, NSH Rust uses 18% of a core and GPUI Fast 20%. Under sustained, dense updates GPUI Fast is ahead: at 20,000 quotes a second it uses 25% of a core where NSH uses 73–78%, and frame-by-frame animation of 1,000 boxes costs it about a third of NSH's CPU.

### Slint

Slint is a declarative UI toolkit with its own language and light renderers, for desktops and embedded devices, used from Rust, C++, JavaScript or Python. Both value native performance; NSH's route is each platform's own UI and interaction, HTML on the web, Rust and TSX as app languages, and AI-driven development across six platforms.

### Electron and Tauri

Electron bundles Chromium and Tauri uses the system's web view: both build desktop apps (and, with Tauri, mobile apps) from web content, with the browser's text and input. NSH builds each platform's own views instead, and renders HTML only on the web itself.

## UI delivered after release

An app that wants UI it did not ship with — answers generated by a model, features from partners or other teams, screens that change without a release — has a handful of established options, on phones and desktops alike. They differ in what draws the UI, what the delivered code may do, and how much of the app has to change to host them.

| Capability | NSH | Web view | Server-driven UI | Mini-programs | OTA updates |
|---|---|---|---|---|---|
| Drawn by | Platform UI | Browser engine | The app's views | Web engine + layer | Framework renderer |
| Native look and behavior | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--no" role="img" aria-label="No"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> | <span class="status status--partial" role="img" aria-label="Partial"></span> | <span class="status status--yes" role="img" aria-label="Yes"></span> |
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

- The screen is dominated by sustained, dense updates of thousands of views — a market-data terminal streaming tens of thousands of quotes a second, a custom visualization redrawn every frame: GPUI Fast's retained GPU rendering uses a fraction of the CPU (see [GPUI and GPUI Fast](#gpui-and-gpui-fast)).
- The app must look pixel-identical on every platform: a framework that draws everything itself, such as Flutter or Slint, gives that by design.
- You need a large ecosystem of third-party packages today: React Native, Flutter and Qt have years of them.
- The UI is a document or an existing web page: a web view shows it as it is.
- The set of screens is fixed and small, and only content and order change: server-driven UI needs no runtime at all.

## See also

- [Introduction](./index.md): what NSH is, and what native means in it.
- [Architecture](./architecture.md): what runs where inside NSH.
- [Performance](./performance.md): the rules NSH follows, and how to measure an app.
