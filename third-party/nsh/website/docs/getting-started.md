---
title: Getting started
description: "Create an app in Rust or TSX with nsh init, run it on iOS, Android, macOS, Windows, Linux or the web, host TSX modules in your app and ship them as signed packages, or package the app on its own."
order: 4
group: start
demo: guide-getting-started
---

# Getting started

This guide creates an NSH app, runs it on the platforms you target, and ships it. NSH apps are written in Rust or TSX,
on the same engine: Rust compiles your app into native code with no JavaScript VM, and TSX runs on QuickJS with hot
updates, as modules a native app can load at run time. The guide follows a Rust app first, then the same app in TSX.
It assumes `nsh` is installed and on your `PATH` ([Installation](./installation.md)); in a checkout, use
`./target/debug/nsh` instead.

> [!TIP]
> No app project at hand? The first two sections need none: `nsh run` shows the app in a window on your computer, in
> the iOS simulator, on an Android device or in the browser. You can stop there, or [package it as a standalone
> app](#or-ship-it-as-a-standalone-app).

## Create an app

On a terminal, `nsh init` asks what the app is written in: `rust`, `ts` or `mixed` (TSX with a Rust crate of its own).
`--template` chooses without asking.

### In Rust

```sh
nsh init my-app --template rust
```

`nsh init` creates the directory and writes a Cargo project:

| File | What it is |
|---|---|
| `src/lib.rs` | The app: its root component, state and handlers |
| `src/main.rs` | Mounts the same root on macOS, Windows or Linux for `cargo run` |
| `Cargo.toml` | The crate, depending on `nsh-core` and `nsh-base` at the CLI's version |
| `nsh.json` | The app's name, id, version and build number, its crate (`"rust": "."`) and root component (`"root": "App"`) ([Project structure](./project-structure.md#nshjson)) |
| `App.test.tsx` | The root's test, in TypeScript (`nsh test`), with `tsconfig.json` and `.nsh/types` for your editor |
| `README.md` | How to run, test and package the app, and how to add a TSX entry later |
| `.gitignore` | Ignores `.nsh/` and `target/` |

Rust development needs a Rust toolchain ([rustup](https://rustup.rs)); the `nsh` commands build the app's runners
from NSH's crates on crates.io, at the CLI's version.

### In TSX

```sh
nsh init my-app --template ts
```

A TSX app is one or more `.tsx` files with an entry: what `nsh run` runs, and what a host app loads as a module.

| File | What it is |
|---|---|
| `App.tsx` | The entry module: renders the app with `mount` |
| `App.test.tsx` | Its test (`nsh test`) |
| `nsh.json` | The app's name, id, version and build number ([Project structure](./project-structure.md#nshjson)) |
| `tsconfig.json` | Extends `.nsh/tsconfig.json`, NSH's TypeScript settings, which resolve `nsh` to the declarations in `.nsh/types` |
| `.gitignore` | Ignores `.nsh/` and `target/` |
| `.nsh/types/` | Generated declarations of every NSH module, for your editor |

Files that already exist are kept, so you can run it in a directory that has some of them; a Rust app is created in
a new directory.

For both, the display name defaults to the directory's name; pass `--name "My App"` to choose another. The id becomes
`com.example.<name>`: change it in `nsh.json` before you ship. `nsh init my-app --template mixed` creates a TSX app
that is also a Rust crate (`Cargo.toml` and `src/lib.rs` beside `App.tsx`), whose component, module and class
`App.tsx` imports ([Building with Rust](./rust.md)).

### The root component

The two templates make the same app, a counter:

```rust tabs
// src/lib.rs
use nsh_base::theme;
use nsh_core::prelude::*;

/// The crate's UI set: what a TSX entry may import from `my-app/native`.
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// The application's root component.
#[component]
pub fn App() -> impl IntoElement {
    let count = signal(0_u32);
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(
            view()
                .flex_1()
                .p_safe_area()
                .child(
                    view()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_4()
                        .child(text(move || format!("Count: {}", count.get())).text_size(px(28.0)))
                        .child(
                            view()
                                .px_5()
                                .py_3()
                                .rounded(px(10.0))
                                .bg(move || theme().primary)
                                .active(|s| s.opacity(0.6))
                                .on_press(move || count.update(|value| *value += 1))
                                .child(
                                    text("Tap")
                                        .text_size(px(17.0))
                                        .text_color(move || theme().primary_foreground),
                                ),
                        ),
                ),
        )
}
```

```tsx tabs
// App.tsx
import { mount, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View class="flex-1 items-center justify-center gap-4 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <Text class="text-3xl font-semibold text-foreground">{count()}</Text>
      <View
        onPress={() => count.update((c) => c + 1)}
        role="button"
        class="rounded-(--radius) bg-primary px-5 py-3 active:bg-primary/90"
      >
        <Text class="text-lg text-primary-foreground">Tap</Text>
      </View>
    </View>
  );
}

mount(App);
```

In Rust:

- **`use nsh_core::prelude::*`** brings the primitives (`view()`, `text()`, `scroll()`, `input()`, `image()`, ...),
  [signals](./reactivity.md) and the typed style methods (`.p_safe_area()` pads a view by the [safe area](../elements/safe-area.md)); **`nsh_base`** has the unstyled base components
  (`button()`, the keyboard, dialogs) and `theme()`, the colors and
  radii the app's components draw with ([Theme](./rust.md#theme)).
- **`#[component] pub fn App()`** is a component: a function that runs **once** and returns its elements.
  `nsh.json`'s `"root": "App"` names it, and `nsh run` mounts it. `signal(0_u32)` makes a value that changes over time.
- **`text(move || format!(…, count.get()))`** binds the text to the signal: when `count` changes, NSH runs this
  closure again and updates this one text, nothing else. Styles take closures the same way:
  `.bg(move || theme().primary)` follows the theme into dark mode.
- **`.on_press(..)`** makes the view answer presses; `.active(|s| s.opacity(0.6))` is its style while pressed, applied
  natively. The button is the app's own: NSH provides the primitives and the capabilities, and the app draws its UI
  from them.
- **`.px_5()`, `.rounded(px(10.0))`, `.gap_4()`** are typed style methods named as Tailwind's utilities are, in
  points (`px`). Layout is flexbox, and children stack in a column by default ([Layout](./layout.md)).
- **`#[native_module("my-app/native")]`** names what a TSX entry may import from the crate, for when you add TSX
  screens on top ([Building with Rust](./rust.md#extending-a-rust-app-with-tsx)).

In TSX:

- **`import { mount, signal, Text, View } from "nsh"`**: `nsh` is the core module: signals, `mount`, the other
  reactive primitives, and the host elements. It is served by the native runtime, not bundled. **`nsh/base`** has the
  base components, as `nsh_base` does in Rust.
- **`function App()`** is a component that runs **once**. **`{count()}`** reads the signal inside JSX: the compiler
  sees a call and makes this text follow the signal.
- **`<View onPress>`** is a native view that reacts to presses; `active:` classes are its style while pressed. `View`,
  `Text`, `Image`, `Scroll` and the other [host elements](../elements/index.md) are imported from `nsh` (`Input` from `nsh/base`); only
  `If` and `Each` need no import.
- **`class`** takes [Tailwind](./tailwind.md) classes; `style={{ … }}` takes an object of camelCase style
  properties, with numbers in points. `bg-background`, `bg-primary`, `text-primary-foreground` and
  `rounded-(--radius)` name the tokens of the app's theme ([Theme tokens](./tailwind.md#theme-tokens)): they follow
  dark mode by themselves, and `"theme"` in `nsh.json` restyles them.
- **`mount(App)`** renders the component into the app's surface.

> [!IMPORTANT]
> Text shows in a text element: `text(..)` in Rust, `<Text>` in TSX. In TSX, text written straight in a `<View>`
> (`<View>Hello</View>`) is a build error that points at it, and a string an expression puts there
> (`<View>{name}</View>`) is reported in the log.

## Develop it

### Run it

`nsh run` builds the app, launches it and rebuilds while you edit; the app's logs appear in the terminal. Give it the
app's directory: it runs a Rust app's root, or a TSX app's `App.tsx` (`nsh run my-app/App.tsx` names another entry).

For a Rust app, `nsh run` builds the app's own runner for the target, with your crate and the root mounted and no
QuickJS, and starts it; a change to the Rust code builds it again and restarts the app. `cargo run` in the app's
directory starts the same root straight on the desktop backend. For a TSX app, `nsh run` starts a dev server and a
development host that loads the app from it, and patches the running app on every save.

Without `--target`, `nsh run` uses the machine you are on: an AppKit window on macOS, a Win32 window on Windows and a
GTK window on Linux. Pick another platform with `--target`:

| Target | Command | Runs from |
|---|---|---|
| iOS simulator | `nsh run my-app --target ios` | macOS with Xcode |
| Android | `nsh run my-app --target android` | macOS, Windows, Linux |
| macOS (AppKit) | `nsh run my-app` | macOS (the default) |
| Windows | `nsh run my-app` | Windows (the default) |
| Linux (GTK 4) | `nsh run my-app` | Linux (the default) |
| Web | `nsh run my-app --target web` | macOS, Windows, Linux |
| Mac Catalyst | `nsh run my-app --target catalyst` | macOS |

#### iOS simulator

```sh
nsh run my-app --target ios
nsh run my-app --target ios --device "iPhone 16 Pro"
```

`nsh` uses a booted simulator, or boots the newest iPhone if none is running, and installs the app (a Rust app's
runner, or the development host) into it. `--device` picks a simulator by name or UDID.

#### Android

```sh
nsh run my-app --target android
```

Start an emulator or connect a device first (`adb devices` lists them; NSH uses the first one). `nsh` installs the app
on it: a Rust app's own `libnsh.so`, or a development host APK (rebuilt only when the runtime changes) whose dev server
port is forwarded to the device with `adb reverse`, so it works over USB without a shared network.

#### macOS (AppKit)

```sh
nsh run my-app --target macos
```

The app opens as a desktop Mac app (AppKit, in a resizable window), with mouse, trackpad and keyboard input instead of
touches. It needs macOS 14 or later; see [macOS](./macos.md).

#### Windows (default on Windows)

```sh
nsh run my-app
```

The app opens in a desktop window (1200×800 points), with mouse, touchpad, touch and keyboard input. It needs Windows
10 1809 or later; see [Windows](./windows.md).

#### Linux (default on Linux)

```sh
nsh run my-app
```

The app opens in a GTK window (390×844 points). It needs GTK 4.14 or later; see [Linux](./linux.md).

#### Web

```sh
nsh run my-app --target web
```

`nsh` prints the page's address; open it in a browser. A Rust app runs as WebAssembly with your crate, and the open
page loads the new build by itself after a change; see [Web](./web.md).

#### Mac Catalyst

```sh
nsh run my-app --target catalyst
```

The app opens in an iPhone-sized window (390×844 points) on your Mac. This is the quickest way to see an app as a phone
shows it: no simulator to boot. It uses UIKit like iOS, so what you see is what an iPhone shows, apart from Mac-specific
behavior such as scrolling with a mouse wheel. For the Mac app itself, use `--target macos`.

### Edit it

Leave `nsh run` running and change the button's label:

```rust tabs
text("Add one")
    .text_size(px(17.0))
    .text_color(move || theme().primary_foreground)
```

```tsx tabs
<Text style={{ color: "white", fontSize: 17 }}>Add one</Text>
```

Save. A Rust app is built again and restarts with the new label; the count starts over. A TSX app gets a hot update:
the CLI rebuilds and sends a patch, and the host runs the changed module again and renders again only the components
whose code changed. Here that is `App`, which owns the `count` signal, so the count starts over too.

Pieces of UI move into components of their own, or plain functions that return elements:

```rust tabs
/// The app's button: a view that answers presses.
fn tap_button(on_press: impl Fn() + 'static) -> impl IntoElement {
    view()
        .p_3()
        .rounded(px(10.0))
        .bg(move || theme().primary)
        .active(|s| s.opacity(0.6))
        .on_press(on_press)
        .child(text("Tap").text_size(px(17.0)).text_color(move || theme().primary_foreground))
}

// In App: .child(tap_button(move || count.update(|value| *value += 1)))
```

```tsx tabs
function TapButton(props: { onPress: () => void }) {
  return (
    <View onPress={props.onPress} activeStyle={{ opacity: 0.6 }} style={{ padding: 12, borderRadius: 10, backgroundColor: "#0969da" }}>
      <Text style={{ color: "white", fontSize: 17 }}>Tap</Text>
    </View>
  );
}

// In App: <TapButton onPress={() => count.update((c) => c + 1)} />
```

In TSX, state survives when you edit a component that does not own it: tap a few times, then change `TapButton`'s
color, and the button updates while the count stays. Hot replacement works per top-level component: a function with a
capitalized name whose body contains JSX. A component renders again when its own code changes, or when the module's
code outside components changes (a constant it uses, a helper). If an edit cannot be applied in place (for example, it
imports an NSH module the running app did not import yet, or changes `nsh.json`'s capabilities), the host reloads the
whole app.

#### Errors

A Rust compile error is printed in the terminal with cargo's output, and `nsh run` builds again with the next save. A
TSX build error is printed in the terminal and shown on the device as a red overlay with the file, line and
column; the app keeps running the last good build. The overlay disappears with the next successful build (tap it to
dismiss it earlier). An exception thrown at run time is shown the same way, with its stack mapped back to your `.tsx`
source.

## Host it in your app

A native app shows NSH in a view of its own: `NshAppView` (a `UIView`) on iOS, `NshView` (an Android `View`) on
Android, `AppView` on macOS, Windows, Linux and in GPUI apps. Place it like any other view, on any screen, as many
times as you need.

A Rust root is part of the app's build: the app links your crate and mounts the root with `AppSource::Rust` on the
`AppView` of macOS, Windows, Linux, GPUI and iOS ([Building with Rust](./rust.md#an-app-written-in-rust)). A TSX app is
a module the view loads: during development from the dev server, in a release from a built bundle or a downloaded,
signed package. The sections below load TSX modules.

### iOS

Link `NativeShellDev.xcframework` in Debug and `NativeShell.xcframework` in Release ([Embedding in iOS
apps](./ios.md)), then:

```swift
import NativeShell

let app = NshAppView()
app.onError = { message in print("nsh error: \(message)") }
view.addSubview(app)   // and constrain it like any view

#if DEBUG
try app.connectDevServer(URL(string: "ws://127.0.0.1:8790/ws")!)   // `nsh dev my-app` on your Mac
#else
try app.loadBundle(at: Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")!)
#endif
```

`nsh dev my-app` serves the module to the app and pushes every save, as `nsh run` does with its own host. For the
release build, `nsh build my-app --release --out MyApp/nsh` writes the bundle into a folder you add to the app's
resources.

### Android

Add `nsh-dev.aar` for debug builds and `nsh.aar` for release builds ([Embedding in Android
apps](./android.md)), then:

```kotlin
val nsh = NshView(this)
nsh.setErrorListener { message -> Log.e("nsh", message) }
setContentView(nsh)   // or add it to any layout

if (BuildConfig.DEBUG) {
    nsh.connectDevServer("ws://127.0.0.1:8790/ws")   // with `adb reverse tcp:8790 tcp:8790`
} else {
    nsh.loadAssetBundle("nsh")   // assets/nsh, from `nsh build my-app --release --out app/src/main/assets/nsh`
}
```

### macOS, Windows and Linux

Desktop apps written in Rust embed NSH with `AppView`, from the `nsh-platform-macos`, `nsh-platform-windows`,
`nsh-platform-linux` and `nsh-platform-gpui` crates: an `NSView`, a child window, a GTK widget or a GPUI view that
mounts a Rust root or loads a built bundle. See [macOS](./macos.md#embedding-in-a-mac-app),
[Windows](./windows.md#embedding-in-a-win32-app), [Linux](./linux.md#embedding-in-a-gtk-app) and [GPUI](./gpui.md),
and [Platforms](./platforms.md#embed-in-a-native-app) for every host side by side.

### What the module may do

On iOS and Android, the host decides before loading what a module may do: `grantCapabilities` sets the network hosts
and other capabilities it may reach, and limits cap its memory, call time and node count ([Sandbox and
capabilities](./sandbox-and-capabilities.md)). To give modules your own native views (a map, a chart, a design-system
component), register them as [native components](./native-components.md).

## Ship updates as signed packages

A TSX module the app downloads after release comes as a signed package. Create a root key once and keep it offline,
certify a release key with it, and publish:

```sh
nsh keygen keys/root && nsh keygen keys/release
nsh certify --root keys/root.secret --key keys/release.pub --apps 'com.example.*' -o keys/release.cert
nsh publish my-app --key keys/release.secret --cert keys/release.cert --build 2
```

The app trusts the root's public key and loads what it downloads; NSH verifies the signature, the certificate and the
revocation list before running anything:

```swift
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
let trust = try NshTrust(stateDirectory: support.appendingPathComponent("nsh"))
try trust.addRoot(rootPublicKey)   // the contents of keys/root.pub
let info = try await app.loadPackage(at: downloadedFile, trust: trust)
```

Android has the same flow with `NshTrust` and `NshPackage`. Hosting, delivery and revocation in detail: [Signed
packages](./signed-packages.md).

## Or ship it as a standalone app

`nsh package` builds an installable app, Rust or TSX, with no Xcode project or Gradle build of your own:

```sh
nsh package my-app --target ios-simulator --run
nsh package my-app --target android
nsh package my-app --target macos
nsh package my-app --target linux
nsh package my-app --target windows
nsh package my-app --target web
```

A Rust app is packaged with its own runner, built from your crate and NSH's crates, its root mounted; a TSX app with
the prebuilt runtime. Options, signing and icons: [Packaging](./packaging.md).

## Try it in the terminal

`nsh test` runs an app headless, with no device or window. Given a Rust app's `nsh.json` or a TSX app's entry, it
opens the app, lets it run and prints what it mounts; with `--trace`, also the native view operations and the time of
every commit ([Testing](./testing-and-trace.md)):

```sh
nsh test my-app/nsh.json --trace     # a Rust app's root
nsh test my-app/App.tsx --trace      # a TSX app's entry
```

Given a directory, it runs the app's tests: each template's `App.test.tsx` opens the app, presses its button and
checks what it shows (`nsh test my-app`). A Rust app's opens its root (`open(".")`); it can also be tested in `cargo test` with
`nsh_testing::Headless` ([Building with Rust](./rust.md#testing)).

## Next steps

- [Building with Rust](./rust.md): Rust apps, their theme, and TSX on top of a Rust crate.
- [JSX and components](./jsx-and-components.md) and [Reactivity](./reactivity.md): components and signals, in Rust and
  TSX.
- [Platforms](./platforms.md): what each platform supports, and its own page ([iOS](./ios.md),
  [Android](./android.md), [macOS](./macos.md), [Windows](./windows.md), [Linux](./linux.md)).
- [Signed packages](./signed-packages.md) and [Sandbox and capabilities](./sandbox-and-capabilities.md): delivery and
  what modules may do.
- [Project structure](./project-structure.md): what goes in `nsh.json`, assets, files.
