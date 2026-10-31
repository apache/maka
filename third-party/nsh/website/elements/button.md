---
title: Button
description: "The Button component: a press target that owns presses, the disabled and selected states and its role for screen readers, styled by the app."
group: base
demo: el-button
---

# Button

A button is a press target. It owns the behavior: presses, press feedback through the app's state styles, the
disabled and selected states, keyboard focus, and its role for screen readers. The look is the app's: a `Button` has no colors, sizes, paddings or label of its own, so one component becomes a primary button,
an icon button, a tab, a toolbar toggle or the row of a list, depending on the styles and children you give it.

```rust tabs
use nsh_base::button;
use nsh_core::prelude::*;

fn counter() -> impl IntoElement {
    let count = signal(0_u32);
    button()
        .on_press(move || count.update(|n| *n += 1))
        .self_center()
        .px_5()
        .py_3()
        .rounded_xl()
        .bg(rgb(0x2563eb))
        .active(|s| s.bg(rgb(0x1d4ed8)))
        .child(
            text(move || format!("Pressed {}", count.get()))
                .text_color(white())
                .font_weight(FontWeight::SEMIBOLD),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Button } from "nsh/base";

function App() {
  const count = signal(0);
  return (
    <Button
      onPress={() => count.update((n) => n + 1)}
      class="self-center rounded-xl bg-blue-600 px-5 py-3 active:bg-blue-700"
    >
      <Text class="text-base font-semibold text-white">{`Pressed ${count()}`}</Text>
    </Button>
  );
}

mount(App);
```

`Button` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In TSX its look is `class` and
`style`, with the state variants `active:`, `hover:`, `focus:`, `selected:` and `disabled:` (or the matching
`activeStyle`, `hoverStyle`, `focusStyle`, `selectedStyle` and `disabledStyle`). In Rust, `button()` makes one as
`view()` makes a view: a setter per prop (`.disabled(..)`, `.selected(..)`), a listener per event (`.on_press(..)`),
the typed style methods (`.px_4()`, `.bg(..)`) for its look, the state methods (`.active(..)`, `.hover(..)`,
`.focus(..)`, `.selected_style(..)`, `.disabled_style(..)`) for its states and `.child(..)` for its content.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses and no press feedback; `disabled:` styles apply and screen readers say it is dimmed. |
| `selected` | `.selected(..)` | `boolean` | `false` | Selected: a toggle that is on, the current tab. Screen readers say so. The app owns the value and styles it. |
| `selectedStyle` | `.selected_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The style while `selected` and not disabled, as `selected:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say when the content is not enough, as for an icon. |
| `role` | `.role(..)` | `AccessibilityRole` | `"button"` | What it is for screen readers when no `nsh/base` component is that control: `"link"` (it opens a URL), ... |
| `children` | `.child(..)` | `JSX.Element` | none | The content: text, an icon, any layout. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Its look, all of it. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The style while pressed, hovered, focused or disabled, as the `<state>:` classes. Later states win; `disabled` wins over all. |

In Rust each prop is a setter that takes a value, a signal or a closure; the props you leave out keep their defaults:

```rust
button()
    .disabled(move || saving.get())
    .accessibility_label("Save")
```

## Events

| Event | Rust | Description |
|---|---|---|
| `onPress` | `.on_press(\|\| ..)` | The button was pressed: a tap, a click, Return or Space while it has the keyboard focus, or a screen reader's activation. |
| `onPressDown` | `.on_press_down(\|\| ..)` | A press went down on it. |
| `onPressUp` | `.on_press_up(\|\| ..)` | The press ended: released, moved away or cancelled. |

`onPressDown` and `onPressUp` are for press feedback of your own, such as a spring or a highlight that the state
styles do not express. A disabled button reports none of them.

## Styling

The look of a button is your app's: the app decides what a primary or a secondary button is. A pair of small components keeps
that decision in one place:

