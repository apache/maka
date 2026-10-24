---
title: nsh/mobile
description: "What iOS and Android both have: isAvailable and TabBar, the system's tab bar."
order: 12.2
---

# nsh/mobile

`nsh/mobile` holds capabilities specific to iOS and Android: today the system's tab bar, `TabBar`. It works on iOS (with iPadOS and Mac Catalyst) and Android. Rust code uses `nsh_core::mobile`; TSX imports
`nsh/mobile`. The module can be imported on every platform, so one bundle runs everywhere: elsewhere its components
take no room and show nothing, and `isAvailable` tells you whether you are on iOS or Android. What only one of them
has is in [nsh/ios](./nsh-ios.md) or [nsh/android](./nsh-android.md), and what only desktops have in
[nsh/desktop](./nsh-desktop.md).

```rust tabs
use nsh_core::mobile::{TabBarItem, tab_bar};
```

```tsx tabs
import { isAvailable, TabBar } from "nsh/mobile";
import type { TabBarItem, TabBarProps } from "nsh/mobile";
```

## Scope

This module exposes capabilities specific to mobile platforms, such as the system tab bar for top-level app navigation. Common controls belong to [`nsh/base`](./nsh-base.md): its [Switch](../elements/switch.md), for example, shares behavior and API across phones, desktops and the web, with the track, thumb and state styles supplied by the app. `TabBar` serves mobile app navigation; `Tabs` serves tabbed content across platforms. Only capabilities with mobile-specific interaction semantics belong here. A system appearance, size or animation alone does not change a common control’s shared role. This distinction guides which capabilities belong here ([Goals and design principles](../docs/goals.md)).

## isAvailable

```ts
const isAvailable: boolean;
```

`true` on iOS, the iOS simulator, Mac Catalyst and Android; `false` elsewhere. Rust:
`matches!(os(), Os::Ios | Os::Android)`.

## TabBar

A tab bar switches between the top-level sections of an app: records and stats, inbox and settings. `TabBar` is the
system's own bar, so it looks and behaves as the system's apps do: `UITabBar` on iOS and iPadOS (Liquid Glass and its
selection on iOS 26), Material 3's navigation bar on Android, in the system's colors, light and dark. The app gives the
tabs (`items`), says which one is selected (`selectedIndex`), hears the user's choice (`onChange`), places the bar with
its `class` and `style`, and shows the selected section's content itself. For tabs inside a page, and on every
platform, use `nsh/base`'s [Tabs](../elements/tabs.md).

```rust tabs
use nsh_core::{
    mobile::{TabBarItem, tab_bar},
    ui::prelude::*,
};

fn sections() -> impl IntoElement {
    let section = signal(0u32);
    view()
        .flex_1()
        .child(text(move || match section.get() {
            0 => "Records",
            _ => "Stats",
        }))
        .child(
            tab_bar()
                .items(vec![
                    TabBarItem::new("Records").icon("list.bullet"),
                    TabBarItem::new("Stats").icon("chart.bar"),
                ])
                .selected_index(section)
                .on_change(move |index: &u32| section.set(*index))
                .absolute()
                .left_0()
                .right_0()
                .bottom_0(),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";
import { platform } from "nsh/device";

function App() {
  const section = signal(0);
  return (
    <View class="flex-1">
      <Text>{section() === 0 ? "Records" : "Stats"}</Text>
      <TabBar
        items={[
          { title: "Records", icon: platform.select({ ios: "list.bullet", android: "ic_records" }) },
          { title: "Stats", icon: platform.select({ ios: "chart.bar", android: "ic_stats" }) },
        ]}
        selectedIndex={section()}
        onChange={(index) => section.set(index)}
        class="absolute inset-x-0 bottom-0"
      />
    </View>
  );
}

mount(App);
```

`TabBar` comes from `nsh/mobile`, `nsh_core::mobile` in Rust. The selection is the app's: a
tap reports `onChange` with the tab's index, the bar shows the choice at once, as the system's does, and the app shows
that section and passes the index back as `selectedIndex`. Its height is the system's where the style leaves it open.
In Rust, `tab_bar()` makes one, with a setter per prop (`.items(..)`, `.selected_index(..)`), a listener per event
(`.on_change(..)`) and the typed style methods; `TabBarItem::new(title).icon(name)` makes a tab.

### Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `TabBarItem[]` | `[]` | The tabs, in order. |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | The selected tab, by index; an index past the tabs selects none. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Where the bar is: its position and size. Its look is the system's. |
| `testID` | `.test_id(..)` | `string` | none | Finds the bar in tests and `nsh test --trace`. |

#### TabBarItem

| Field | Rust | Type | Description |
|---|---|---|---|
| `title` | `TabBarItem::new(title)` | `string` | The tab's title, which screen readers say. |
| `icon` | `.icon(name)` | `string` | The tab's icon, by the platform's name for it: an [SF Symbol](https://developer.apple.com/sf-symbols/) on iOS (`"house"`), a drawable of the app on Android (`res/drawable/home.xml` is `"home"`, `"android:ic_menu_search"` the system's). `platform.select` picks one per platform. |

### Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | The user chose a tab: its index. The bar shows the choice at once; the app shows the tab's content and sets `selectedIndex`. |

### Platform notes

- **iOS and Mac Catalyst**: `UITabBar`, with the system's appearance for the iOS version: the floating Liquid Glass
  bar and its selection on iOS 26. Icons are SF Symbols.
- **Android**: Material 3's navigation bar, made of the platform's views: an icon in its active indicator over each
  label, a ripple on press, the system's dynamic colors on Android 12 and later and Material's baseline colors before,
  light or dark as the app's appearance. At the bottom of the window it reaches under the navigation bar, taller by
  its inset, as Material's does. Icons are drawables of the app (tinted by the bar).
- **Desktops (macOS, Windows, Linux, GPUI) and the web**: the sections show with [Tabs](../elements/tabs.md), in the app's
  look. `TabBar` takes no room there, so one layout holds both, picked by `platform.os`
  ([nsh/device](./nsh-device.md)).
