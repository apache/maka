---
title: Platform overview
description: "Where NSH runs: iOS, Android, macOS, Windows, Linux, GPUI, terminals and the web, each with its own backend; how to run, package and embed a Rust or TSX app on each, and what each needs."
order: 10
group: platforms
---

# Platform overview

NSH runs on phones, desktops, terminals and the web: iOS, Android, macOS, Windows, Linux, GPUI, terminal cells and web pages. Each has a backend of its own that draws with the platform's own UI, so an app is UIKit views on an iPhone, AppKit views on a Mac, GTK 4 widgets on Linux, GPUI elements in a GPUI app, Ratatui cells in a terminal and HTML in a browser, with the platform's text, input, accessibility and dark mode. Everything above the backend is shared: the reactive graph, the renderer, Taffy layout, the components and the native modules are the same Rust code everywhere, so one app runs on all of them. An app written in Rust is that code and your crate, with no JavaScript VM; a TSX app runs its modules on QuickJS on top of it ([Building with Rust](./rust.md)).

On every platform, an app is used the same two ways: packaged as an installable app of that platform (`nsh package`), or embedded in a native app of your own, whether the host links a Rust root or loads TSX at run time. You develop it with `nsh run` (Rust edits rebuild and restart the app, TSX edits are hot updates).

## At a glance

| Platform | Backend; text | Runs on | Develop | Package |
|---|---|---|---|---|
| [iOS](./ios.md) | UIKit; CoreText | iOS 15.0+, devices and the simulator | `nsh run --target ios` | `.app` (simulator), signed `.ipa` |
| [Android](./android.md) | Android views; `StaticLayout` | Android 9 (API 28)+, `arm64-v8a`, `armeabi-v7a` and `x86_64` | `nsh run --target android` | signed `.apk` |
| [macOS](./macos.md) | AppKit and Core Animation; CoreText | macOS 14+ | `nsh run --target macos` | ad hoc signed `.app` |
| [Windows](./windows.md) | Win32 windows drawn with Direct2D; DirectWrite | Windows 10 1809+, Windows 11 | `nsh run` (the default on Windows) | a directory and a `.zip` |
| [Linux](./linux.md) | GTK 4 widgets; Pango | GTK 4.14+ | `nsh run` (the default on Linux) | a directory and a `.tar.gz` |
| [GPUI](./gpui.md) | GPUI; GPUI's text system | macOS, Windows, Linux (Vulkan) | in your GPUI app; TSX also with `nsh run --target gpui` | inside the GPUI app that embeds it |
| [Terminal](./tui.md) | Ratatui; terminal graphemes | macOS, Windows, Linux | `nsh run --target tui` | a console executable and resources, archived for the host OS |
| [Web](./web.md) | HTML and CSS; the browser's fonts | modern browsers, desktop and phone | `nsh run --target web` | a static site |

