---
title: Toolbar
description: "Toolbar, ToolbarGroup and ToolbarSeparator: a bar of buttons, toggles and links that is one stop of the keyboard focus, whose arrow keys move along it, with named groups and separators. The look and the state of each control are the app's."
group: base
demo: el-toolbar
---

# Toolbar

A toolbar is a bar of controls: a text editor's formatting, a media player's transport, a vertical palette of tools.
`Toolbar` owns the keyboard and the semantics of one: screen readers announce a toolbar (named by its
`accessibilityLabel`), and the keyboard reaches it in one stop and moves between its items with the arrow keys of its
`axis`. Its items are the `Button`s, `Toggle`s and `Link`s inside it, at any depth. A `ToolbarGroup` is a named run of
related items (undo and redo, the alignment), and a `ToolbarSeparator` a line the app draws between runs. The look is
the app's: the toolbar has no colors, padding or gaps of its own, and each control keeps its own state.

```rust tabs
use nsh_base::{button, theme, toggle, toolbar, toolbar_group, toolbar_separator};
use nsh_core::prelude::*;

fn formatting() -> impl IntoElement {
    let bold = signal(false);
    toolbar()
        .accessibility_label("Formatting")
        .items_center()
        .gap_1()
        .child(
            toolbar_group()
                .accessibility_label("History")
                .child(button().accessibility_label("Undo").size_8().child(text("↶")))
                .child(button().accessibility_label("Redo").size_8().child(text("↷"))),
        )
        .child(toolbar_separator().w(px(1.0)).h_5().bg(move || theme().border))
        .child(
            toggle()
                .pressed(bold)
                .accessibility_label("Bold")
                .on_change(move |pressed: &bool| bold.set(*pressed))
                .size_8()
                .items_center()
                .justify_center()
                .pressed_style(|s| s.bg(move || theme().accent))
                .child(text("B")),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Button, Toggle, Toolbar, ToolbarGroup, ToolbarSeparator } from "nsh/base";

function App() {
  const bold = signal(false);
  return (
    <Toolbar accessibilityLabel="Formatting" class="items-center gap-1 self-start rounded-lg bg-muted p-1">
      <ToolbarGroup accessibilityLabel="History">
        <Button accessibilityLabel="Undo" class="size-8 items-center justify-center rounded-md hover:bg-accent">
          <Text>↶</Text>
        </Button>
        <Button accessibilityLabel="Redo" class="size-8 items-center justify-center rounded-md hover:bg-accent">
          <Text>↷</Text>
        </Button>
      </ToolbarGroup>
      <ToolbarSeparator class="h-5 w-px bg-border" />
      <Toggle
        pressed={bold()}
        accessibilityLabel="Bold"
        onChange={({ pressed }) => bold.set(pressed)}
        class="size-8 items-center justify-center rounded-md aria-pressed:bg-accent"
      >
        <Text>B</Text>
      </Toggle>
    </Toolbar>
  );
}

mount(App);
```

`Toolbar`, `ToolbarGroup` and `ToolbarSeparator` come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate
in Rust. The toolbar holds no value: a toggle inside it is told whether it is pressed and reports `onChange`, a
button reports `onPress`, and the app keeps the state. In Rust, `toolbar()`, `toolbar_group()` and
`toolbar_separator()` make them, with a setter per prop (`.axis(..)`, `.disabled(..)`), the typed style methods and
`.child(..)` for their content.

## Props

### Toolbar

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | The direction its items run: the arrow keys that move along it (Left and Right, or Up and Down) and the direction it lays its children out in (a row, or a column). Read when the toolbar is made. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | Every item of the toolbar is disabled, whatever its own `disabled`: no presses, no stop of the keyboard focus, dimmed for screen readers. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the toolbar ("Formatting"), for a page with more than one. |
| `children` | `.child(..)` | `JSX.Element` | none | The items, their groups and separators, and whatever else the app lays out among them (a title, a spacer, an input). |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The bar's layout and look: alignment, gaps, padding, its surface. |

### ToolbarGroup

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | Every item of the group is disabled, whatever its own `disabled`. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the group ("History", "Alignment"). |
| `children` | `.child(..)` | `JSX.Element` | none | The group's items, and whatever the app lays out among them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The group's layout and look. It runs along the toolbar's axis. |

