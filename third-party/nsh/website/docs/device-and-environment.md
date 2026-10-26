---
title: Device and environment
description: Reading the window size, color scheme, font scale, safe areas, the platform, pixel density and layout direction, and reacting when they change.
order: 47
group: ui
demo: guide-device
---

# Device and environment

The environment an app runs in changes while it runs: the window resizes (rotation, split view, a Mac window), the user switches to dark mode or a larger text size, the keyboard comes and goes. NSH exposes each of these as a **reactive accessor**: call it like a signal, and whatever read it (a style, a text, a computed value) updates when it changes. There are no listeners to add or remove.

In Rust the accessors are functions of `nsh_core::prelude`; in TSX they come from the modules listed.

| Rust | TSX | Value |
|---|---|---|
| `window()` | `windowSize()` (`nsh`) | The surface's width and height, in points. |
| `dark()` | `colorScheme()` (`nsh`) | Dark or light: the system's, or the app's own (`set_color_scheme`, `setColorScheme`). |
| `font_scale()` | `fontScale()` (`nsh`) | The user's preferred text size relative to the default (1 is the default). |
| `safe_area()` | `safeArea()` (`nsh`) | Insets of the surface not covered by system UI: top, right, bottom, left. |
| `cx.insets()` | `safeAreaInsets()` (`nsh`) | The insets where the calling component renders (a page, a dialog). |
| `keyboard_height()`, `keyboard_duration()` | `keyboardFrame()` (`nsh`) | The software keyboard's height and animation duration. |
| `locale()` | `locale()` (`nsh`) | The user's locale as a BCP 47 tag (`"en-US"`, `"zh-Hans-CN"`): what `Intl` formats for by default. |
| `reduce_motion()`, `screen_reader()` | `reduceMotion()`, `screenReaderEnabled()` (`nsh`) | See [Accessibility](./accessibility.md). |

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    view()
        .flex_1()
        .pt(move || safe_area().top + px(16.0))
        .px(px(16.0))
        // A light and a dark value: the color follows the appearance natively.
        .bg(AdaptiveColor::rgb(0xffffff, 0x0d1117))
        .child(
            text(move || {
                let size = window();
                format!(
                    "{} × {} pt, text at {:.2}×",
                    size.width.0.round(),
                    size.height.0.round(),
                    font_scale()
                )
            })
            .text_color(AdaptiveColor::rgb(0x1f2328, 0xe6edf3)),
        )
}
```

```tsx tabs
import { mount, Text, View, safeArea } from "nsh";
import { colorScheme, fontScale, windowSize } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: safeArea().top + 16, paddingHorizontal: 16, backgroundColor: colorScheme() === "dark" ? "#0d1117" : "#ffffff" }}>
      <Text style={{ color: colorScheme() === "dark" ? "#e6edf3" : "#1f2328" }}>
        {Math.round(windowSize().width)} × {Math.round(windowSize().height)} pt, text at {fontScale().toFixed(2)}×
      </Text>
    </View>
  );
}

mount(App);
```

## Window size and responsive layout

`window()` (TSX: `windowSize()`) is the size of the surface NSH renders into: the screen on a phone, the window on an iPad in split view or on a Mac, the host view when NSH is embedded. Use it to change the layout, not only sizes:

```rust tabs
use nsh_core::prelude::*;

fn gallery() -> impl IntoElement {
    let columns = || {
        let width = window().width.0;
        if width >= 700.0 { 4.0 } else if width >= 500.0 { 3.0 } else { 2.0 }
    };
    let side = move || px((window().width.0 - 32.0 - (columns() - 1.0) * 8.0) / columns());
    view().flex_row().flex_wrap().gap_2().child(each(
        photos,
        |p| p.id,
        move |p, _| image(move || p.with(|p| p.url.clone())).w(side).aspect_ratio(1.0),
    ))
}
```

```tsx tabs
import { Image, View } from "nsh";
import { windowSize } from "nsh";

