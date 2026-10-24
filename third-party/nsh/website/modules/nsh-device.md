---
title: nsh/device
description: The window size, color scheme, font scale, locale, platform, pixel ratio, layout direction and opening URLs outside the app.
order: 6
---

# nsh/device

The device API tells the app about the device and its environment. Rust code calls the functions of `nsh_core::ui::prelude` (`window()`, `dark()`, `font_scale()`, `locale()`, `os()`, `idiom()`, `pixel_ratio()`, `set_color_scheme()`, ...); TSX imports `nsh/device`. The window size, the color scheme, the font scale, the pixel ratio and the locale are reactive: read them in a binding (a closure passed to an element in Rust, JSX in TSX), `computed` or `effect`, and what reads them updates when the platform reports a change (rotation, a window resize, switching to dark mode, changing the text size or the language, moving to a screen of another density).

```rust tabs
use nsh_core::{
    platform::{Appearance, Idiom, Os},
    ui::prelude::*, // window, dark, font_scale, locale, os, idiom, pixel_ratio, set_color_scheme, ...
};
```

```tsx tabs
import { colorScheme, fontScale, locale, openUrl, pixelRatio, platform, setColorScheme, windowSize } from "nsh/device";
```

See [Device and environment](../docs/device-and-environment.md) for the guide.

## windowSize

```ts
const windowSize: Accessor<Size>;
```

The size of the surface in points: the window, or the embedded `NshAppView` / `NshView`. Reactive. Rust: `window() -> Size<Points>`.

```rust tabs
let wide = move || window().width >= px(600.0);

view().style_when(wide, |s| s.flex_row())
```

```tsx tabs
const wide = () => windowSize().width >= 600;

<View style={{ flexDirection: wide() ? "row" : "column" }}>{/* ... */}</View>
```

## colorScheme

```ts
const colorScheme: Accessor<"light" | "dark">;
```

The appearance shown: the system's, unless the app set its own (`nsh.json` `"appearance"`, [`setColorScheme`](#setcolorscheme)). Reactive. Rust: `dark() -> bool`; theme colors (`AdaptiveColor`) and the `.dark(…)` style variant follow it without reading it. Tailwind's `dark:` variant follows it too (see [Tailwind](../docs/tailwind.md)).

```rust tabs
view().flex_1().bg(move || if dark() { black() } else { white() })
```

```tsx tabs
const dark = () => colorScheme() === "dark";

<View style={{ flex: 1, backgroundColor: dark() ? "#000" : "#fff" }} />
```

## fontScale

```ts
const fontScale: Accessor<number>;
```

The user's preferred text size relative to the default (`1` is the default size; Dynamic Type on iOS, font size on Android), or the text size the embedding app sets in its place. Reactive. Rust: `font_scale() -> f32`. Text already scales with it unless `allowFontScaling={false}`; read it when other sizes should follow, such as icons next to text.

## locale

```ts
const locale: Accessor<string>;
```

The user's locale as a BCP 47 tag (`"en-US"`, `"zh-Hans-CN"`), or the locale the embedding app sets in its place. Reactive. Rust: `locale() -> Locale` (`locale().as_str()` is the tag). `Intl` formats for it by default; read it to choose the strings of your own translations ([Device and environment](../docs/device-and-environment.md#language-and-region)).

## setColorScheme

```ts
function setColorScheme(scheme: "light" | "dark" | "system"): void;
```

Shows the app in `scheme` whatever the system's appearance, at once: `colorScheme()`, `dark:` classes, the components' theme and the platform's controls (alerts, the status bar's default style) follow it; `"system"` follows the system again. `nsh.json` `"appearance"` sets it from the start. Rust: `set_color_scheme(Appearance::Dark)` (`Appearance::Light`, `Appearance::System`).

## platform

```ts
const platform: Platform;

interface Platform {
  readonly os: "ios" | "android" | "macos" | "windows" | "linux" | "web";
  readonly renderer: "native" | "web" | "terminal";
  readonly isTerminal: boolean;
  readonly version: string;
  readonly idiom: "phone" | "pad" | "mac" | "tv" | "desktop";
  readonly catalyst: boolean;
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}
```

The platform the app runs on, constant while it runs.

| Member | Rust | Description |
|---|---|---|
| `os` | `os() -> Os` (`os().name()` is the TS string) | The operating system. iOS, the iOS simulator and Mac Catalyst report `"ios"`, browsers `"web"`. |
| `version` | `os_version() -> (u16, u16)` | iOS and desktops: the OS version (`"17.5"`); Android: the API level (`"35"`); the web: `"0.0"`. Rust gives the major and minor version, or the API level and 0 on Android. |
| `idiom` | `idiom() -> Idiom` | The kind of device: `"phone"`, `"pad"` (an iPad, an Android tablet), `"mac"` (Mac Catalyst in the Mac idiom), `"tv"` (Apple TV, Android TV) or `"desktop"`, the desktop device class: macOS, Windows, Linux, and browsers with a mouse and a wide window. |
| `catalyst` | `idiom() == Idiom::Mac` | Mac Catalyst in the Mac idiom. |
| `renderer` | `renderer()` | The surface's presentation: platform views / desktop graphics (`"native"`), browser HTML (`"web"`) or terminal cells (`"terminal"`). |
| `isTerminal` | `is_terminal()` | The surface renders in terminal cells. `os` reports the terminal host's operating system. |
| `select(spec)` | `match os() { … }` | The value for this platform (see below). |

```rust tabs
let columns = if is_desktop() { 3 } else { 1 };
```

