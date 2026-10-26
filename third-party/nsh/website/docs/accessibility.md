---
title: Accessibility
description: Making apps work with VoiceOver and TalkBack - labels, roles, states, values, custom actions, grouping and hiding, announcements and focus, text size, and reduced motion.
order: 48
group: ui
---

# Accessibility

NSH renders with native views, so the platforms' assistive technologies (VoiceOver on iOS and Mac Catalyst, TalkBack on Android, Switch Control, Voice Control, ...) see your app's real view hierarchy. What you add are the descriptions those technologies cannot infer: what an element is, what it says, what state it is in and what it can do. Every element accepts the methods (Rust) and props (TSX) below.

## What you get without doing anything

- **Text is read.** A text element is an accessibility element whose label is its text. A view without a label is read as the texts inside it.
- **Pressable views are elements.** A view with a press or long press handler (`.on_press`, `onPress`) is an accessibility element by default, and activating it (double tap with VoiceOver or TalkBack) presses it.
- **Inputs are text fields**, with their placeholder, value and keyboard.
- **Text follows the user's size setting.** See [Text size](#text-size).

## Labels, hints and roles

```rust tabs
view()
    .on_press(play)
    .role(AccessibilityRole::Button)
    .label("Play")
    .hint("Starts the song")
    .size(px(44.0))
    .items_center()
    .justify_center()
    .child(text("▶"))
```

```tsx tabs
<View
  onPress={play}
  role="button"
  accessibilityLabel="Play"
  accessibilityHint="Starts the song"
  style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
>
  <Text>▶</Text>
</View>
```

| Rust | TSX | Type | Description |
|---|---|---|---|
| `.accessible(..)` | `accessible` | `boolean` | The view is one element for assistive technologies; its children are not exposed separately. |
| `.label(..)` | `accessibilityLabel` | `string` | What screen readers read, instead of the texts inside. |
| `.hint(..)` | `accessibilityHint` | `string` | What activating the element does, read after a pause. |
| `.role(..)` | `role` | `AccessibilityRole` | What the element is. |
| `.accessibility_state(..)` | `accessibilityState` | `AccessibilityState` | Its state: disabled, selected, checked, busy, expanded. `selected` also applies the selected style, `checked` the checked style when true and the indeterminate style when `"mixed"`. |
| `.accessibility_value(..)` | `accessibilityValue` | `{ min?, max?, now?, text? }` | The value of a range or textual element. |
| | `accessibilityActions` | `{ name, label? }[]` | Actions offered to assistive technologies. |
| `.on_accessibility_action(..)` | `onAccessibilityAction` | `(e: { actionName }) => void` | An action was performed (Rust: its name). |
| | `accessibilityElementsHidden` | `boolean` | Hides the view and its subtree from assistive technologies. |
| | `importantForAccessibility` | `"auto" \| "yes" \| "no" \| "no-hide-descendants"` | Whether the view (and its subtree) is exposed. |
| | `android={{ accessibilityLiveRegion }}` | `"none" \| "polite" \| "assertive"` | Android: how changes of the view are announced to TalkBack. |
| `.test_id(..)` | `testID` | `string` | An identifier for UI tests (the accessibility identifier on iOS, the resource id on Android); not read aloud. |

Give every icon-only control a label: a screen reader cannot read a glyph or an image. Keep labels short and do not include the role ("Play", not "Play button"): the role is announced on its own.

### Roles

