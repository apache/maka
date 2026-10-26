---
title: Modules
description: The modules an NSH app imports, what each one exports, and how they are organized.
order: 1
---

# Modules

An NSH app imports everything it uses from a small set of modules. They are all native: the reactive graph, the renderer and every module are implemented in Rust inside the runtime, and the bundler keeps `import ... from "nsh/..."` as imports instead of copying code into your bundle. Your bundle only holds your own code.

```tsx
import { mount, signal } from "nsh";
import { createAnimatedValue } from "nsh/animated";
import { windowSize } from "nsh/device";
import { SafeAreaView } from "nsh/base";
```

## Three layers

NSH's UI is built in three layers, as GPUI Kit's is (`gpui`, `gpui-base`, `gpui-component`):

| Layer | Modules | What it gives an app |
|---|---|---|
| Primitives | `nsh`, `nsh/<module>` | Reactivity, the host elements, layout, lists, canvas, animation, gestures, device information and the platforms' own APIs |
| Base components | [`nsh/base`](./nsh-base.md) | Unstyled components that own behavior, state, focus and accessibility: a button, Markdown and HTML documents, navigation stacks and dialogs, safe areas, the system's dialogs and the software keyboard, on every platform |
| Component library | your app's, or one from the community | Buttons, cards, rows and screens with a look |

The look of an app is the app's own. Its component library is the third layer: components it writes from the [host elements](../elements/index.md) and `nsh/base`, styled with `style`, [Tailwind](../docs/tailwind.md) classes and its theme, Rust components it ships in [its own crate](../docs/rust.md), or a library the community publishes on the same foundation.

There is no catch-all module: each API lives in exactly one place. Platform-only APIs live in `nsh/ios`, `nsh/android` and `nsh/desktop` (macOS, Windows, Linux); all can be imported on every platform, so one bundle runs everywhere (their calls do nothing elsewhere, and `isAvailable` tells you which platform you are on).

Types are generated from the runtime: `nsh init`, `nsh build`, `nsh dev` and `nsh test` write `.nsh/types` next to your app, so the TypeScript declarations always match the runtime you build with (see [Project structure](../docs/project-structure.md)).

## All modules

| Module | Exports | Page |
|---|---|---|
| `nsh` | `signal`, `computed`, `effect`, `batch`, `untracked`, `cleanup`, `context`, `split`, `mount`, `ErrorBoundary`; the primitives `View`, `Text`, `Scroll`, `Input`, [`List`](./nsh-list.md), [`Image`](./nsh-image.md) (with `Image.getSize`, `Image.prefetch`), [`Canvas`](./nsh-canvas.md) (with `Path2D`, `CanvasRenderingContext2D`, `CanvasGradient`), [`WebView`](./nsh-webview.md), [`Video`](./nsh-video.md); the types of elements, styles, events and JSX (`YNode`, `ViewStyle`, ...) | [nsh](./nsh.md) |
| `nsh/base` | `Button`; `TextView`, `SelectionArea`; `createNavStack`, `NavStack`, `NavPage`, `Dialog`; `SafeAreaView`, `safeArea`, `safeAreaInsets`; `AlertDialog`; `Keyboard`, `keyboardFrame`, `KeyboardAvoidingView` | [nsh/base](./nsh-base.md) |
| `nsh/animated` | `createAnimatedValue`, `AnimatedValue`, `AnimatedNode`, `Animated`, `Easing`, `LayoutAnimation` | [nsh/animated](./nsh-animated.md) |
| `nsh/device` | `windowSize`, `colorScheme`, `setColorScheme`, `fontScale`, `pixelRatio`, `locale`, `platform`, `openUrl` | [nsh/device](./nsh-device.md) |
| `nsh/gesture` | `PanResponder` | [nsh/gesture](./nsh-gesture.md) |
| `nsh/clipboard` | `Clipboard.writeText`, `Clipboard.readText`, `Clipboard.writeImage`, `Clipboard.readImage`, `Clipboard.readFiles` | [nsh/clipboard](./nsh-clipboard.md) |
| `nsh/picker` | `Picker.pickImages` | [nsh/picker](./nsh-picker.md) |
| `nsh/storage` | `Storage.getItem`, `Storage.setItem`, `Storage.removeItem`, `Storage.keys`, `Storage.clear` | [nsh/storage](./nsh-storage.md) |
| `nsh/host` | `host.available`, `host.call`, `host.on`, plus native SDK `params` and `post` | [nsh/host](./nsh-host.md) |
| `nsh/keymap` | `keymap.bind` (keyboard shortcuts: `mod+k`, `ctrl+shift+p`, ...) | [nsh/keymap](./nsh-keymap.md) |
| `nsh/native` | `nativeComponent`, `nativeModule` (components and functions the embedding app registers) | [nsh/native](./nsh-native.md) |
| `nsh/accessibility` | `announce`, `setAccessibilityFocus`, `screenReaderEnabled`, `reduceMotion` | [nsh/accessibility](./nsh-accessibility.md) |
| `nsh/ios` | `isAvailable`, `InputAccessoryView` | [nsh/ios](./nsh-ios.md) |
| `nsh/android` | `isAvailable`, `Toast`, `BackHandler` | [nsh/android](./nsh-android.md) |
| `nsh/mobile` | `isAvailable`, `TabBar` (the system's tab bar, iOS and Android) | [nsh/mobile](./nsh-mobile.md) |
| `nsh/desktop` | `isAvailable`, `Window` (title, title bar, maximize, full screen), `titleBar`, `Menu` (application menu, context menus) | [nsh/desktop](./nsh-desktop.md) |
| Standard modules | `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`, `zlib` | [Standard modules](./standard-modules.md) |
| Globals | `fetch`, `URL`, `TextEncoder`, `Blob`, `FormData`, `AbortController`, `Intl`, timers, `console`, `requestAnimationFrame`, ... (no import) | [Global APIs](./globals.md) |

Reference pages that are not modules:

| Page | Covers |
|---|---|
| [Style reference](./style-reference.md) | Every style key, its type and meaning |
| [Tailwind reference](./tailwind-reference.md) | The Tailwind utilities and variants `class` accepts |

## Host elements

The host elements are components imported like everything else: `View`, `Text`, `Scroll`, `Input`, `Image`, `List`, `Canvas`, `WebView` and `Video` from `nsh`, the base components (`Button`, `Dialog`, `NavStack`, `NavPage`, `SafeAreaView`, `KeyboardAvoidingView`) from `nsh/base`, `InputAccessoryView` from `nsh/ios`. Only `If` and `Each` are globals. The compiler makes the elements in place, so the imports cost nothing at run time. Their props are documented under [Elements](../elements/index.md).