function Gallery() {
  const columns = () => (windowSize().width >= 700 ? 4 : windowSize().width >= 500 ? 3 : 2);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Each of={photos}>
        {(p) => <Image src={p().url} style={{ width: (windowSize().width - 32 - (columns() - 1) * 8) / columns(), aspectRatio: 1 }} />}
      </Each>
    </View>
  );
}
```

Often flexbox, percentages and `aspect_ratio` (`aspectRatio`) do the job without reading the size at all; see [Layout](./layout.md). Rust's `style_when(|| window().width.0 >= 640.0, |s| s.flex_row())` switches styles with the width; in TSX with Tailwind, the breakpoint variants (`sm:`, `md:`, `lg:`, `xl:`, `2xl:`, `max-*:`, `min-[…]:`) and `portrait:` / `landscape:` follow the window too: `class="grid grid-cols-2 md:grid-cols-4"`.

## Dark mode

The appearance follows the system unless the app sets its own. In Rust, the simplest way to support dark mode is a color with a light and a dark value, `AdaptiveColor::rgb(light, dark)`: it switches natively when the appearance does, with nothing to run. In TSX it is the `dark:` Tailwind variant, which applies when `colorScheme()` is `"dark"`:

```rust tabs
view()
    .flex_1()
    .p_4()
    .bg(AdaptiveColor::rgb(0xffffff, 0x18181b))
    .child(
        text("Follows the system appearance")
            .text_color(AdaptiveColor::rgb(0x18181b, 0xf4f4f5)),
    )
```

```tsx tabs
<View class="flex-1 bg-white dark:bg-zinc-900 p-4">
  <Text class="text-zinc-900 dark:text-zinc-100">Follows the system appearance</Text>
</View>
```

For anything else, read `dark()` (TSX: `colorScheme()`) in a closure or a computed value; in TSX, for more than a few colors, derive a palette once:

```rust tabs
use nsh_core::prelude::*;

// `dark()` is reactive: the closure runs again when the appearance changes.
view()
    .flex_1()
    .bg(move || if dark() { rgb(0x0d1117) } else { rgb(0xf6f8fa) })
    .child(text("Hello"))
```

```tsx tabs
import { computed, Text, View } from "nsh";
import { colorScheme } from "nsh";

const palette = computed(() =>
  colorScheme() === "dark"
    ? { background: "#0d1117", surface: "#161b22", text: "#e6edf3", muted: "#8b949e" }
    : { background: "#f6f8fa", surface: "#ffffff", text: "#1f2328", muted: "#57606a" },
);

<View style={{ flex: 1, backgroundColor: palette().background }}>
  <Text style={{ color: palette().text }}>Hello</Text>
</View>
```

Rust components also take their colors from the theme, which has light and dark values (`nsh.json` `"theme"`, see [Building with Rust](./rust.md)), so they switch with the system as well. To match the status bar to your background, give your pages and dialogs a [`statusBar`](../modules/nsh-base.md#status-bar), or the app one in `nsh.json`.

### An app with its own appearance

An app that is always dark (or always light) says so in `nsh.json`, and `dark()` and `colorScheme()`, adaptive colors, `dark:` classes, the theme, the status bar's default style and alerts follow it from the first frame (packaged apps also launch in it):

```json
{ "appearance": "dark" }
```

`set_color_scheme(Appearance::Dark)` (TSX: `setColorScheme` from `nsh`) changes it at run time, for an in-app appearance setting; `Appearance::System` (`"system"`) follows the system again:

```rust tabs
use nsh_core::prelude::*;

view()
    .on_press(move || {
        set_color_scheme(if dark() { Appearance::Light } else { Appearance::Dark })
    })
    .role(AccessibilityRole::Button)
    .rounded_lg()
    .px_4()
    .py_2()
    .bg(AdaptiveColor::rgb(0xe5e5e5, 0x262626))
    .child(
        text(|| if dark() { "Light" } else { "Dark" })
            .text_color(AdaptiveColor::rgb(0x171717, 0xfafafa)),
    )
```

```tsx tabs
import { Text, View } from "nsh";
import { colorScheme, setColorScheme } from "nsh";

<View onPress={() => setColorScheme(colorScheme() === "dark" ? "light" : "dark")} role="button" class="rounded-lg px-4 py-2 bg-neutral-200 dark:bg-neutral-800">
  <Text class="text-neutral-900 dark:text-neutral-50">{colorScheme() === "dark" ? "Light" : "Dark"}</Text>
