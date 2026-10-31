---
title: Menu
description: "Menu and ContextMenu with MenuItem, MenuSeparator and Submenu: a popup with cascading submenus on desktops, a sheet with submenus in place on phones, styled by the app."
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

## Checkable items

`checked` makes an item checkable: a setting the menu shows ("Show sidebar") or, with `role="menuitemradio"`, one
choice of a group ("Sort by"). The value is yours: choosing the item calls `onSelect`, you set the next value, and the
item shows it. While it is checked, its `checked:` classes and `checkedStyle` apply, and so do those of its
indicator: the part before its content (`indicatorClass`, `indicatorStyle`) around the mark you give it
(`indicator`). The mark is made once and kept; the indicator's `checked:` classes show and hide it, or the mark's own
`group-checked:` classes with `group` in `indicatorClass`. `closeOnSelect={false}` keeps the menu open, so a setting
shows its new value at once.

```rust tabs
use nsh_base::{menu, menu_item};
use nsh_core::{element::StyleRefinement, prelude::*};

fn view_menu(sidebar: Signal<bool>, sort: Signal<&'static str>) -> impl IntoElement {
    // The indicator part shows the mark while the item is checked.
    let part = |s: StyleRefinement| s.w(px(16.0)).opacity(0.0).checked(|s| s.opacity(1.0));
    let by = move |label: &'static str| {
        menu_item()
            .role(AccessibilityRole::MenuItemRadio)
            .checked(move || Some(sort.get() == label))
            .indicator_style(part)
            .indicator(text("✓"))
            .on_select(move || sort.set(label))
            .flex_row()
            .gap_2()
            .px_3()
            .py_2()
            .child(text(label))
    };
    menu()
        .trigger(view().px_3().py_2().child(text("View")))
        .child(
            menu_item()
                .checked(move || Some(sidebar.get()))
                .close_on_select(false)
                .indicator_style(part)
                .indicator(text("✓"))
                .on_select(move || sidebar.set(!sidebar.get_untracked()))
                .flex_row()
                .gap_2()
                .px_3()
                .py_2()
                .child(text("Show sidebar")),
        )
        .child(by("Name"))
        .child(by("Date modified"))
}
```

```tsx tabs
import { Text, View, signal } from "nsh";
import { Menu, MenuItem } from "nsh/base";

// The indicator part shows the mark while the item is checked.
const part = "w-4 opacity-0 transition-opacity checked:opacity-100";

function ViewMenu() {
  const sidebar = signal(true);
  const sort = signal("Name");
  return (
    <Menu popupClass="min-w-48 rounded-lg bg-white p-1 shadow-lg" trigger={<View class="px-3 py-2"><Text>View</Text></View>}>
      <MenuItem
        checked={sidebar()}
        closeOnSelect={false}
        indicatorClass={part}
        indicator={<Text>✓</Text>}
        onSelect={() => sidebar.set(!sidebar())}
        class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100"
      >
        <Text>Show sidebar</Text>
      </MenuItem>
      <Each of={["Name", "Date modified", "Size"]}>
        {(by) => (
          <MenuItem
            role="menuitemradio"
            checked={sort() === by()}
            indicatorClass={part}
            indicator={<Text>✓</Text>}
            onSelect={() => sort.set(by())}
            class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100 checked:font-semibold"
          >
            <Text>{by()}</Text>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}
```

A mark at the trailing edge goes in the content instead, styled with `group-checked:` classes under `group` on the
item.

## Entrance and exit

