---
title: Toggle
description: "Toggle and ToggleGroup: a button that is on or off, and a toolbar of them. Each toggle owns presses, keyboard activation, the disabled state and its role and pressed state for screen readers; the group is a toolbar with one stop of the keyboard focus; the look and which toggles are pressed are the app's."
group: base
demo: el-toggle
---

# Toggle

A toggle is a button that stays on or off: bold in a text toolbar, a favorite star, a view option. `Toggle` owns the
behavior of one: presses, keyboard activation, the disabled state, and the button role with its pressed state for
screen readers, which announce it as a toggle button. A `ToggleGroup` around several is a toolbar: screen readers
announce it as one, and the keyboard reaches it in one stop and moves between its toggles with the arrow keys. The
look is the app's: a toggle has no colors, sizes, icon or label of its own. Its children are the app's icon or
label, and `aria-pressed:` classes on the toggle, or `group-aria-pressed:` classes on what is inside it, follow its
state.

```rust tabs
use nsh_base::{theme, toggle, toggle_group};
use nsh_core::prelude::*;

fn formatting() -> impl IntoElement {
    let bold = signal(true);
    let italic = signal(false);
    let item = move |label: &'static str, on: Signal<bool>| {
        toggle()
            .pressed(on)
            .accessibility_label(label)
            .on_change(move |pressed: &bool| on.set(*pressed))
            .size_8()
            .items_center()
            .justify_center()
            .rounded(move || theme().radius)
            .pressed_style(|s| s.bg(move || theme().accent))
            .child(text(&label[..1]).text_sm().text_color(move || {
                if on.get() { theme().accent_foreground } else { theme().muted_foreground }
            }))
    };
    toggle_group()
        .flex_row()
        .self_start()
        .gap_1()
        .child(item("Bold", bold))
        .child(item("Italic", italic))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";

function App() {
  const marks = signal<string[]>(["bold"]);
  const item = (value: string, label: string) => (
    <Toggle
      pressed={marks().includes(value)}
      accessibilityLabel={label}
      onChange={({ pressed }) =>
        marks.set(pressed ? [...marks(), value] : marks().filter((m) => m !== value))
      }
      class="group size-8 items-center justify-center rounded-(--radius) aria-pressed:bg-accent"
    >
      <Text class="text-sm text-muted-foreground group-aria-pressed:text-accent-foreground">{label[0]}</Text>
    </Toggle>
  );
  return (
    <ToggleGroup class="flex-row self-start gap-1">
      {item("bold", "Bold")}
      {item("italic", "Italic")}
    </ToggleGroup>
  );
}

mount(App);
```

`Toggle` and `ToggleGroup` come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is
the app's: each toggle is told whether it is pressed, a press reports the value it asks for with `onChange`, and the
toggle shows the `pressed` the app passes back. The group holds no value either, so how many toggles may be pressed
is the app's too: any number (bold, italic and underline), or exactly one (an alignment, a view switcher), where the
app presses the toggle asked for, lets go of the others and keeps the pressed one pressed. In Rust, `toggle()` and
`toggle_group()` make them, with a setter per prop (`.pressed(..)`), a listener per event (`.on_change(..)`), the
typed style methods and `.child(..)` for their content.

## Props

### Toggle

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `pressed` | `.pressed(..)` | `boolean` | `false` | On or off: screen readers say it is pressed, and `aria-pressed:` styles apply. A press reports the other value with `onChange`; the toggle shows the value the app passes back. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses and no press feedback; `disabled:` styles apply, and screen readers say it is dimmed. A toggle in a disabled `ToggleGroup` is disabled too. |
| `pressedStyle` | `.pressed_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The toggle's style while pressed and not disabled, as `aria-pressed:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say: what the toggle turns on, when its children have no text that says it (an icon). |
| `children` | `.child(..)` | `JSX.Element` | none | The app's icon or label, which screen readers say. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The toggle itself: the surface around its content. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The toggle's style while a press is in progress, hovered, focused or disabled, as the `<state>:` classes. |