- **[GPUI](./gpui.md)** draws apps with [GPUI](https://gpui-kit.com), the framework of the sibling project GPUI Kit, on macOS, Windows and Linux alike: it is the backend for embedding in GPUI and GPUI Kit apps, whose `AppView` they place in their own element tree. Standalone desktop apps run and are packaged with each OS's own backend (AppKit, Win32, GTK 4).
- **[Terminal](./tui.md)** draws into Ratatui regions on macOS, Windows and Linux, sharing NSH layout and components with keyboard focus, Unicode editing, mouse input and half-block graphics. A host terminal app can embed several independent `AppView` regions.
- **[Web](./web.md)** renders apps as HTML in a browser page: `nsh package --target web` publishes a static site for any web server or CDN, with a Rust app's engine and crate compiled to WebAssembly, and a page of your own embeds an app with `createPlayer` or an iframe. It also runs the live demos and the [playground](/playground) on this site.
- **Mac Catalyst** runs the iOS backend in an iPhone-sized window (390×844) on a Mac, for development. Select it with `--target catalyst` to see how an app looks on a phone.

## Develop and package

`nsh run` picks the machine's own platform when you give no `--target`: AppKit on macOS, the GTK window on Linux and the Win32 window on Windows. Phones are reached from a computer: iOS from a Mac with Xcode, Android from macOS, Linux or Windows with the Android SDK ([Installation](./installation.md#what-works-where)).

A Rust app (its `nsh.json` names the `"root"` component) runs and packages from its directory: `nsh` builds the app's own runner for the target, with your crate and no QuickJS. A TSX app names its entry:

```sh
# A Rust app, from its directory
nsh run --target macos             # or ios, android, windows, linux, tui, web, catalyst
nsh package --target macos         # or ios, ios-simulator, android, windows, linux, tui, web

# A TSX app
nsh run App.tsx --target macos     # or ios, android, windows, linux, gpui, tui, web, catalyst
nsh package App.tsx --target macos
```

Each desktop OS packages apps with its own backend, built for the machine it runs on: package a Mac app on a Mac, a Windows app on Windows and a Linux app on Linux. [Packaging](./packaging.md) covers every target's output, signing and icons.

## Embed in a native app

| Platform | Host view | Runs | Ships as | Host language |
|---|---|---|---|---|
| macOS | `AppView` (an `NSView`) | a Rust root, TSX bundles | the `nsh-platform-macos` crate | Rust |
| Windows | `AppView` (a child window) | a Rust root, TSX bundles | the `nsh-platform-windows` crate | Rust |
| Linux | `AppView` (a GTK widget) | a Rust root, TSX bundles | the `nsh-platform-linux` crate | Rust |
| GPUI (macOS, Windows, Linux) | `AppView` (a GPUI view) | a Rust root, TSX bundles, signed packages | the `nsh-platform-gpui` crate | Rust |
| iOS | `AppView` (a `UIView`) | a Rust root, TSX bundles | the `nsh-platform-ios` crate | Rust |
| iOS | `NshAppView` (a `UIView`) | TSX bundles, signed packages | `NativeShell.xcframework` | Swift |
| Android | `NshView` (a `FrameLayout`) | TSX bundles, signed packages | `nsh.aar` | Java or Kotlin |
| Terminal (macOS, Windows, Linux) | `AppView` (a Ratatui region) | a Rust root, TSX bundles | the `nsh-platform-tui` crate | Rust |
| Web | `createPlayer` (a page element) or an iframe | TSX bundles; a Rust app as its published site | the runtime files from `nsh package --target web` | JavaScript or HTML |

A Rust host mounts a Rust root (`Root::of::<App>()`) as `AppSource::Rust` or `App::Rust`, and gives its engines the app's UI sets with `set_ui_sets`, so TSX it loads imports the app's own components and modules. Each view is one engine, and an app can show several. The host registers its own native views for apps to use on every platform ([Native components](./native-components.md)).

> [!NOTE]
> Rust hosts embed NSH with the platform crates from the NSH repository; the `AppView` of macOS, Windows and Linux loads bundles from the app's own files (or source code), with the default limits. The GPUI crate and the iOS and Android SDKs also load [signed packages](./signed-packages.md) and set limits and capabilities per view ([Sandbox and capabilities](./sandbox-and-capabilities.md)).

## Writing for every platform

Most of an app needs no platform checks: elements, styles, layout and modules behave the same everywhere. Where platforms differ, NSH gives the difference one place ([Platform-specific code](./platform-specific.md)):

- **The environment says where the app runs**: in Rust `os()`, `idiom()` and `is_desktop()` (`nsh_core::prelude`), in TSX `platform.os`, `platform.idiom` and `platform.select` from `nsh`. The OS is iOS, Android, macOS, Windows, Linux or the web.
- **Platform-only props** go in `ios={{…}}`, `android={{…}}`, `web={{…}}` or `desktop={{…}}` in TSX (`desktop`: macOS, Windows, Linux and desktop browsers).
- **The renderer** is identified by `platform.renderer` (`"native"`, `"web"` or `"terminal"`); the terminal keeps its actual `platform.os`. Use `platform.isTerminal` when selecting a terminal presentation.
- **Input follows the platform.** Phones get touches and the software keyboard; desktops get the mouse, the trackpad and the keyboard.

An app's components are drawn with NSH's primitives, so they run on desktops as well as on phones, looking the same on both. A desktop layout is built from the primitives (`view`, `text`, `scroll`, `virtual_list`, …; `View`, `Text`, `Scroll`, `List`, … in TSX) and a check for the desktop, as the gallery's desktop layout is:

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn Shell() -> impl IntoElement {
    // macOS, Windows, Linux and desktop browsers get a sidebar; phones get tabs.
    view()
        .flex_1()
        .child(if is_desktop() { sidebar_layout() } else { tab_layout() })
}

fn sidebar_layout() -> AnyElement {
    view().flex_1().flex_row().into_element()
}

fn tab_layout() -> AnyElement {
    view().flex_1().flex_col().into_element()
}
```

```tsx tabs
import { View } from "nsh";
import { platform } from "nsh";

export function Shell() {
  // macOS, Windows, Linux and desktop browsers get a sidebar; phones get tabs.
  return <View class="flex-1">{platform.idiom === "desktop" ? <SidebarLayout /> : <TabLayout />}</View>;
}

function SidebarLayout() {
  return <View class="flex-1 flex-row" />;
}

function TabLayout() {
  return <View class="flex-1 flex-col" />;
}
```

Each backend lists what it does its own way: [macOS](./macos.md#what-differs-on-macos), [Windows](./windows.md#what-differs-on-windows), [Linux](./linux.md#what-differs-on-linux), [GPUI](./gpui.md#differences).

## See also

- [Getting started](./getting-started.md): a first app, run on each platform.
- [Building with Rust](./rust.md): apps written in Rust, and Rust with TSX.
- [Installation](./installation.md): the tools each platform needs.
- [Architecture](./architecture.md): what is shared and what each backend does.