</View>
```

> [!TIP]
> Test both appearances while developing: `xcrun simctl ui booted appearance dark` switches an iOS simulator, and Android has a dark theme toggle in Quick Settings. The change reaches your app at once, without a reload.

## Text size

`font_scale()` (TSX: `fontScale()`) is the user's text size setting (Dynamic Type on iOS, font size on Android) relative to the default. Text and inputs follow it by themselves: `fontSize: 16` renders larger when the user asked for larger text. Per element you can opt out or cap it:

| Rust (on `text` and `input`) | TSX (on `<Text>` and `<Input>`) | Default | Description |
|---|---|---|---|
| `.allow_font_scaling(..)` | `allowFontScaling` | `true` | Follow the system text size. |
| `.max_font_size_multiplier(..)` | `maxFontSizeMultiplier` | `0` (none) | The largest scale applied to this text. |

```rust tabs
text("Today")
    .text_size(px(34.0))
    .font_weight(FontWeight::BOLD)
    .max_font_size_multiplier(1.4)
```

```tsx tabs
<Text style={{ fontSize: 34, fontWeight: "700" }} maxFontSizeMultiplier={1.4}>Today</Text>
```

Read `font_scale()` to adapt layout that does not follow text automatically, such as switching a row to a column when the text gets large: `.style_when(|| font_scale() > 1.3, |s| s.flex_col())` in Rust, `flexDirection: fontScale() > 1.3 ? "column" : "row"` in TSX.

The text size scales text: every text and input that allows font scaling, and the platform's alerts and toasts. Lengths keep their size: spacing, widths and heights, corner radii, borders and images, in points or in classes (`p-4`, `rounded-lg`, `w-[2rem]`). Boxes sized by their content grow with their text.

## Language and region

`locale()` is the user's locale, as a BCP 47 tag (`locale().as_str()` in Rust). In TSX, `Intl` formats numbers and dates for it by default, so `new Intl.NumberFormat().format(1234.5)` gives `1,234.5` in `en-US` and `1.234,5` in `de-DE`. Read `locale()` to pick the strings of your own translations: the texts that read it update when it changes.

```rust tabs
use nsh_core::prelude::*;

fn greeting() -> &'static str {
    match locale().as_str().split('-').next() {
        Some("de") => "Willkommen",
        Some("zh") => "欢迎",
        _ => "Welcome",
    }
}

text(greeting)
```

```tsx tabs
import { Text } from "nsh";
import { locale } from "nsh";

const greetings: Record<string, string> = { en: "Welcome", de: "Willkommen", zh: "欢迎" };

<Text>{greetings[locale().split("-")[0]] ?? greetings.en}</Text>
```

## In an embedding app

An app shown inside a native app follows that app's own settings when it sets them: the embedding APIs' locale and text size (`AppView::set_locale` and `set_font_scale` in Rust on [GPUI](./gpui.md), [macOS](./macos.md), [Linux](./linux.md) and [Windows](./windows.md), `locale` and `fontScale` in Swift on [iOS](./ios.md), `setLocale` and `setFontScale` in Java on [Android](./android.md)) stand in for the system's language and text size. `locale()`, `Intl`, `fontScale()` and text follow them at once, as they follow a system change, and the system's come back when the embedding app clears them. Use them when the native app lets its users choose a language or a text size of its own.

## Safe areas

Notches, the home indicator, the status bar, Android's navigation bar and the Mac Catalyst title bar cover parts of the surface. NSH apps draw edge to edge on every platform, and get the covered parts as insets.

- `safe_area()` (TSX: `safeArea()`) gives the surface's insets.
- A component's `cx.insets()` (TSX: `safeAreaInsets()`) gives the insets **where the component renders**: inside a navigation [page](./navigation.md#safe-areas-under-the-header) they are measured below its header, inside a [dialog](../elements/dialog.md) they are the dialog's. Prefer it in components that may be shown in several places.
- CSS's `env(safe-area-inset-top)`, `-right`, `-bottom` and `-left` pad or space any view by the insets where it renders, in `padding*` and `margin*` (`calc(env(safe-area-inset-bottom) + 8px)` adds a length; Tailwind `pt-[env(safe-area-inset-top)]`; Rust `.p_safe_area()`, `.pt_safe_area()`, `.pb_safe_area_plus(px(8.0))`, ...). The padding updates natively when the insets change ([Safe area](../elements/safe-area.md)).

```rust tabs
use nsh_core::prelude::*;