The role (`.role(AccessibilityRole::Header)`, `role="header"`) tells the user what kind of element this is and how to operate it. In Rust it is an `AccessibilityRole` variant (`Button`, `Header`, `Switch`, ...); the TSX values are `"none"`, `"button"`, `"link"`, `"search"`, `"image"`, `"imagebutton"`, `"keyboardkey"`, `"text"`, `"adjustable"`, `"header"`, `"summary"`, `"alert"`, `"checkbox"`, `"combobox"`, `"menu"`, `"menubar"`, `"menuitem"`, `"progressbar"`, `"radio"`, `"radiogroup"`, `"scrollbar"`, `"spinbutton"`, `"switch"`, `"tab"`, `"tablist"`, `"timer"`, `"toolbar"`, `"list"`, `"grid"`, `"table"`, `"rowgroup"`, `"row"`, `"columnheader"` and `"cell"` (the roles of [`Table`](../elements/table.md)'s parts).

The most useful ones:

- `"button"` for anything pressable that is not a link; `"link"` for navigation to content.
- `"header"` for section titles: screen reader users jump between headers to skim a screen.
- `"switch"`, `"checkbox"`, `"radio"` with `accessibilityState.checked`.
- `"adjustable"` for sliders and steppers, with `accessibilityValue` and the `increment` / `decrement` actions.
- `"image"` for meaningful images, with a label; decorative images should be hidden instead.

```rust tabs
text("Settings")
    .role(AccessibilityRole::Header)
    .text_size(px(22.0))
    .font_weight(FontWeight::BOLD)
```

```tsx tabs
<Text role="header" style={{ fontSize: 22, fontWeight: "700" }}>Settings</Text>
```

### States and values

For an on / off control in an app, use [`Switch`](../elements/switch.md) from `nsh/base`, which sets the role and state itself. The example shows what a role and state on a view do.

```rust tabs
use nsh_core::{Checked, prelude::*};

// A toggle drawn with views.
view()
    .on_press(move || on.update(|v| *v = !*v))
    .role(AccessibilityRole::Switch)
    .label("Wi-Fi")
    .accessibility_state(move || AccessibilityState {
        checked: Some(if on.get() { Checked::True } else { Checked::False }),
        ..AccessibilityState::default()
    })
    .hit_slop(EdgeInsets::all(px(8.0)))
    .w(px(51.0))
    .h(px(31.0))
    .rounded_full()
    .p(px(2.0))
    .bg(move || if on.get() { rgb(0x22c55e) } else { rgb(0xd4d4d8) })
    .child(
        view()
            .size(px(27.0))
            .rounded_full()
            .bg(white())
            .style_with(move |s| s.translate_x(px(if on.get() { 20.0 } else { 0.0 }))),
    )
```

```tsx tabs
// A toggle drawn with views.
<View
  onPress={() => on.set(!on())}
  role="switch"
  accessibilityLabel="Wi-Fi"
  accessibilityState={{ checked: on() }}
  hitSlop={8}
  class="h-[31px] w-[51px] rounded-full p-0.5 transition-colors"
  classList={{ "bg-green-500": on(), "bg-zinc-300": !on() }}
>
  <View class="size-[27px] rounded-full bg-white transition-transform" classList={{ "translate-x-5": on() }} />
</View>
```

The state is `AccessibilityState { disabled, selected, checked: Option<Checked>, busy, expanded }` in Rust and `{ disabled?, selected?, checked?: boolean | "mixed", busy?, expanded? }` in TSX. `disabled` is also implied by disabling the view (`.disabled(..)`, `disabled`). `accessibilityValue` with `min`, `max` and `now` is read as a percentage; with `text` it is read as given ("3 of 10", "Medium").

## Actions

A pressable view supports activation already. For anything else, declare actions with `accessibilityActions` and handle them with `onAccessibilityAction`; a Rust component hears the performed action's name with `.on_accessibility_action(|name: &str| ..)`:

```tsx
function Quantity() {
  const n = signal(1);
  return (
    <View
      accessible
      role="adjustable"
      accessibilityLabel="Quantity"
      accessibilityValue={{ text: String(n()) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (e.actionName === "increment") n.update((v) => v + 1);
        if (e.actionName === "decrement") n.update((v) => Math.max(0, v - 1));
      }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <View onPress={() => n.update((v) => Math.max(0, v - 1))}><Text>−</Text></View>
      <Text>{n()}</Text>
      <View onPress={() => n.update((v) => v + 1)}><Text>+</Text></View>
    </View>
  );
}
```

Some action names are standard and map to the platforms' own gestures:

| Name | iOS (VoiceOver) | Android (TalkBack) |
|---|---|---|
| `activate` | Double tap | Double tap (click) |
| `increment`, `decrement` | Swipe up / down on an adjustable element | Scroll forward / backward |
| `longpress` | | Double tap and hold |
| `expand`, `collapse` | | Expand / collapse |
| `magicTap` | Two-finger double tap | |
| `escape` | Two-finger Z scrub | |

Any other name becomes a custom action, listed in VoiceOver's actions rotor and TalkBack's actions menu with its `label` (or its name). Custom actions are the accessible form of swipe-to-delete and similar gestures:

```tsx
<View
  accessibilityActions={[{ name: "archive", label: "Archive" }, { name: "delete", label: "Delete" }]}
  onAccessibilityAction={(e) => (e.actionName === "archive" ? archive(mail.id) : remove(mail.id))}
>
  …
</View>
```

## Grouping and hiding

Making a view accessible (`.accessible(true)`, `accessible`) makes a view one element: a card with a title, a subtitle and a price is read in one go, instead of the user swiping through three texts.

```rust tabs
view()
    .accessible(true)
    .on_press(open)
    .role(AccessibilityRole::Button)
    .p(px(16.0))
    .child(text("Blue jacket"))
    .child(text("Size M"))
    .child(text("$120"))
```

```tsx tabs
<View accessible onPress={open} role="button" style={{ padding: 16 }}>
  <Text>Blue jacket</Text>
  <Text>Size M</Text>
  <Text>$120</Text>
</View>
```

Hide what adds nothing: decorative images, dividers, an icon next to a text that already says the same.

```tsx
<Image src={decoration} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
```

`accessibilityElementsHidden` (iOS's name) and `importantForAccessibility="no-hide-descendants"` (Android's) both hide the subtree on both platforms; setting both is harmless.

## The screen reader and the user's settings

In Rust, the prelude reports the user's settings and talks to the screen reader: `screen_reader()` and `reduce_motion()` are reactive, `announce_for_accessibility(message)` has the screen reader read a message, and an element's `element_ref()` moves the screen reader's focus to it with `set_accessibility_focus()`. In TSX, `nsh`'s accessibility API reports the user's settings and lets you talk to the screen reader.

| Member | Description |
|---|---|
| `screenReaderEnabled()` | Whether VoiceOver or TalkBack runs (reactive). |
| `reduceMotion()` | Whether the user asked for less motion (reactive). |
| `announce(message)` | The screen reader reads `message`. |
| `setAccessibilityFocus(ref)` | Moves the screen reader's focus to a view. |

The settings are accessors: read them in a binding or an effect, and what reads them updates when the user changes the setting, with no cleanup.

```rust tabs
use nsh_core::prelude::*;

fn upload() -> impl IntoElement {
    let done = signal(false);
    let result = element_ref();
    let finish = move || {
        done.set(true);
        announce_for_accessibility("Upload complete");
        result.set_accessibility_focus();
    };
    view()
        .gap(px(12.0))
        // Autoplaying carousels are hard to use with a screen reader: show a list instead.
        .child(when(move || !screen_reader(), photo_carousel).otherwise(photo_list))
        .child(
            text(move || if done.get() { "Uploaded 3 photos" } else { "Uploading…" })
                .element_ref(&result),
        )
}
```

```tsx tabs
import { signal, Text, View, type YNode } from "nsh";
import { announce, screenReaderEnabled, setAccessibilityFocus } from "nsh";

function Upload() {
  const done = signal(false);
  let result!: YNode;
  const finish = () => {
    done.set(true);
    announce("Upload complete");
    setAccessibilityFocus(result);
  };
  return (
    <View style={{ gap: 12 }}>
      {/* Autoplaying carousels are hard to use with a screen reader: show a list instead. */}
      <If when={!screenReaderEnabled()} else={<PhotoList />}>
        <PhotoCarousel />
      </If>
      <Text ref={result}>{done() ? "Uploaded 3 photos" : "Uploading…"}</Text>
    </View>
  );
}
```

Announce changes the user would otherwise miss: a background save finishing, an error appearing away from the focus, a timer ending. On Android, `android={{ accessibilityLiveRegion: "polite" }}` on a view makes TalkBack announce its changes by itself.

## Text size

Text and inputs follow the system text size (Dynamic Type on iOS, font size on Android) unless you turn it off (`.allow_font_scaling(false)`, `allowFontScaling={false}`). Rather than turning it off, design for it:

- Let text wrap: avoid fixed heights on views that contain text.
- Cap very large headings with `.max_font_size_multiplier(..)` / `maxFontSizeMultiplier` instead of disabling scaling.
- Switch layouts when the text is large: read `font_scale()` (Rust) or `fontScale()` from `nsh` (TSX) (for example, stack a label and its value vertically above 1.3).

See [Device and environment](./device-and-environment.md#text-size).

## Reduced motion

`reduce_motion()` (Rust) and `reduceMotion()` (TSX) are `true` when the user turned on iOS's Reduce Motion or Android's remove animations setting. Your animations run as you write them, so use it, or the `motion-reduce:` and `motion-safe:` Tailwind variants, to replace large movement with a fade or an instant change:

```rust tabs
use nsh_core::{element::LayoutAnimation, prelude::*};

let toggle = move || {
    if !reduce_motion() {
        animate_layout(LayoutAnimation::SPRING);
    }
    expanded.update(|e| *e = !*e);
};

view()
    .on_press(toggle)
    .when(!reduce_motion(), |v| v.active(|s| s.scale(0.95)))
```

```tsx tabs
import { View } from "nsh";
import { reduceMotion } from "nsh";
import { LayoutAnimation } from "nsh";

const toggle = () => {
  if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
  expanded.set(!expanded());
};

<View onPress={open} class="transition active:scale-95 motion-reduce:transition-none" />
<View class="motion-safe:animate-bounce" />
```

## Touch targets

Make pressable elements at least 44 × 44 points. When a control must look smaller, extend its touch area with the hit slop (`.hit_slop(..)`, `hitSlop`) instead of its size; see [Touch and gestures](./touch-and-gestures.md#hit-areas-hitslop).

## Checking your app

- Turn on VoiceOver (iOS Settings, Accessibility, or triple-click the side button if set up) or TalkBack, and use the app without looking: every control should say what it is and what it does.
- On iOS simulators, Xcode's Accessibility Inspector shows each element's label, traits and value.
- Try the largest text size and dark mode.
- A test id (`.test_id(..)`, `testID`) gives UI tests a stable handle that does not change with the label's language.

## Related

- [`nsh`'s accessibility API](../modules/nsh.md#accessibility): the reference.
- [`View`](../elements/view.md): every accessibility prop.
- [Animation](./animation.md#reduced-motion) and [Device and environment](./device-and-environment.md).
