---
title: Menu
description: "Menu and ContextMenu with MenuItem, MenuSeparator and Submenu: a popup with cascading submenus on desktops, a sheet with submenus in place on phones, styled by the app."
order: 27
group: base
demo: el-menu
---

# Menu

A menu is a list of actions its trigger opens. One structure serves every device, presented as each expects:

- On the desktops and in desktop browsers, a popup at the trigger; a `Submenu` cascades beside its item as the
  pointer comes over it or presses it.
- On phones and tablets, a sheet at the bottom of the screen over a backdrop; a `Submenu` shows its items in the
  sheet in place of the menu's, with a row of yours leading back.

Choosing an item, a press outside, Escape, the Android back button and VoiceOver's escape gesture close it. `ContextMenu` is the same menu opened
by the secondary button (a right click) at the pointer, or by a finger held on its trigger on touch screens.

```rust tabs
use nsh_base::{menu, menu_item, menu_separator, submenu};
use nsh_core::prelude::*;

fn item(label: &'static str, on_select: impl Fn() + 'static) -> impl IntoElement {
    menu_item()
        .on_select(on_select)
        .px_3()
        .py_2()
        .rounded_md()
        .child(text(label))
}

fn file_menu() -> impl IntoElement {
    menu()
        .offset(px(4.0))
        .trigger(view().px_3().py_2().child(text("File")))
        .child(item("New", || log::info!("new")))
        .child(item("Open…", || log::info!("open")))
        .child(menu_separator().h(px(1.0)).my_1().bg(rgb(0xe5e7eb)))
        .child(
            submenu()
                .trigger(view().px_3().py_2().child(text("Share ›")))
                .back(view().px_3().py_2().child(text("‹ Back")))
                .child(item("Mail", || log::info!("mail")))
                .child(item("Copy link", || log::info!("link"))),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Submenu } from "nsh/base";

function Item(props: { label: string; onSelect: () => void }) {
  return (
    <MenuItem onSelect={props.onSelect} class="rounded-md px-3 py-2 hover:bg-gray-100 active:bg-gray-200">
      <Text>{props.label}</Text>
    </MenuItem>
  );
}

function FileMenu() {
  return (
    <Menu
      offset={4}
      popupClass="min-w-48 rounded-lg bg-white p-1 shadow-lg"
      backdropClass="bg-black/40"
      trigger={<View class="px-3 py-2"><Text>File</Text></View>}
    >
      <Item label="New" onSelect={newFile} />
      <Item label="Open…" onSelect={openFile} />
      <MenuSeparator class="my-1 h-px bg-gray-200" />
      <Submenu
        trigger={<View class="px-3 py-2"><Text>Share ›</Text></View>}
        back={<View class="px-3 py-2"><Text>‹ Back</Text></View>}
      >
        <Item label="Mail" onSelect={mail} />
        <Item label="Copy link" onSelect={copyLink} />
      </Submenu>
    </Menu>
  );
}
```

All five come from [`nsh/base`](../modules/nsh-base.md). The items reach their menu on their own, so you arrange them
freely: groups in views, labels, items that come and go with `If`. `popupClass` styles the popup on desktops and the
sheet on phones; a style that differs between them can compare `platform.idiom` (`nsh`) with `"desktop"`.

## Context menus

```tsx
import { ContextMenu, MenuItem } from "nsh/base";

<ContextMenu
  popupClass="min-w-40 rounded-lg bg-white p-1 shadow-lg"
  backdropClass="bg-black/40"
  trigger={<PhotoTile photo={photo} />}
>
  <MenuItem onSelect={() => share(photo)}><Text>Share</Text></MenuItem>
  <MenuItem onSelect={() => remove(photo)}><Text>Delete</Text></MenuItem>
</ContextMenu>
```

On the desktops the secondary button opens it where the pointer is. On touch screens a finger held on the trigger
opens it as a sheet; the trigger's own presses and the scroll views around it keep working, and moving the finger
cancels the hold.

## Open state

Without `open`, a menu keeps its own state (from `defaultOpen` for `Menu`). With `open`, the app owns it and changes
it in `onOpenChange(open, reason)`: `"triggerPress"`, `"select"`, `"pressOutside"`, `"backdropPress"`, `"cancel"`,
`"contextMenu"` or `"longPress"`.

## Props

### Menu

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | none | Open, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | Desktops: the side of the trigger it goes on. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"start"` | Desktops: how it lines up with the trigger. |
| `offset` | `.offset(..)` | `number` | `0` | Desktops: the gap between the trigger and the popup. |
| `margin` | `.margin(..)` | `number` | `0` | Desktops: the distance it keeps from the edges of the safe area. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup (desktops) or the sheet (phones), and the submenus' popups. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Phones: the backdrop behind the sheet. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens it when pressed. |
| `children` | `.child(..)` | `JSX.Element` | none | The items, made each time it opens. |

### ContextMenu

`open`, `popupClass` / `popupStyle`, `backdropClass` / `backdropStyle`, `trigger` and `children` as for `Menu`, and:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | The secondary button and held fingers do nothing. |
| `offset` | `.offset(..)` | `number` | `0` | Desktops: the gap between the pointer and the popup. |
| `margin` | `.margin(..)` | `number` | `0` | Desktops: the distance it keeps from the edges of the safe area. |

### MenuItem

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | Not chosen; `disabled:` styles apply. |
| `closeOnSelect` | `.close_on_select(..)` | `boolean` | `true` | Choosing it closes the menu. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say, when the content is not enough. |
| `children`, `class`, `style` | `.child(..)`, style methods | | none | Its content and look, with `hover:` and `active:` states. |

### Submenu

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `trigger` | `.trigger(..)` | `JSX.Element` | none | The item that opens it. |
| `back` | `.back(..)` | `JSX.Element` | none | Phones: the row above its items that returns to the items around it. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It does not open. |
| `children` | `.child(..)` | `JSX.Element` | none | Its items. |

`MenuSeparator` is a view you style (`class`, `style`), shown with the items of its level.

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` (`Menu`, `ContextMenu`) | `.on_open_change(\|e\| ..)` | It opened or closed, with why. |
| `onOpen` (`Menu`, `ContextMenu`) | `.on_open(\|\| ..)` | It is shown; as a sheet, once it came in. |
| `onClose` (`Menu`, `ContextMenu`) | `.on_close(\|\| ..)` | It is gone; as a sheet, once it went. Also when the app closed it. |
| `onCancel` (`Menu`, `ContextMenu`) | `.on_cancel(\|\| ..)` | The user tried to close it without choosing (Escape or back, a press outside or on the backdrop). |
| `onSelect` (`MenuItem`) | `.on_select(\|\| ..)` | The item was chosen. |

## Accessibility

The popup or sheet is a menu and its items menu items for screen readers; the trigger tells whether the menu is
expanded. In TSX the trigger is the element you pass: it takes the presses and the expanded state itself, so its own
`active:` classes and `activeStyle` show while it is pressed, and its own `onPress` runs too. Only the items of the level shown are on screen, so screen readers read what is there.