### ToolbarSeparator

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The line: a hairline across a row (`h-5 w-px bg-border`) or a column (`h-px self-stretch bg-border`). |

## Items

The items of a toolbar are the `Button`s, `Toggle`s and `Link`s inside it, in its groups and in a
[`ToggleGroup`](./toggle.md) inside it too. A [`Menu`](./menu.md)'s or a [`Popover`](./popover.md)'s trigger is an
item as well: the view in its `trigger` slot, which the popup gives its presses, its focus and its `expanded` state. A
`ToggleGroup` inside a toolbar is one of its groups: its toggles are the toolbar's items, screen readers hear a group,
and its `disabled` still disables its own toggles. Other controls (an `Input`, a `Select`, a `Slider`) stay stops of
their own and keep their arrow keys; place them at the end of the bar. What a popup an item opens shows (a popover's
fields and buttons, a menu's items) is no part of the toolbar. The arrow keys go through the items in the order the
bar lays them out, however deep each one sits, and an item the app shows later takes its place among them.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The bar | | `Toolbar`'s `class`, `style` | |
| A group | the bar | `ToolbarGroup`'s `class`, `style` | |
| A separator | the bar, a group | `ToolbarSeparator`'s `class`, `style` | |
| An item | the bar, a group | the item's own `class`, `style` | its own: `aria-pressed:`, `disabled:`, `hover:`, `focus:`, `active:` |

Show the item the keyboard is on with `focus:` styles, and a pressed toggle through its own surface (see
[Design guides](../docs/design-guides.md#interaction-states)).

## Vertical

A palette of tools is a column: `axis="vertical"` lays the items out top to bottom, and Up and Down move along them.

```tsx
<Toolbar axis="vertical" accessibilityLabel="Tools" class="gap-1 self-start rounded-lg bg-muted p-1">
  <Each of={["select", "pen", "shape", "text"]}>
    {(t) => (
      <Toggle
        pressed={tool() === t()}
        accessibilityLabel={t()}
        onChange={({ pressed }) => pressed && tool.set(t())}
        class="size-8 items-center justify-center rounded-md aria-pressed:bg-accent"
      >
        <Text>{t()[0].toUpperCase()}</Text>
      </Toggle>
    )}
  </Each>
</Toolbar>
```

## Disabled

`disabled` on a toolbar disables every item in it, a bar the app locks; on a group, the group's items. A disabled item
takes no presses, the arrow keys pass it by, and screen readers announce it as dimmed:

```tsx
<Toolbar disabled={readonly()} accessibilityLabel="Review" class="flex-row gap-1">
  <Button onPress={approve} class="h-8 px-3 disabled:opacity-50">
    <Text>Approve</Text>
  </Button>
</Toolbar>
```

## Accessibility

- `Toolbar` has the role `"toolbar"`, named by `accessibilityLabel`; its items stay elements of their own. On iOS the
  toolbar is a semantic group VoiceOver enters.
- `ToolbarGroup` has the role `"group"`, named by its `accessibilityLabel`, so a run of items reads as one unit. A
  `ToggleGroup` inside a toolbar is a group too.
- `ToolbarSeparator` is no element for screen readers.
- `disabled` is announced as the platform announces it (VoiceOver, TalkBack, UI Automation, the browser's accessibility
  tree).

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

On macOS and the web, where Tab reaches the views that take presses, a `Toolbar` follows the
[WAI-ARIA toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/):

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Enters the toolbar at the item the focus last left (at first, the first item that is not disabled), and leaves it in one step. |
| Right, Left (`axis="horizontal"`) | Moves the focus to the next or the previous item, from the last to the first and back. |
| Down, Up (`axis="vertical"`) | Moves the focus to the next or the previous item, from the last to the first and back. |
| Home, End | Moves the focus to the first or the last item. |
| Space, Return | Presses the focused item. |

The arrow keys skip disabled items and press nothing: a toggle changes only when it is pressed. The other pair of
arrows is left to the items (a menu's trigger opens its menu with Down).

## Platform notes

- iOS, Android and Mac Catalyst: each item is pressed with a tap; the toolbar is a group screen readers announce.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web the toolbar is one stop
  of Tab, and the arrow keys, Home and End move between its items ([Keyboard](#keyboard)).
- Every platform draws what the app styles: the bar, its groups, its separators and its items.