fn screen() -> impl IntoElement {
    view()
        .pt_safe_area()
        .px_safe_area()
        .flex_1()
        .bg(white())
        .child(content())
        .child(bottom_bar())
}

// A component, for its `Scope`: the insets where it renders.
#[component]
fn BottomBar(cx: Scope<NoEvent>) -> impl IntoElement {
    // `cx.insets()`: the insets where the component renders.
    view()
        .flex_row()
        .pt(px(8.0))
        .pb(move || cx.insets().bottom + px(8.0))
}
```

```tsx tabs
import { View, safeAreaInsets } from "nsh";

function Screen() {
  return (
    <View class="flex-1 bg-white pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <Content />
      <BottomBar />
    </View>
  );
}

function BottomBar() {
  const insets = safeAreaInsets();
  return <View style={{ paddingBottom: insets().bottom + 8, paddingTop: 8, flexDirection: "row" }}>…</View>;
}
```

On Android, a view embedded below a toolbar gets only the parts of the system bars that overlap it, like UIKit's safe area: no top inset if it does not reach the status bar.

## The platform

`os()`, `os_version()`, `idiom()` and `is_desktop()` in Rust, and the `platform` constant from `nsh` in TSX, describe where the app runs. They stay the same while the app runs.

| Rust | TSX | Description |
|---|---|---|
| `os()` | `platform.os` | `Os::Ios`, `Os::Android`, `Os::MacOs`, `Os::Windows`, `Os::Linux` or `Os::Web` (`os().name()` is TSX's string). Mac Catalyst is iOS. |
| `os_version()` | `platform.version` | Major and minor; on Android the API level and 0. |
| `idiom()` | `platform.idiom`, `platform.catalyst` | `Idiom::Phone`, `Pad`, `Mac`, `Tv` or `Desktop`. |
| `is_desktop()` | `platform.idiom === "desktop" && !platform.isTerminal` | macOS, Windows or Linux, or a desktop browser. |

TSX's `platform` in full:

| Member | Description |
|---|---|
| `platform.os` | `"ios"`, `"android"`, `"macos"`, `"windows"`, `"linux"` or `"web"`. Mac Catalyst reports `"ios"`. |
| `platform.version` | A string: iOS and desktops: the OS version (`"17.5"`); Android: the API level (`"35"`); the web: `"0.0"`. |
| `platform.idiom` | `"phone"`, `"pad"`, `"mac"`, `"tv"` or `"desktop"`. `"desktop"` describes the device class: macOS, Windows, Linux and desktop browsers. Use `renderer` to distinguish terminal presentation. |
| `platform.catalyst` | Mac Catalyst in the Mac idiom. |
| `platform.select(spec)` | The value for this platform; see [Platform-specific code](./platform-specific.md#platformselect). |
| `platform.renderer` | `"native"` (platform views / desktop graphics), `"web"` (browser HTML) or `"terminal"` (terminal cells). |
| `platform.isTerminal` | The surface renders in terminal cells; `platform.os` remains the host OS. |

```rust tabs
use nsh_core::{element::Os, prelude::*};

let haptics_supported = os() == Os::Ios || (os() == Os::Android && os_version().0 >= 30);
```

```tsx tabs
import { platform } from "nsh";

