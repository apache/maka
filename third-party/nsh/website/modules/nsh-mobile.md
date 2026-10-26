---
title: nsh/mobile
description: "What iOS and Android have: TabBar, the system's tab bar, InputAccessoryView on iOS, BackHandler on Android, and isAvailable."
order: 12.2
---

# nsh/mobile

`nsh/mobile` holds the capabilities specific to iOS and Android: the system's tab bar, `TabBar`, on both;
[`InputAccessoryView`](#inputaccessoryview), a bar over the keyboard, on iOS; and [`BackHandler`](#backhandler), the
back button, on Android. Rust code uses `nsh_core::mobile` and `nsh_core::prelude`; TSX imports `nsh/mobile`. The
module can be imported on every platform, so one bundle runs everywhere: on the other platforms its components take no
room and its calls return at once, and `isAvailable` tells you whether you are on iOS or Android (`platform.os` from
`nsh` tells which). What desktops have is in [nsh/desktop](./nsh-desktop.md).

```rust tabs
use nsh_core::mobile::{TabBarItem, tab_bar};
```

```tsx tabs
import { BackHandler, InputAccessoryView, isAvailable, TabBar } from "nsh/mobile";
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
    prelude::*,
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
import { platform } from "nsh";

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
  ([`nsh`'s device API](./nsh.md#device)).

## InputAccessoryView

On iOS and Mac Catalyst; on Android it is an empty hidden view.

```ts
function InputAccessoryView(props: InputAccessoryViewProps): YNode | null;

interface InputAccessoryViewProps {
  nativeID: string;
  style?: StyleProp<ViewStyle>;
  class?: string;
  children?: JSX.Element;
}
```

A bar over the keyboard (UIKit's `inputAccessoryView`), shown while an input whose `ios={{ inputAccessoryViewID }}` matches its `nativeID` has focus. Rust: `input_accessory_view(native_id)`, shown for the inputs whose `.input_accessory(native_id)` matches. It is as wide as the window and as tall as its content, and moves with the keyboard natively.

| Prop | Type | Rust | Description |
|---|---|---|---|
| `nativeID` | `string` | `input_accessory_view(native_id)` | Inputs with this `inputAccessoryViewID` show the bar. |
| `style` | `StyleProp<ViewStyle>` | `Styled` methods (`.bg(…)`) | The bar's style (its background, for example). |
| `class` | `string` | | Tailwind classes. |
| `children` | `JSX.Element` | `.child(…)` | The bar's content. |

It renders nothing where it is placed in the tree, and nothing at all on Android, so you can place it next to the input it belongs to.

```rust tabs
use nsh_core::prelude::*;

#[component]
fn Note() -> impl IntoElement {
    let note = signal(String::new());
    let field = element_ref();
    view()
        .child(
            input()
                .element_ref(&field)
                .value(note)
                .on_change(move |value: &str| note.set(value.to_string()))
                .placeholder("Write a note")
                .input_accessory("note-bar"),
        )
        .child(
            input_accessory_view("note-bar").bg(rgb(0xf1f5f9)).child(
                view()
                    .flex_row()
                    .items_center()
                    .p(px(10.0))
                    .child(
                        text(move || format!("{} characters", note.with(|n| n.chars().count())))
                            .flex_1()
                            .text_color(rgb(0x64748b)),
                    )
                    .child(text("Done").font_weight(FontWeight::SEMIBOLD).on_press(move || field.blur())),
            ),
        )
}
```

```tsx tabs
import { signal, Text, View, type YNode } from "nsh";
import { Input } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function Note() {
  const text = signal("");
  let input: YNode | undefined;
  return (
    <View>
      <Input
        ref={(n) => (input = n)}
        value={text()}
        onChange={(v) => text.set(v)}
        placeholder="Write a note"
        ios={{ inputAccessoryViewID: "note-bar" }}
      />
      <InputAccessoryView nativeID="note-bar" style={{ backgroundColor: "#f1f5f9" }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 10 }}>
          <Text style={{ flex: 1, color: "#64748b" }}>{text().length} characters</Text>
          <Text onPress={() => input?.blur()} style={{ fontWeight: "600" }}>Done</Text>
        </View>
      </InputAccessoryView>
    </View>
  );
}
```

See also [Forms and keyboard](../docs/forms-and-keyboard.md).

## BackHandler

On Android; on iOS its listeners are kept and never called, and `exitApp()` returns at once.

```ts
const BackHandler: {
  onBackPress(listener: () => boolean | void): () => void;
  exitApp(): void;
};
```

The system back button and back gesture. Dialogs handle the back press first (a dialog closes); then `BackHandler`'s listeners run, the most recently added first; when none of them handles it, the top navigation stack pops, and with no page to go back to the app exits.

| Member | Rust | Description |
|---|---|---|
| `onBackPress(listener)` | `on_back_press(listener)` | `listener` returns `true` when it handled the press. Returns a function that stops listening; a listener added while a component renders (or an effect runs) stops with it, in Rust and TSX alike. |
| `exitApp()` | the listener returns `false` | Leaves the app. A Rust listener that returns `false` lets the press go on, so the stack goes back or the app exits. |

```rust tabs
use nsh_base::alert_dialog;
use nsh_core::prelude::*;

#[component]
fn Editor() -> impl IntoElement {
    let dirty = signal(false);
    on_back_press(move || {
        if !dirty.get_untracked() {
            return false; // let the app go back or exit
        }
        spawn(async move {
            let answer = alert_dialog().title("Discard changes?").cancel("Keep").destructive("Discard").show().await;
            if answer == Ok(Some("Discard".into())) {
                dirty.set(false); // the next back press leaves
            }
        });
        true
    });
    // ...
}
```

```tsx tabs
import { signal } from "nsh";
import { BackHandler } from "nsh/mobile";
import { AlertDialog } from "nsh/base";

function Editor() {
  const dirty = signal(false);
  // Stops listening when Editor goes.
  BackHandler.onBackPress(() => {
    if (!dirty()) return false; // let the app go back or exit
    AlertDialog.show({
      title: "Discard changes?",
      actions: [{ label: "Keep", role: "cancel" }, { label: "Discard", role: "destructive", id: "discard" }],
    }).then((id) => id === "discard" && BackHandler.exitApp());
    return true;
  });
  // ...
}
```

> [!NOTE]
> The listener runs after the system has delivered the press: the main thread never waits for the app's code. While at least one listener is registered, NSH takes back presses that dialogs leave, and goes back in the top stack or exits the app itself when no listener returns `true`.

The status bar is set by the `statusBar` of [pages and dialogs](./nsh-base.md#status-bar) from `nsh/base`, on iOS and Android alike.
