---
title: nsh/mobile
description: "What iOS and Android have: TabBar, the system's tab bar, DateTimePicker, the system's date and time picker, SegmentedControl, the system's segmented control on iOS, Switch, the system's switch, Haptics, InputAccessoryView on iOS, BackHandler on Android, and isAvailable."
order: 12.2
---

# nsh/mobile

`nsh/mobile` holds the capabilities specific to iOS and Android: the system's tab bar, `TabBar`,
[`DateTimePicker`](#datetimepicker), the system's date and time picker, [`Switch`](#switch), the system's switch, and
[`Haptics`](#haptics), the device's haptic feedback, on both;
[`SegmentedControl`](#segmentedcontrol), the system's segmented control, and
[`InputAccessoryView`](#inputaccessoryview), a bar over the keyboard, on iOS; and [`BackHandler`](#backhandler), the
back button, on Android. Rust code uses `nsh_core::mobile` and `nsh_core::prelude`; TSX imports `nsh/mobile`. The
module can be imported on every platform, so one bundle runs everywhere: on the other platforms its components take no
room and its calls return at once, and `isAvailable` tells you whether you are on iOS or Android (`platform.os` from
`nsh` tells which). What desktops have is in [nsh/desktop](./nsh-desktop.md).

```rust tabs
use nsh_core::mobile::{
    DateTimePickerMode, DateTimePickerValue, SegmentedControlItem, TabBarItem, date_time_picker, segmented_control,
    switch, tab_bar,
};
```

```tsx tabs
import {
  BackHandler,
  DateTimePicker,
  Haptics,
  InputAccessoryView,
  isAvailable,
  SegmentedControl,
  Switch,
  TabBar,
} from "nsh/mobile";
import type {
  DateTimePickerMode,
  DateTimePickerProps,
  SegmentedControlItem,
  SegmentedControlProps,
  SwitchProps,
  TabBarItem,
  TabBarProps,
} from "nsh/mobile";
```

## Scope

This module exposes capabilities specific to mobile platforms, such as the system tab bar for top-level app navigation. Common controls belong to [`nsh/base`](./nsh-base.md): its [Switch](../elements/switch.md), for example, shares behavior and API across phones, desktops and the web, with the track, thumb and state styles supplied by the app. `TabBar` serves mobile app navigation; `Tabs` serves tabbed content across platforms. Only capabilities with mobile-specific interaction semantics belong here. A system appearance, size or animation alone does not change a common control’s shared role. This distinction guides which capabilities belong here ([Goals and design principles](../docs/goals.md)). `SegmentedControl` is the system's own control for an app that needs exactly the iOS one; a choice in the app's look, on every platform, is `nsh/base`'s [ToggleGroup](../elements/toggle.md) or [RadioGroup](../elements/radio.md). Likewise `DateTimePicker` is the system's own date and time picker on phones; a picker in the app's look, on every platform, is `nsh/base`'s [DatePicker](../elements/date-picker.md) or [TimeField](../elements/time-field.md). `Switch` is the same: the system's own switch for an app that wants exactly the iOS and Android ones; a switch in the app's look, on every platform, is `nsh/base`'s [Switch](../elements/switch.md).

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
        onChange={({ index }) => section.set(index)}
        class="absolute inset-x-0 bottom-0"
      />
    </View>
  );
}

mount(App);
```

`TabBar` comes from `nsh/mobile`, `nsh_core::mobile` in Rust. The selection is the app's: a
tap reports `onChange` with the tab's index (`{ index }`), the bar shows the choice at once, as the system's does, and the app shows
that section and passes the index back as `selectedIndex`. Its height is the system's where the style leaves it open.
In Rust, `tab_bar()` makes one, with a setter per prop (`.items(..)`, `.selected_index(..)`), a listener per event
(`.on_change(..)`) and the typed style methods; `TabBarItem::new(title).icon(name).badge(text)` makes a tab.

### Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `TabBarItem[]` | `[]` | The tabs, in order. |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | The selected tab, by index; an index past the tabs selects none. |
| `hidden` | `.hidden(..)` | `boolean` | `false` | iOS: hides the bar without a transition. The app owns this value across pushes and pops. The bar shows when both this prop and the visible stack’s `hidesBottomBarWhenPushed` request are false. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Where the bar is: its position and size. Its look is the system's, with the selected tab in the theme's `primary`. |
| `testID` | `.test_id(..)` | `string` | none | Finds the bar in tests and `nsh test --trace`. |

#### TabBarItem

| Field | Rust | Type | Description |
|---|---|---|---|
| `title` | `TabBarItem::new(title)` | `string` | The tab's title, which screen readers say. |
| `icon` | `.icon(name)` | `string` | The tab's icon, by the platform's name for it: an [SF Symbol](https://developer.apple.com/sf-symbols/) on iOS (`"house"`), a drawable of the app on Android (`res/drawable/home.xml` is `"home"`, `"android:ic_menu_search"` the system's). `platform.select` picks one per platform. |
| `badge` | `.badge(text)` | `string` | The tab's badge: a text such as `"3"` or `"New"`, or `""` for a badge with no text; left out (the default), none. In the system's badge look; screen readers say it with the tab's title: its text, or for `""` the system's words for a badge with no text (VoiceOver's; on Android the system's "New notification", in the device's language). |

### Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | The user chose a tab: `{ index }`, its index. The bar shows the choice at once; the app shows the tab's content and sets `selectedIndex`. |

### Platform notes

- **iOS and Mac Catalyst**: `UITabBar`, with the system's appearance for the iOS version: the floating Liquid Glass
  bar and its selection on iOS 26. Icons are SF Symbols. The theme's `primary` is the bar's `tintColor`, the selected
  tab's color; the other tabs keep the system's. A badge is the item's `badgeValue`: a text in full, `""` the
  system's badge with no text, as large as a one-digit one.
- **Android**: Material 3's navigation bar, made of the platform's views: an icon in its active indicator over each
  label, a ripple on press, the system's dynamic colors on Android 12 and later and Material's baseline colors before,
  light or dark as the app's appearance. At the bottom of the window it reaches under the navigation bar, taller by
  its inset, as Material's does. Icons are drawables of the app (tinted by the bar). The selected tab's icon and label
  take the theme's `primary`, over an active indicator of it at 12% opacity; the other tabs keep the system's. A badge
  is Material 3's: `""` the small badge (a dot) at the icon's corner, a text the large badge from the icon's middle,
  in its error colors, ending in an ellipsis past the active indicator. The large badge holds a short text, a count
  or a word of up to four characters, as Material's does: a longer one is cut (`"Updated"` shows as "Up…"), where iOS
  shows it whole. TalkBack says `""` as the system's "New notification".
- **Desktops (macOS, Windows, Linux, GPUI) and the web**: the sections show with [Tabs](../elements/tabs.md), in the app's
  look. `TabBar` takes no room there, so one layout holds both, picked by `platform.os`
  ([`nsh`'s device API](./nsh.md#device)).

## SegmentedControl

A segmented control picks one of a few options in place: light or dark, day, week or month. `SegmentedControl` is
the system's own `UISegmentedControl` on iOS and iPadOS, so it has the system's look (Liquid Glass on iOS 26 and
later), its motion, VoiceOver ("Light, button, selected, 1 of 2") and its keyboard focus.

```tsx
import { signal } from "nsh";
import { SegmentedControl } from "nsh/mobile";

const appearance = signal(0);

<SegmentedControl
  items={[{ title: "Light", icon: "sun.max" }, { title: "Dark", icon: "moon" }]}
  selectedIndex={appearance()}
  onChange={({ index }) => appearance.set(index)}
  style={{ alignSelf: "stretch" }}
/>;
```

The selection is the app's: a tap reports `onChange` with the segment's index (`{ index }`), the control shows the
choice at once, as the system's does, and the app passes the index back as `selectedIndex`. New `items` change the
segments in place (the same number of segments keeps the control as it is, so a renamed or disabled segment does not
flash). Its size is the system's where the style leaves it open; a width the style gives is shared by the segments. In
Rust, `segmented_control()` makes one, with a setter per prop and `.on_change(..)`;
`SegmentedControlItem::new(title).icon(name).disabled(true)` makes a segment.

### Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `SegmentedControlItem[]` | `[]` | The segments, in order. |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | The selected segment, by index; an index past the segments selects none. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No segment can be chosen: the system dims the control. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Where the control is: its position and size. Its look is the system's. |
| `testID` | `.test_id(..)` | `string` | none | Finds the control in tests and `nsh test --trace`. |

#### SegmentedControlItem

| Field | Rust | Type | Description |
|---|---|---|---|
| `title` | `SegmentedControlItem::new(title)` | `string` | The segment's title: what it shows, and what VoiceOver says. |
| `icon` | `.icon(name)` | `string` | An [SF Symbol](https://developer.apple.com/sf-symbols/) shown in place of the title, which VoiceOver still says. |
| `disabled` | `.disabled(..)` | `boolean` | The segment cannot be chosen. |

### Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | The user chose another segment: `{ index }`. The control shows the choice at once; the app sets `selectedIndex`. |

### Platform notes

- **iOS and Mac Catalyst**: `UISegmentedControl` in the system's appearance for the iOS version and the SDK the app
  is linked with: Liquid Glass on iOS 26 and later.
- **Android, the desktops and the web**: `SegmentedControl` takes no room and shows nothing, so one layout holds both:
  show the choice with [ToggleGroup](../elements/toggle.md) or [RadioGroup](../elements/radio.md) there, picked by
  `platform.os`.

## Switch

A switch turns one setting on or off. `Switch` is the system's own: a `UISwitch` on iOS and iPadOS, Material 3's
switch on Android. It has the system's look (Liquid Glass on iOS 26 and later), its motion as it is flipped or
dragged, its haptics and the screen reader's reading ("Wi-Fi, switch button, on").

```tsx
import { signal } from "nsh";
import { Switch } from "nsh/mobile";

const wifi = signal(true);

<Switch accessibilityLabel="Wi-Fi" checked={wifi()} onChange={({ checked }) => wifi.set(checked)} />;
```

The value is the app's: a flip reports `onChange` with the value the user asked for (`{ checked }`), the switch
moves at once, as the system's does, and the app passes the value back as `checked`. A value the app keeps (it turns
the flip down) moves the switch back. Its size is the system's where the style leaves it open, so a row places it with
its other content. It is on in the theme's `primary` color; without one, the system's. In Rust, `switch()` makes one,
with a setter per prop and `.on_change(..)`.

### Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | On or off. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It cannot be flipped: the system dims it. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say with its state: the setting it turns on. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Where the switch is. Its look and size are the system's. |
| `testID` | `.test_id(..)` | `string` | none | Finds the switch in tests and `nsh test --trace`. |

### Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|checked: &bool\| ..)` | The user flipped the switch: `{ checked }`, the value it asks for. The switch moves at once; the app sets `checked`. |

### Platform notes

- **iOS and Mac Catalyst**: `UISwitch` in the system's appearance for the iOS version and the SDK the app is linked
  with: Liquid Glass on iOS 26 and later.
- **Android**: the framework's switch drawn as Material 3's: its track and thumb, in the system's dynamic colors on
  Android 12 and later (Material's baseline colors before), following the app's light or dark appearance.
- **The desktops and the web**: `Switch` takes no room and shows nothing, so one layout holds both: show the setting
  with `nsh/base`'s [Switch](../elements/switch.md) there, picked with `isAvailable`.

## DateTimePicker

A date and time picker sets a day, a time of day or both: a reminder's time, a schedule's end date. `DateTimePicker`
is the system's own picker, so it has the system's look, formats, calendar and accessibility: on iOS and iPadOS a
`UIDatePicker` in its compact style, the value in a capsule that opens the system's calendar or time wheels; on
Android the value in a field that opens the system's date or time dialog.

```tsx
import { signal } from "nsh";
import { DateTimePicker } from "nsh/mobile";

const at = signal("2026-11-17T09:30");

<DateTimePicker
  mode="dateTime"
  value={at()}
  min="2026-11-17T00:00"
  minuteInterval={5}
  accessibilityLabel="Reminder"
  onChange={({ value }) => at.set(value)}
/>;
```

Values are ISO strings in the mode's form, as HTML's date and time inputs take them: `"2026-11-17"` for `date`,
`"09:30"` for `time`, `"2026-11-17T09:30"` for `dateTime`. They are wall-clock times: the picker shows them as they
are, and the app ties them to the time zone it means. The value is the app's: a pick reports `onChange` with the new
value (`{ value }`), the picker shows it at once, as the system's does, and the app passes it back as `value`. Without
a value the picker shows the present. A value, `min` or `max` in another mode's form is not shown as something else:
NSH logs a warning and leaves it out. Its size is the system's where the style leaves it open. In Rust,
`date_time_picker()` makes one, with a setter per prop and `.on_change(..)`; values are `DateTimePickerValue`s, made
from `chrono`'s `NaiveDate`, `NaiveTime` and `NaiveDateTime`.

### Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `mode` | `.mode(..)` | `"date" \| "time" \| "dateTime"` | `"date"` | What it picks: a day, a time of day, or both. |
| `value` | `.value(..)` | `string \| null` | `null` | The value shown, in the mode's form; `null` shows the present. |
| `min` | `.min(..)` | `string \| null` | `null` | The earliest value the user can pick. |
| `max` | `.max(..)` | `string \| null` | `null` | The latest value the user can pick. |
| `minuteInterval` | `.minute_interval(..)` | `number` | `1` | The minutes offered are this many apart: 1 to 30, a divisor of 60. Other numbers log a warning and step by 1. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It cannot be changed: the system dims it. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say with its value: what it sets. The picker shows only the value, so give the name of the row it sits in. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Where the picker is: its position and size. Its look is the system's. |
| `testID` | `.test_id(..)` | `string` | none | Finds the picker in tests and `nsh test --trace`. |

### Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value: &DateTimePickerValue\| ..)` | The user picked a value: `{ value }`, in the mode's form. The picker shows it at once; the app sets `value`. |

### Platform notes

- **iOS and Mac Catalyst**: `UIDatePicker` in its compact style; with `dateTime` the day and the time are two capsules.
  The calendar and the time wheels are the system's, in the user's locale, calendar and clock.
- **Android**: the value in the system's formats and the user's 12- or 24-hour clock, in a field per part; a press
  opens the system's date or time dialog. The time dialog offers every minute: a pick between two steps of
  `minuteInterval` takes the step before it, and a pick past `min` or `max` takes the bound.
- **The desktops and the web**: `DateTimePicker` takes no room and shows nothing, so one layout holds both: pick with
  [DatePicker](../elements/date-picker.md) or [TimeField](../elements/time-field.md) there, chosen by `platform.os`.

## InputAccessoryView

On iOS and Mac Catalyst; on Android it is an empty hidden view.

```ts
function InputAccessoryView(props: InputAccessoryViewProps): JSX.Element;

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
import { type InputRef, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function Note() {
  const text = signal("");
  let input: InputRef | undefined;
  return (
    <View>
      <Input
        ref={(n) => (input = n)}
        value={text()}
        onChange={({ value }) => text.set(value)}
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
  on(event: "press", listener: () => boolean | void): () => void;
  exitApp(): void;
};
```

The system back button and back gesture. Dialogs handle the back press first (a dialog closes); then `BackHandler`'s listeners run, the most recently added first; when none of them handles it, the top navigation stack pops, and with no page to go back to the app exits.

| Member | Rust | Description |
|---|---|---|
| `on("press", listener)` | `on_back_press(listener)` | `listener` returns `true` when it handled the press. Returns a function that stops listening; a listener added while a component renders (or an effect runs) stops with it, in Rust and TSX alike. |
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
            let answer = alert_dialog().title("Discard changes?").cancel("keep", "Keep").destructive("discard", "Discard").show().await;
            if answer.is_ok_and(|r| r.action.as_deref() == Some("discard")) {
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
  BackHandler.on("press", () => {
    if (!dirty()) return false; // let the app go back or exit
    AlertDialog.show({
      title: "Discard changes?",
      actions: [{ label: "Keep", role: "cancel", id: "keep" }, { label: "Discard", role: "destructive", id: "discard" }],
    }).then(({ action }) => action === "discard" && BackHandler.exitApp());
    return true;
  });
  // ...
}
```

> [!NOTE]
> The listener runs after the system has delivered the press: the main thread never waits for the app's code. While at least one listener is registered, NSH takes back presses that dialogs leave, and goes back in the top stack or exits the app itself when no listener returns `true`.

## Haptics

On iOS and Android; elsewhere its calls return at once.

```ts
const Haptics: {
  selection(): void;
  impact(style?: "light" | "medium" | "heavy" | "soft" | "rigid"): void;
  notification(kind?: "success" | "warning" | "error"): void;
};
```

The device plays a haptic under the user's finger: a selection that changed, an element that collided, a task that ended. On iOS it is a feedback generator's (`UISelectionFeedbackGenerator`, `UIImpactFeedbackGenerator`, `UINotificationFeedbackGenerator`); on Android, the view's haptic feedback. Nothing plays on a device without haptics, nor when the user turned them off (Android's touch feedback setting, iOS's system haptics).

| Member | Rust | Description |
|---|---|---|
| `selection()` | `haptic(Haptic::Selection)` | A selection changed: a picker's value, a segment, a slider's step. |
| `impact(style)` | `haptic(Haptic::Impact(HapticImpact::Medium))`, ... | An element collided; `style` is its weight, `"medium"` by default. |
| `notification(kind)` | `haptic(Haptic::Notification(HapticNotification::Success))`, ... | A task succeeded, produced a warning or failed; `"success"` by default. |

A name it does not know throws a `TypeError`. Android has no constant for every haptic: it plays the closest one (`CONFIRM` and `REJECT` for success and error, from Android 11; a long press for a warning and, before Android 11, for an error).

```rust tabs
use nsh_core::prelude::*;

fn save_button() -> impl IntoElement {
    view().child(text("Save")).on_press(|_| {
        spawn(async {
            let saved = save().await;
            haptic(if saved.is_ok() {
                Haptic::Notification(HapticNotification::Success)
            } else {
                Haptic::Notification(HapticNotification::Error)
            });
        });
    })
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Haptics } from "nsh/mobile";

function SaveButton() {
  return (
    <View
      onPress={async () => {
        const saved = await save();
        Haptics.notification(saved ? "success" : "error");
      }}
    >
      <Text>Save</Text>
    </View>
  );
}
```

The status bar is set by the `statusBar` of [pages and dialogs](./nsh-base.md#status-bar) from `nsh/base`, on iOS and Android alike.
