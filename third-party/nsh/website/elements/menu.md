---
title: Menu
description: "Menu and ContextMenu with MenuItem, MenuSeparator and Submenu: a popup with cascading submenus on desktops and iPads in a regular width, a sheet with submenus in place on phones, styled by the app; MenuButton for the system's own menu, and ContextMenu's items for the system's context menu on iOS and Android."
group: base
demo: el-menu
---

# Menu

A menu is a list of actions its trigger opens. One structure serves every device, presented as each expects:

- On the desktops, in desktop browsers and on an iPad whose window is regular in width, a popup at the trigger; a
  `Submenu` cascades beside its item as the pointer comes over it or presses it, its first item level with that item
  (inside the padding and border of your `popupClass`).
- On phones and the other tablets, and on an iPad in a compact width (Slide Over, a narrow Split View or Stage
  Manager window), a sheet at the bottom of the screen over a backdrop; a `Submenu` shows its items in the sheet in
  place of the menu's, with a row of yours leading back.

An iPad follows UIKit's horizontal size class, as the system's own menus do: resizing its window across it presents
the menu the other way.

Choosing an item, a press outside, Escape, the Android back button and VoiceOver's escape gesture close it.

`ContextMenu` is the same menu with other ways to open it:

- the secondary button (a right click), at the pointer;
- a finger held on the trigger, on touch screens;
- the keyboard, below the trigger, in the browser and on Linux;
- screen readers on macOS and Windows.