const hapticsSupported = platform.os === "ios" || (platform.os === "android" && Number(platform.version) >= 30);
```

`nsh test` runs headless as iOS.

On [Linux](./linux.md), `platform.os` is `"linux"`, the idiom `"desktop"` and `platform.version` the kernel's major
and minor version (`"6.12"`): distributions number their releases in ways that cannot be compared. There, the safe
area and the keyboard height are 0, `colorScheme()` follows the desktop's setting (the XDG settings portal) live,
`fontScale()` the desktop's text scaling and `pixelRatio()` the display's scale, fractional ones included.

On [macOS](./macos.md) (the AppKit backend), `platform.os` is `"macos"`, the idiom `"desktop"` and
`platform.version` the macOS version. The safe area and the keyboard height are 0, `colorScheme()` follows the
system's appearance live, `fontScale()` is 1 and `pixelRatio()` the display's backing scale.

On [Windows](./windows.md), `platform.os` is `"windows"`, the idiom `"desktop"` and `platform.version` `"10.0"`, on
Windows 11 too (Windows kept the version number). The safe area and the keyboard height are 0, `colorScheme()` follows
Settings > Personalization > Colors live, `fontScale()` the Text size setting (1 to 2.25), `reduceMotion()` the
animation effects setting, `pixelRatio()` the monitor's scale, and `Intl` formats in the user's regional format.

In a browser ([the web runtime](./web.md)), `platform.os` is `"web"` and `platform.version` `"0.0"`. The idiom is
`"desktop"` with a mouse and a window at least 600 points wide, `"pad"` on a tablet and `"phone"` on a phone,
decided when the app starts. The locale, `reduceMotion()`, `fontScale()` (the browser's text size), `pixelRatio()`,
the safe area and the keyboard height come from the browser and follow it live.

## Pixel density

`pixel_ratio()` and `round_to_nearest_pixel(points)` in Rust, and `pixelRatio()` from `nsh` in TSX, convert between points and device pixels.

| Rust | TSX | Description |
|---|---|---|
| `pixel_ratio()` | `pixelRatio()` | Device pixels per point (2 or 3 on most phones), reactive. |
| `round_to_nearest_pixel(points)` | `Math.round(x * pixelRatio()) / pixelRatio()` | Points rounded to the nearest device pixel. |

A hairline, one device pixel tall:

```rust tabs
view()
    .h(move || px(1.0 / pixel_ratio()))
    .bg(rgb(0xd0d7de))
```

```tsx tabs
import { View } from "nsh";
import { pixelRatio } from "nsh";

<View style={{ height: 1 / pixelRatio(), backgroundColor: "#d0d7de" }} />
```

`pixel_ratio()` and `pixelRatio()` are reactive, so a hairline follows a window moved to a screen with another density.

## Right to left

When the device language is written right to left (Arabic, Hebrew, Persian, ...), NSH lays the app out right to left: rows run from the right, `left` and `right` style properties swap, text aligns to the right, and native widgets mirror. The layout direction follows the user's language by itself. A view's `direction` style (`"ltr"`, `"rtl"` or `"inherit"`; `.direction(LayoutDirection::..)` in Rust) sets the direction of its subtree; on the root view it sets the app's.

Changes apply at once, without restarting the app; the demo on this page toggles the `direction` style.

Write layouts that work both ways with the logical properties: in Rust `ms` / `me` and `ps` / `pe` (Tailwind's names), in TSX `marginStart` / `marginEnd`, `paddingStart` / `paddingEnd`, `start` / `end`, `borderTopStartRadius` and so on, which mean left and right in left-to-right layouts and the reverse right to left. `left` and `right` themselves also swap. The `direction` style (`"inherit"`, `"ltr"`, `"rtl"`) overrides the direction for a subtree, for example to keep a phone number or a media player's controls left to right. The `rtl:` and `ltr:` Tailwind variants apply per direction.

Horizontal scroll views and lists start at the right end in right-to-left layouts. On Android, the host app must declare `android:supportsRtl="true"` in its manifest for native widgets to mirror.

## Related

- [`nsh`'s device API](../modules/nsh.md#device): the reference.
- [Platform-specific code](./platform-specific.md): `platform.select`, platform props and modules.
- [Accessibility](./accessibility.md): screen readers and reduced motion.
- [Safe area](../elements/safe-area.md), [Keyboard](../elements/keyboard.md) and [the status bar](../modules/nsh-base.md#status-bar).
- [Tailwind](./tailwind.md): `dark:`, breakpoint and orientation variants.