On the desktops the popup comes and goes with your transitions, as a [Popover](./popover.md#entrance-and-exit)'s:
`popupStartingClass` is its look in its first frame, `popupEndingClass` its look once closed, which it keeps while the
`transition-*` classes of `popupClass` run, and `onClose` follows. Submenus take the same looks and close with their
menu. The sheet of phones slides in and out on its own.

```tsx
<Menu
  popupClass="min-w-40 rounded-lg bg-white p-1 shadow-lg transition-all duration-100"
  popupStartingClass="opacity-0 -translate-y-1"
  popupEndingClass="opacity-0"
  trigger={<Text>File</Text>}
>
  <MenuItem onSelect={newFile}><Text>New</Text></MenuItem>
</Menu>
```

## Open state

Without `open`, a menu keeps its own state (from `defaultOpen` for `Menu`). With `open`, the app owns it and changes
it in `onOpenChange({ open, reason })`: `"triggerPress"`, `"select"`, `"pressOutside"`, `"backdropPress"`, `"cancel"`,
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
| `popupStartingClass`, `popupStartingStyle` | `.popup_starting_class(..)`, `.popup_starting_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Desktops: the popups' look in their first frame, over their own. |
| `popupEndingClass`, `popupEndingStyle` | `.popup_ending_class(..)`, `.popup_ending_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Desktops: the popups' look once closed, kept while their transitions run. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Phones: the backdrop behind the sheet. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens it when pressed. While the menu is open its `aria-expanded:` classes and `expandedStyle` apply. |
| `children` | `.child(..)` | `JSX.Element` | none | The items, made each time it opens. |

### ContextMenu

`open`, `popupClass` / `popupStyle`, the starting and ending looks, `backdropClass` / `backdropStyle`, `trigger` and
`children` as for `Menu`, and:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | The secondary button and held fingers do nothing. |
| `offset` | `.offset(..)` | `number` | `0` | Desktops: the gap between the pointer and the popup. |
| `margin` | `.margin(..)` | `number` | `0` | Desktops: the distance it keeps from the edges of the safe area. |

### MenuItem

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | Not chosen; `disabled:` styles apply. |
| `checked` | `.checked(..)` | `boolean` | none | Checked or not, which makes it a checkable item; owned by the app. |
| `checkedStyle` | `.checked_style(..)` | `StyleProp<ViewStyle>` | none | Its style while checked, as `checked:` classes. |
| `role` | `.role(..)` | `AccessibilityRole` | `"menuitemcheckbox"` with `checked`, else `"menuitem"` | What it is for screen readers; `"menuitemradio"` for one choice of a group. |
| `indicatorClass`, `indicatorStyle` | `.indicator_class(..)`, `.indicator_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The indicator, the part before its content; its `checked:` and `disabled:` classes follow the item. |
| `indicator` | `.indicator(..)` | `JSX.Element` | none | The mark inside the indicator. |
| `closeOnSelect` | `.close_on_select(..)` | `boolean` | `true` | Choosing it closes the menu. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say, when the content is not enough. |
| `children`, `class`, `style` | `.child(..)`, style methods | | none | Its content and look, with `hover:`, `active:` and `checked:` states. |

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
| `onClose` (`Menu`, `ContextMenu`) | `.on_close(\|\| ..)` | It is gone: as a sheet once it went, as a popup after its exit. Also when the app closed it. |
| `onPosition` (`Menu`, `ContextMenu`) | `.on_position(\|e\| ..)` | Desktops: the popup was placed: `placement` (the side it went on), `bounds`, `available`. |
| `onCancel` (`Menu`, `ContextMenu`) | `.on_cancel(\|\| ..)` | The user tried to close it without choosing (Escape or back, a press outside or on the backdrop). |
| `onSelect` (`MenuItem`) | `.on_select(\|\| ..)` | The item was chosen; a checkable item asks for its other value. |

## Accessibility

The popup or sheet is a menu and its items menu items for screen readers; the trigger tells whether the menu is
expanded. A checkable item is a checkbox or radio menu item, read as checked or not checked; its indicator is part of
the item. In TSX the trigger is the element you pass: it takes the presses and the expanded state itself, so its own
`active:` classes and `activeStyle` show while it is pressed, and its own `onPress` runs too. Only the items of the level shown are on screen, so screen readers read what is there.