Return, Space or Down on the focused trigger opens the menu with the keyboard focus on its first enabled item, and Up
with it on its last; the arrow keys then move between the items. A press opens it with no item focused; in a popup Down or Home then
focuses the first enabled item and Up or End the last, even while a field outside the menu keeps editing (a search
field beside the trigger); a field inside the menu keeps its own arrows. Page Down moves to the last enabled item in view and Page Up to
the first, a view at a time, stopping at the ends (a `MenuList` the same, see [Long lists](#long-lists)). In a popup the pointer moving over an item gives
it the keyboard focus, so the keys go on from the item under the pointer; style an item's `focus:` state as its
`hover:` one. In a popup a letter or digit moves the focus to the next enabled item whose text (or
`accessibilityLabel`) starts with it, as `Select`'s list does: the same letter again moves on among those items, and
letters typed in quick succession match a prefix. They act on the menu or submenu the focus is in, a text field in the
menu keeps them, and an item out of view scrolls into it.
In a popup and in a terminal, Right, Return or Space on a `Submenu`'s item opens it with the keyboard focus on
its first enabled item; Left on one of its items, or Escape, closes it and puts the focus back on its item. A submenu
the pointer opened closes when the arrow keys move the focus to another item of its menu.

```tsx tabs
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Submenu } from "nsh/base";

function Item(props: { label: string; onSelect: () => void }) {
  return (
    <MenuItem onSelect={props.onSelect} class="rounded-md px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 active:bg-gray-200">
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

A group of items under one row (Share, Language, Appearance) is a `Submenu`, never a row that expands its items in
place with a chevron turning down: no platform's menu does that, and those rows would lose the submenu's keys and
role. A few choices that stay visible are a section instead: a title that is not an item and checkable items under
it, unindented, between separators (see [Checkable items](#checkable-items)).

All five come from [`nsh/base`](../modules/nsh-base.md). The items reach their menu on their own, so you arrange them
freely: groups in views, labels, items that come and go with `If`. `popupClass` styles the popup or the sheet,
whichever the menu is. A style that differs between them follows the same rule, read in a style getter or a binding
so that it changes as an iPad's window is resized:

```tsx
import { horizontalSizeClass, platform } from "nsh";

// The menu is a popup here, a sheet elsewhere.
const popup = () =>
  platform.desktop ||
  (platform.os === "ios" && platform.idiom === "pad" && !platform.catalyst && horizontalSizeClass() === "regular");
```

The popup is never taller than the room on the side it opens on, and a submenu's popup never taller than its own: a
long menu in a short window opens on the side where it fits whole, or where there is more room, and its items scroll
inside it, without overscroll bounce or scroll bars. The keys bring the item they move to into view, and a submenu
closes once its item scrolls out of view.
The sheet stays below the status bar the same way. Draw the surface (background, border, shadow) with
`popupClass`, around the items, so it stays in place while they scroll.

## Menu bars

Menus whose triggers are items of one `Toolbar` form a menu bar: with one of its menus open, the pointer over another
menu's trigger opens that menu in its place, and the arrow keys move between the triggers.

```tsx
<Toolbar accessibilityLabel="Menu bar">
  <Menu trigger={<View><Text>File</Text></View>}>{/* … */}</Menu>
  <Menu trigger={<View><Text>Edit</Text></View>}>{/* … */}</Menu>
</Toolbar>
```

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
opens it: as a popup where the finger is on an iPad in a regular width, as a sheet elsewhere; the trigger's own presses and the scroll views around it keep working, and moving the finger
cancels the hold.

Keyboard and screen reader users open it too. In the browser and on Linux, Shift+F10 and the Menu key on the focused trigger open
it. On macOS, VoiceOver's "show menu" action (VO-Shift-M) opens it, and on Windows, a screen reader's "show context
menu" action through UI Automation does. These openings place the menu below the trigger, starting at its start edge, with the keyboard focus on
its first enabled item, as WAI-ARIA describes for context menus. Make the trigger `focusable` so the keyboard reaches
it. A view's own `onContextMenu` tells these openings apart by `pointerType`, which is `null` for them.

When you control `open` and set it to `true` yourself, for a shortcut of your own or for a list that has the focus
while one of its rows is the one asked about, the menu opens the same way: below the trigger, with the keyboard
focus on its first enabled item, and closing it gives the focus back to the trigger. On macOS and iOS, a menu a pointer opened
gives it back where it was before it opened: a press there gives the trigger no focus, so your app's shortcuts keep their keys.

## Checkable items

`checked` makes an item checkable: a setting the menu shows ("Show sidebar") or, with `role="menuitemradio"`, one
choice of a group ("Sort by"). The value is yours: choosing the item calls `onSelect`, you set the next value, and the
item shows it. While it is checked, its `checked:` classes and `checkedStyle` apply, and so do those of its
indicator: the part before its content (`indicatorClass`, `indicatorStyle`) around the mark you give it
(`indicator`). The mark is made once and kept; the indicator's `checked:` classes show and hide it, or the mark's own
`group-checked:` classes with `group` in `indicatorClass`. `closeOnSelect={false}` keeps the menu open, so a setting
shows its new value at once.

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
        class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100 focus:bg-gray-100"
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
            class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 checked:font-semibold"
          >
            <Text>{by()}</Text>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}
```

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

A mark at the trailing edge goes in the content instead, styled with `group-checked:` classes under `group` on the
item.

## Entrance and exit

The popup comes and goes with your transitions, as a [Popover](./popover.md#entrance-and-exit)'s:
`popupStartingClass` is its look in its first frame, `popupEndingClass` its look once closed, which it keeps while the
`transition-*` classes of `popupClass` run, and `onClose` follows. On its way out it takes no presses or keys: the
keyboard focus is back on the trigger as it closes, so Return during the exit chooses no item and opens the menu
again. An item whose `onSelect` moves the focus elsewhere (to a field it starts editing) keeps it there: the menu
gives the focus back only when nothing else took it. Submenus take the same looks and close with their menu. The
sheet slides in and out on its own.

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

A `Submenu` keeps its own state unless the app sets its `open`, and reports each opening and closing the user asks for in `onOpenChange({ open,
reason })`: `"hover"` (its item hovered, or another item of its menu), `"focus"` (the keyboard focus moved to another item of its
menu), `"triggerPress"` (its item pressed, or Right, Return or Space on it), `"cancel"` (Left, Escape, back or its `back` row), or the menu's reason when the whole menu
closes (`"select"`, `"pressOutside"`, ...). Its items are made as it opens, so an app can start loading them there the
first time and show them as they arrive. When the app closes the menu itself, nothing is reported.

```tsx
const recent = signal<string[] | null>(null);

<Submenu
  trigger={<Text>Open Recent</Text>}
  onOpenChange={({ open }) => {
    if (open && recent() === null) loadRecent().then((names) => recent.set(names));
  }}
>
  <Each of={recent() ?? []}>
    {(name) => <MenuItem onSelect={() => openFile(name())}><Text>{name()}</Text></MenuItem>}
  </Each>
</Submenu>
```

With `open`, a `Submenu` is controlled as a `Menu` is: `onOpenChange` asks, and it shows what the app sets. Items the
app makes again from its data (a list that changes while the menu is open) make their submenus again too; a controlled
one opens again as the app has it, with the keyboard focus back on the item it was on, so the user stays where they
were.

```tsx
const modelsOpen = signal(false);

<Submenu
  open={modelsOpen()}
  onOpenChange={({ open }) => modelsOpen.set(open)}
  trigger={<Text>Model</Text>}
>
  <Each of={models()}>{(m) => <MenuItem onSelect={() => pick(m())}><Text>{m().name}</Text></MenuItem>}</Each>
</Submenu>
```

## Long lists

A menu of many items, or of as many as the data has (models, accounts, recent files), puts them in a `MenuList`
(Rust): a virtualized list whose rows are made only near its viewport. Its rows are items of the menu among the ones
around it: Up, Down, Home and End walk every row of the list, scrolling to a row before focusing it and passing over
disabled ones, then go on to the items before and after the list, a `Submenu`'s item among them. Page Down and Page Up
scroll the list a view at a time. Letters reach the rows the list has made, the ones near its viewport. `render_item` draws
each row from its index, one `MenuItem` or `Submenu` per row; give the list a height.

```rust
use nsh_base::{MenuListEntry, menu, menu_item, menu_list, submenu};
use nsh_core::prelude::*;

let models = signal(vec![/* … */]);
menu()
    .trigger(text("Model"))
    .child(
        menu_list()
            .count(move || models.with(|m: &Vec<Model>| m.len() as u32))
            .render_item(move |e: &MenuListEntry| {
                let index = e.index as usize;
                menu_item()
                    .on_select(move || choose(index))
                    .child(text(move || models.with(|m| m[index].name.clone())))
            })
            .h(px(240.0)),
    )
    .child(submenu().trigger(text("Reasoning")).child(/* … */))
```

## The system's menu: MenuButton

`Menu` draws a menu in your app's look on every device. When an app wants the system's own menu instead (the iOS
pull-down menu, with its placement, motion and Liquid Glass on iOS 26; Android's popup menu), `MenuButton` shows one
from a trigger you draw:

```tsx
import { MenuButton } from "nsh/base";

<MenuButton
  accessibilityLabel="Account"
  title={email()}
  items={[
    { id: "settings", label: "Settings", icon: "gearshape" },
    { id: "read", label: "Mark all as read", disabled: !unread() },
    { id: "", label: "Language", items: languages.map((l) => ({ id: l.id, label: l.label, checked: l.id === lang() })) },
    { id: "", label: "Appearance", inline: true, singleSelection: true, items: [
      { id: "light", label: "Light", checked: !dark() },
      { id: "dark", label: "Dark", checked: dark() },
    ] },
  ]}
  onSelect={({ id }) => choose(id)}
  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
>
  <Avatar … />
  <Text>{account()}</Text>
</MenuButton>;
```

The items are data, each with an `id` of yours that `onSelect({ id })` reports; a check, `disabled` and `destructive`
(red on iOS, the theme's error color on Android) are the item's state, the app's to change; an item with `items` is a submenu, or with `inline` a section
shown in place under its `label`. With `singleSelection`, a submenu's or a section's own actions are one choice (a sort
order, an appearance) and the app checks one: iOS shows it as a single-selection menu, Android as radio buttons, the
desktops as check marks; without it, checks are independent. The choice is that menu's own actions: a section or
submenu inside it sets its own. A menu whose items are all one choice puts them in an untitled `inline` section with
`singleSelection` (`{ id: "", label: "", inline: true, singleSelection: true, items }`). The children, `class` and
`style` are the trigger, drawn by the app on every platform.

- **iOS and Mac Catalyst**: the trigger is covered by a transparent `UIButton` whose `UIMenu` is its primary action:
  a tap, VoiceOver's activation or a hardware keyboard opens it at once, without waiting for JS. `icon` is an SF
  Symbol; `title` heads the menu. The menu grows out of the trigger, which hides while the menu is up and comes back as it
  closes, as a system button does. VoiceOver reaches the button, named by `accessibilityLabel`, and not the trigger's
  content under it. New `items` change the menu the next time it opens.
- **Desktops (macOS, Windows, Linux)**: a press shows the items as the platform's context menu at the pointer (as
  `Menu.popup` from `nsh/desktop`), sections between separators; `icon`, `title` and `destructive` are not shown.
- **Android**: a transparent button over the trigger opens the system's popup menu below it at once, lined up with the
  trigger's end when the trigger is in the end half of the window. `title` is the menu's first row, which cannot be
  chosen (TalkBack reads it as a disabled item); `svg`, an SVG document, is the item's icon, drawn in the item's text
  color on Android 10 and later (`icon` is iOS's). Checks, radio buttons, submenus and sections are the system's. A
  tap outside closes the menu as the finger lifts; the back button and the back gesture close only the menu, so a
  dialog under it stays open.
- **The web**: there is no system menu for a view; the trigger shows and opens nothing. Use `Menu` there, picked by
  `platform.os`.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `MenuButtonItem[]` | `[]` | The menu's items, in order. |
| `title` | `.title(..)` | `string` | none | iOS and Android: the menu's title, above its items. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It cannot be pressed and opens nothing. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the button. |
| `accessibilityHint` | `.accessibility_hint(..)` | `string` | none | Explains what opening the menu offers, as a view's `accessibilityHint`. |
| `class`, `style`, `children` | style methods, `.child(..)` | | none | The trigger the app draws. |

`accessibilityHint` follows reactive values; setting it to `undefined` removes the hint. On iOS and Android, the
hint reaches the native button that screen readers activate.

`MenuButtonItem` is `{ id, label, icon?, svg?, checked?, disabled?, destructive?, items?, inline?, singleSelection? }`
(Rust: `MenuButtonItem::new(id, label)`, `::submenu(label, items)`, `::section(label, items)`, then `.icon(..)`,
`.svg(..)`, `.checked(..)`, `.disabled(..)`, `.destructive(..)`, `.single_selection(..)`). Its one event is `onSelect({ id })` (Rust:
`.on_select(|id: &SharedString| ..)`), after the menu closed.

## The system's context menu on iOS and Android

On iOS a held finger on a message, a photo or a row usually brings up the system's context menu: the view lifts over
the blurred screen, with the system's haptics and motion, and the menu shows beside it. On Android it brings up the
system's popup menu by the view. Give a `ContextMenu` the same items as `MenuButton` and iOS and Android show that
menu, while the children stay the menu of the other platforms:

```tsx
import { ContextMenu, MenuItem } from "nsh/base";

<ContextMenu
  title={photo.name}
  items={[
    { id: "share", label: "Share", icon: "square.and.arrow.up" },
    { id: "favorite", label: "Favorite", icon: "heart", checked: photo.favorite },
    { id: "", label: "", inline: true, items: [{ id: "delete", label: "Delete", icon: "trash", destructive: true }] },
  ]}
  onSelect={({ id }) => act(photo, id)}
  popupClass="min-w-40 rounded-lg bg-white p-1 shadow-lg"
  trigger={<PhotoTile photo={photo} />}
>
  <MenuItem onSelect={() => act(photo, "share")}><Text>Share</Text></MenuItem>
  <MenuItem onSelect={() => act(photo, "delete")}><Text>Delete</Text></MenuItem>
</ContextMenu>
```

- **iOS and Mac Catalyst**: `UIContextMenuInteraction` answers a held finger, and an iPad pointer's or a Mac's
  secondary click, natively. The trigger itself is the preview the system lifts, clipped to its own rounded corners;
  the menu is made from `items` (`MenuButtonItem`s, SF Symbol icons, `title` above them). `onOpenChange`, `onOpen`,
  `onSelect({ id })`, `onCancel` and `onClose` report what happened, as for the drawn menu. The system opens this menu
  only for the user: `open` set to `true` shows nothing, and `open` set to `false` closes it.
- **Android**: a held finger opens the system's popup menu, with the system's long-press haptic, below the trigger and
  lined up with its end (below the held point when the trigger's bottom is out of sight). `title` is its first row
  and `svg` the items' icons, as for `MenuButton`; `preview` is not used. It reports the same events, and unlike iOS
  the app can open it: `open` set to `true` shows it below the trigger.
- **The desktops and the web**: `items`, `title` and `onSelect` are not used. The children are the menu, drawn as
  without `items`, and each `MenuItem`'s `onSelect` reports the choice.

The trigger's own presses keep working beside the held finger. Without `items`, iOS and Android show the drawn menu,
as the other platforms do.

### A preview in place of the trigger

The system lifts the trigger as it is. To lift something else, a card with a conversation's last messages or the start of
a document, give `preview` a view; pressing it closes the menu and reports `onPreviewPress`, where the app usually opens
what the row stands for:

```tsx
<ContextMenu
  items={actions}
  onSelect={({ id }) => act(chat, id)}
  preview={<ChatCard chat={chat} />}
  onPreviewPress={() => openChat(chat)}
  trigger={<ChatRow chat={chat} />}
/>
```

The preview is made when a finger goes down on the trigger, laid out at its own size out of sight, and shown as a
picture of how it looks when the menu comes up; it goes once the menu closed. Data it starts loading as it is made can
arrive while the finger is held. Until it is laid out the system lifts the trigger. Like `items`, `preview` is used on
iOS only.

## Props

### Menu

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | none | Open, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | As a popup: the side of the trigger it goes on. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"start"` | As a popup: how it lines up with the trigger. |
| `offset` | `.offset(..)` | `number` | `0` | As a popup: the gap between the trigger and the popup. |
| `margin` | `.margin(..)` | `number` | `0` | As a popup: the distance it keeps from the edges of the safe area. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup or the sheet, and the submenus' popups. |
| `popupStartingClass`, `popupStartingStyle` | `.popup_starting_class(..)`, `.popup_starting_style(..)` | `string`, `StyleProp<ViewStyle>` | none | As a popup: the popups' look in their first frame, over their own. |
| `popupEndingClass`, `popupEndingStyle` | `.popup_ending_class(..)`, `.popup_ending_style(..)` | `string`, `StyleProp<ViewStyle>` | none | As a popup: the popups' look once closed, kept while their transitions run. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | As a sheet: the backdrop behind it. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens it when pressed. While the menu is open its `aria-expanded:` classes and `expandedStyle` apply. |
| `children` | `.child(..)` | `JSX.Element` | none | The items, made each time it opens. |

### ContextMenu

`open`, `popupClass` / `popupStyle`, the starting and ending looks, `backdropClass` / `backdropStyle`, `trigger` and
`children` as for `Menu`, and:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | Nothing opens it: not the secondary button, held fingers, the keyboard or a screen reader. |
| `offset` | `.offset(..)` | `number` | `0` | As a popup: the gap between the pointer and the popup. |
| `margin` | `.margin(..)` | `number` | `0` | As a popup: the distance it keeps from the edges of the safe area. |
| `items` | `.items(..)` | `MenuButtonItem[]` | `[]` | iOS and Android: the system's context menu, in place of the children. Not used on the other platforms, which draw the children. |
| `title` | `.title(..)` | `string` | none | iOS and Android: the system's menu's title, above its items. Not used on the other platforms. |
| `preview` | `.preview(..)` | `JSX.Element` | none | iOS only, with `items`: what the system lifts beside its menu in place of the trigger. Made when a finger goes down, gone once the menu closed. |

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
| `accessibilityDescription` | `.accessibility_description(..)` | `string` | none | More about it than its name, which screen readers read after it: what a choice does. |
| `children`, `class`, `style` | `.child(..)`, style methods | | none | Its content and look, with `hover:`, `active:` and `checked:` states. |

### Submenu

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `trigger` | `.trigger(..)` | `JSX.Element` | none | The item that opens it. |
| `open` | `.open(..)` | `boolean` | none | Open, owned by the app (changed in `onOpenChange`); without it the submenu keeps its own state. |
| `back` | `.back(..)` | `JSX.Element` | none | As a sheet: the row above its items that returns to the items around it. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It does not open. |
| `offset` | `.offset(..)` | `number` | `0` | As a popup: the gap between the menu around it and its popup. |
| `children` | `.child(..)` | `JSX.Element` | none | Its items. |

### MenuList (Rust)

| Rust | Type | Default | Description |
|---|---|---|---|
| `.count(..)` | `u32` | `0` | How many rows. |
| `.render_item(\|e: &MenuListEntry\| ..)` | `MenuListEntry { index }` | none | Draws a row from its index: one `MenuItem` or `Submenu`. |
| style methods | | none | The list's look; give it a height (`.h(..)`). |

`MenuSeparator` is a view you style (`class`, `style`), shown with the items of its level.

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` (`Menu`, `ContextMenu`) | `.on_open_change(\|e\| ..)` | It opened or closed, with why. |
| `onOpen` (`Menu`, `ContextMenu`) | `.on_open(\|\| ..)` | It is shown; as a sheet, once it came in. |
| `onClose` (`Menu`, `ContextMenu`) | `.on_close(\|\| ..)` | It is gone: as a sheet once it went, as a popup after its exit. Also when the app closed it. |
| `onPosition` (`Menu`, `ContextMenu`) | `.on_position(\|e\| ..)` | As a popup: the popup was placed: `placement` (the side it went on), `bounds`, `available`. |
| `onCancel` (`Menu`, `ContextMenu`) | `.on_cancel(\|\| ..)` | The user tried to close it without choosing (Escape or back, a press outside or on the backdrop). |
| `onSelect` (`ContextMenu`) | `.on_select(\|id: &SharedString\| ..)` | iOS only, with `items`: the item of this `id` was chosen in the system's menu. Not sent on the other platforms, where the `MenuItem`s report the choice. |
| `onPreviewPress` (`ContextMenu`) | `.on_preview_press(\|\| ..)` | iOS only, with `preview`: the preview was pressed; the menu closed as for a chosen item. |
| `onSelect` (`MenuItem`) | `.on_select(\|\| ..)` | The item was chosen; a checkable item asks for its other value. |
| `onOpenChange` (`Submenu`) | `.on_open_change(\|e\| ..)` | It opened or closed as the user asked, with why. |

## Accessibility

The popup or sheet is a menu and its items menu items for screen readers; the trigger tells whether the menu is
expanded. A checkable item is a checkbox or radio menu item, read as checked or not checked; its indicator is part of
the item. An item's `accessibilityDescription` is read after its name, so a short label can stay short; a
submenu's trigger is your element and takes its own. In TSX the trigger is the element you pass, a `Button` or a view
of your own: it takes the presses and the expanded state itself, so its own `active:` classes and `activeStyle` show while it is pressed, and its own `onPress` runs too. Only the items of the level shown are on screen, so screen readers read what is there.