```tsx tabs
const columns = platform.idiom === "desktop" && !platform.isTerminal ? 3 : 1;
```

### platform.select

```ts
interface PlatformSelectSpec<T> {
  ios?: T;
  android?: T;
  macos?: T;
  windows?: T;
  linux?: T;
  web?: T;
  terminal?: T; // terminal rendering, before the OS
  mobile?: T;   // iOS, Android, and phone and tablet browsers
  desktop?: T;  // macOS, Windows, Linux, and desktop browsers
  native?: T;   // every platform but the web
  default?: T;
}
```

Returns the value for the current OS (`ios`, `android`, `web`, ...), else `mobile` / `desktop`, else `native` (every platform but the web), else `default`, else `undefined`. In a browser, `mobile` or `desktop` follows the idiom. Rust code matches on `os()` (and `is_desktop()` for `mobile` / `desktop`).

Terminals try `terminal`, then the host OS, then `native` and `default`. Use `platform.select({ terminal: "Press Enter", default: "Tap" })` for terminal interaction hints.

```rust tabs
use nsh_core::platform::Os;

let card = view().p_4();
let card = match os() {
    Os::Ios => card.shadow_color(black()).shadow_opacity(0.15).shadow_radius(px(8.0)),
    Os::Android => card.elevation(px(4.0)),
    _ => card,
};
```

```tsx tabs
const shadow = platform.select({
  ios: { shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 8 },
  android: { elevation: 4 },
});
```

> [!TIP]
> For props that only one platform has, prefer the `ios={{…}}` / `android={{…}}` props of TSX elements and components to branching on `platform` (see [Platform-specific code](../docs/platform-specific.md)).

## pixelRatio

```ts
const pixelRatio: Accessor<number>;
```

Device pixels per point (e.g. `3` on most iPhones). Reactive: it changes when the window moves to a screen of another density (on Mac Catalyst, the desktops, or an external display). Rust: `pixel_ratio() -> f32`, and `round_to_nearest_pixel(points)` for a length on whole device pixels; in TSX that length is `Math.round(x * pixelRatio()) / pixelRatio()`.

```rust tabs
let hairline = move || px(1.0 / pixel_ratio());
```

```tsx tabs
const hairline = () => 1 / pixelRatio();
```

## openUrl

```ts
function openUrl(url: string): Promise<boolean>;
```

Opens `url` outside the app: a web page in the browser, a `mailto:` link in the mail app, a `tel:` link in the phone app, and any scheme another app registered (`maps:`, a host app's own `lb://` links). It resolves to whether something opened it: `false` when no app handles the scheme. Rust: `open_url(url)` of `nsh_core::ui::prelude`, an answer to await in a task (or to drop).

```rust tabs
button()
    .child(text("Contact us"))
    .on_press(|| {
        spawn(async {
            if !open_url("mailto:help@example.com").await {
                log::warn!("no mail app");
            }
        });
    })
```

```tsx tabs
<Button
  onPress={async () => {
    if (!(await openUrl("mailto:help@example.com"))) {
      console.warn("no mail app");
    }
  }}
>
  <Text>Contact us</Text>
</Button>
```

- The URL is absolute (it has a scheme). URLs that would run code or reach the app's own data, `javascript:`, `data:`, `blob:`, `file:`, `about:` and `asset:`, throw a `TypeError`, as do relative addresses.
- An app that declares capabilities needs `openUrl`: `"openUrl": true` for every scheme, or `"openUrl": { "schemes": ["https", "mailto"] }` for those listed; other URLs throw a `TypeError` (see [Sandbox and capabilities](../docs/sandbox-and-capabilities.md)).
- The embedding app sees the URL first and can route it through its own router instead (Swift `NshAppView.onOpenURL`, Java `NshView.setOpenUrlHandler`, Rust `AppView::host().handle_open_url`; see [iOS](../docs/ios.md#links-the-app-opens) and [Android](../docs/android.md#links-the-app-opens)). The promise then resolves to `true`.
- Each platform opens it with its own opener: `UIApplication.open` on iOS (the host app's application when embedded), an `ACTION_VIEW` intent on Android, `NSWorkspace` on macOS, `ShellExecuteW` on Windows, `GtkUriLauncher` on Linux, GPUI's `open_url`, a new tab on the web. `nsh test` records the URLs instead of opening them.
- A [`TextView`](../elements/text-view.md) opens its links this way with `links="open"`.

## Layout direction

The layout direction follows the user's language: in a right-to-left language (Arabic, Hebrew, ...) the app lays out right to left, rows run from the right, and `left` / `right` style properties (`marginLeft`, `paddingRight`, ...) mean start and end. Changes apply at once, with no restart.

A view's `direction` style (`"ltr"`, `"rtl"` or `"inherit"`, the default) sets the direction of its own subtree; in Rust, `.direction(LayoutDirection::..)`.

```rust tabs
view().direction(LayoutDirection::Rtl).flex_row().gap_2().child(text("First")).child(text("Second"))
```

```tsx tabs
<View style={{ direction: "rtl", flexDirection: "row", gap: 8 }}>
  <Text>First</Text>
  <Text>Second</Text>
</View>
```

## Related

- Safe area insets (Rust `safe_area()`; TSX `safeArea()`, `safeAreaInsets()`) and the software keyboard (Rust `keyboard_height()`; TSX `keyboardFrame()`) are part of [`nsh/base`](./nsh-base.md#safearea-and-safeareainsets).
- Screen reader and reduced motion settings are in [`nsh/accessibility`](./nsh-accessibility.md).