```rust tabs
use nsh_base::button;
use nsh_core::prelude::*;

/// A filled button, darker while pressed.
fn primary(label: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .items_center()
        .rounded_lg()
        .px_4()
        .py_3()
        .bg(rgb(0x2563eb))
        .active(|s| s.bg(rgb(0x1d4ed8)))
        .disabled_style(|s| s.opacity(0.4))
        .child(text(label).text_color(white()).font_weight(FontWeight::SEMIBOLD))
}

/// An outlined button.
fn secondary(label: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .items_center()
        .rounded_lg()
        .px_4()
        .py_3()
        .border_1()
        .border_color(rgb(0xd4d4d4))
        .hover(|s| s.bg(rgb(0xfafafa)))
        .active(|s| s.bg(rgb(0xf5f5f5)))
        .child(text(label).text_color(rgb(0x171717)))
}
```

```tsx tabs
import { Text } from "nsh";
import { Button } from "nsh/base";

function Primary(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class="items-center rounded-lg bg-blue-600 px-4 py-3 active:bg-blue-700 disabled:opacity-40"
    >
      <Text class="font-semibold text-white">{props.label}</Text>
    </Button>
  );
}

function Secondary(props: { label: string; onPress: () => void }) {
  return (
    <Button
      onPress={props.onPress}
      class="items-center rounded-lg border border-neutral-300 px-4 py-3 active:bg-neutral-100 hover:bg-neutral-50"
    >
      <Text class="text-neutral-900">{props.label}</Text>
    </Button>
  );
}
```

The state variants are applied natively: a press darkens the button on the main thread with no JS or Rust running.
In Rust the state methods are the same variants: `.active(..)`, `.hover(..)`, `.focus(..)`, `.selected_style(..)` and
`.disabled_style(..)` follow the button's own states. Your theme's colors work the same way: `bg-primary` in TSX,
`theme().primary` in Rust (see [Theme tokens](../docs/tailwind.md#theme-tokens)).

## Disabled

A disabled button takes no presses and gives no feedback, and screen readers announce it as dimmed. Its look while
disabled is yours, with `disabled:` classes or `disabledStyle`:

```rust tabs
fn save(saving: Signal<bool>) -> impl IntoElement {
    button()
        .disabled(saving)
        .on_press(move || saving.set(true))
        .rounded_lg()
        .px_4()
        .py_3()
        .bg(rgb(0x2563eb))
        .disabled_style(|s| s.opacity(0.4))
        .child(text("Save").text_color(white()))
}
```

```tsx tabs
<Button disabled={saving()} onPress={save} class="rounded-lg bg-blue-600 px-4 py-3 disabled:opacity-40">
  <Text class="text-white">Save</Text>
</Button>
```

## A toggle with selected

`selected` makes a button a toggle: a toolbar's bold button, a filter chip, the current tab. The app holds the value,
flips it in `onPress` and styles the selected state; screen readers announce the button as selected.

```rust tabs
fn bold(on: Signal<bool>) -> impl IntoElement {
    button()
        .selected(on)
        .accessibility_label("Bold")
        .on_press(move || on.update(|on| *on = !*on))
        .size(px(40.0))
        .items_center()
        .justify_center()
        .rounded_md()
        .selected_style(|s| s.bg(rgb(0xdbeafe)))
        .child(text("B").font_weight(FontWeight::BOLD))
}
```

```tsx tabs
<Button
  selected={bold()}
  onPress={() => bold.set(!bold())}
  accessibilityLabel="Bold"
  class="size-10 items-center justify-center rounded-md selected:bg-blue-100"
>
  <Text class="font-bold">B</Text>
</Button>
```

A row of tabs is [`Tabs`](./tabs.md) and an on / off control is [`Switch`](./switch.md), from `nsh/base`: they own the role, the selected state and the keyboard of their kind, which a `Button` with `role="tab"` or `role="switch"` does not.

## Accessibility

- A button is one element for screen readers, with the role `"button"` unless `role` says otherwise. Its label is its
  text content; give `accessibilityLabel` when the content is an icon or says too little.
- `disabled` and `selected` are announced as the platform announces them (VoiceOver, TalkBack, UI Automation, the
  browser's accessibility tree).
- On macOS and the web a button is a stop of the keyboard focus: Tab reaches it, Return and Space press it, and
  `focus:` styles show where the focus is.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the button; moving away cancels it, as with the
  system's own buttons.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Return and Space also
  press the button that has the keyboard focus. `hover:` styles apply under a mouse or a trackpad's pointer.
- Every platform draws what the app styles: press feedback is `active:` / `activeStyle` or an animation of your own.