### ToggleGroup

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | Every toggle in the group is disabled, whatever its own `disabled`. |
| `children` | `.child(..)` | `JSX.Element` | none | The toggles of the group, and whatever the app lays out between them (a separator). |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The group's layout and look: a column by default, `flex-row` for a row. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` (`Toggle`) | `.on_change(\|pressed: &bool\| ..)` | The toggle was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation. `{ pressed }` is the value it asks for, the opposite of `pressed`. It runs before anything changes: the toggle shows the `pressed` the app passes back. |

An arrow key of a `ToggleGroup` only moves the keyboard focus: it presses nothing. A disabled toggle reports nothing.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The group | | `ToggleGroup`'s `class`, `style` | |
| The toggle | the group, or anywhere | `Toggle`'s `class`, `style` | `aria-pressed:`, `disabled:`, `active:`, `hover:`, `focus:` (or `pressedStyle`, `disabledStyle`, ...) |
| The icon or label | the toggle | its own elements (`children`) | `group-aria-pressed:`, `group-disabled:` and the other `group-*:` variants with `group` on the toggle's `class` |

`aria-pressed:` is the toggle being on; `active:` is a press in progress, on or off. Show a pressed toggle through its
own surface: a fill, a raised pill, a stronger icon (see [Design guides](../docs/design-guides.md#interaction-states)).

## Segmented

A group whose toggles are joined, one pressed at a time, is a segmented control (a view switcher): the app keeps one
value and presses the toggle that names it. The joined look is the app's classes:

```tsx
<ToggleGroup class="flex-row self-start">
  <Each of={["grid", "list"]}>
    {(value) => (
      <Toggle
        pressed={view() === value()}
        accessibilityLabel={`${value()} view`}
        onChange={({ pressed }) => pressed && view.set(value())}
        class="-ml-px h-8 px-3 border border-border first:ml-0 first:rounded-l-(--radius) last:rounded-r-(--radius) aria-pressed:bg-accent"
      >
        <Text class="text-sm">{value()}</Text>
      </Toggle>
    )}
  </Each>
</ToggleGroup>
```

## Disabled

A disabled toggle takes no presses, and screen readers announce it as dimmed. Its `disabled:` classes apply over its
`aria-pressed:` ones, and `group-disabled:` classes inside it follow. `disabled` on a `ToggleGroup` disables every
toggle in it, a toolbar the app locks:

```tsx
<ToggleGroup disabled={readonly()} class="flex-row gap-1">
  <Toggle pressed={bold()} onChange={({ pressed }) => bold.set(pressed)} class="size-8 disabled:opacity-50">
    <Text>B</Text>
  </Toggle>
</ToggleGroup>
```

## Accessibility

- A toggle is one element for screen readers, with the role `"button"` and its pressed state: a toggle button. Its
  label is the text of its children, or `accessibilityLabel`.
- `ToggleGroup` has the role `"toolbar"`: screen readers hear the toggles inside it as one toolbar, each still an
  element of its own.
- `disabled` is announced as the platform announces it (VoiceOver, TalkBack, UI Automation, the browser's accessibility
  tree).
- On macOS and the web the group is one stop of the keyboard focus, and the arrow keys move between its toggles
  (below).

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

On macOS and the web, where Tab reaches the views that take presses, a `ToggleGroup` follows the
[WAI-ARIA toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/):

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Enters the group at the first pressed toggle (the first toggle that is not disabled while none is), and leaves it in one step. |
| Right, Down | Moves the focus to the next toggle, from the last to the first. |
| Left, Up | Moves the focus to the previous toggle, from the first to the last. |
| Home, End | Moves the focus to the first or the last toggle. |
| Space, Return | Presses the focused toggle. |

The arrow keys skip disabled toggles and press nothing: a toggle changes only when it is pressed. Both pairs of arrows
move, whatever the group's layout, which is the app's class. `focus:` styles show where the focus is. A `Toggle`
outside a `ToggleGroup` is a stop of its own.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the toggle, its content included.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Space and Return also
  press the toggle that has the keyboard focus, and the arrow keys, Home and End move it ([Keyboard](#keyboard)).
- Every platform draws what the app styles: the toggles, the pressed ones' surface and the group's track.
