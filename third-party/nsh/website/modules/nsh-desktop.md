---
title: nsh/desktop
description: "Desktop window APIs, application and context menus, keyboard shortcuts, and terminal titles and menus."
order: 12.5
---

# nsh/desktop

`nsh/desktop` provides graphical desktop windows, title bars, application menus and context menus. Terminal surfaces expose titles and menus through the same module. It works on macOS, Windows and Linux. Rust code finds the same in `nsh_core::element::desktop`: the window's functions (`set_title`, `set_title_bar`, `title_bar`, `minimize`, … `close_window`), the application menu and context menus (`set_application_menu`, `popup_menu`, made of `MenuItem`s), and marks draggable views with `.window_drag(true)`; TSX imports `nsh/desktop`. The module can be imported on every platform, so one bundle runs everywhere: on iOS and Android its functions do nothing, and `isAvailable` tells you whether its window and menus are there.

```rust tabs
use nsh_core::{
    desktop::{MenuRole, TitleBarStyle},
    element::desktop::{
        MenuItem, close_window, popup_menu, set_application_menu, set_title, set_title_bar, title_bar,
    },
    prelude::*,
};
```

```tsx tabs
import { isAvailable, Menu, titleBar, Window } from "nsh/desktop";
```

## isAvailable

```ts
const isAvailable: boolean;
```

`true` on graphical macOS, Windows and Linux backends and on terminal surfaces. `platform.isTerminal` identifies the terminal renderer. See [Terminal](../docs/tui.md).

[`platform.desktop`](./nsh.md#platform) checks graphical desktop behavior (`desktop={{…}}` props, `platform.select({ desktop })`), including browsers in the desktop idiom and excluding terminals. Gate graphical desktop layout, density and input on `platform.desktop`, and title and menu API calls on `isAvailable`.

## Window

```ts
const Window: {
  setTitle(title: string): void;
  setTitleBar(options: { style: "default" | "hidden"; height?: number }): void;
  setMenuBar(mode: "shown" | "autoHide"): void;
  minimize(): void;
  toggleMaximize(): void;
  toggleFullScreen(): void;
  setFrame(frame: {
    origin?: Partial<Point>;
    size?: Partial<Size>;
    animated?: boolean;
  }): void;
  setLevel(level: "normal" | "floating" | "desktopIcon"): void;
  orderFront(): void;
  close(): void;
};
```

The Rust column names the functions of `nsh_core::element::desktop`.

| Member | Rust | Description |
|---|---|---|
| `setTitle(title)` | `set_title(title)` | The window's title: the title bar, the taskbar or Dock, the window switcher. |
| `setTitleBar({ style, height? })` | `set_title_bar(TitleBarStyle::Hidden, Some(px(height)))` | `style: "hidden"` removes the system's title bar: the app fills the window up to its top edge and draws a title bar of its own. The system's window controls stay (macOS's traffic lights, Windows' minimize / maximize / close buttons, GTK's window buttons). `height` is your bar's height in points: the controls are centered in it (Windows' caption buttons fill it; on macOS `height` selects compact chrome up to 44 points and regular chrome above; size your bar using the actual height from `titleBar().height`, and AppKit places the traffic lights during live resizing. An embedding app's existing toolbar keeps its own style and height); without it they take the platform's height. `style: "default"` brings the system's title bar back (Rust: `set_title_bar(TitleBarStyle::Default, None)`). |
| `setMenuBar(mode)` | `set_menu_bar_visibility(mode)` | On Windows and Linux in GPUI apps, where the window draws the application menu as a bar above the app: `"shown"` (the default) shows it always; `"autoHide"` shows it after Alt is pressed and released alone, until Alt alone hides it again, as in Windows and GNOME apps. F10 and Alt with a menu's initial open a menu either way, and the bar shows while it is open. macOS's menu bar is the system's. |
| `minimize()` | `minimize()` | Minimizes the window. |
| `toggleMaximize()` | `toggle_maximize()` | Maximizes the window, or restores it when it is maximized. |
| `toggleFullScreen()` | `toggle_full_screen()` | Enters or leaves full screen. |
| `setFrame(frame)` | `set_frame(WindowFrame { .. })` | Moves and sizes the window in points; omitted fields keep their values. On macOS and Windows, `size` (`width`, `height`) includes window decorations; on Linux it sets GTK's default window size. `origin` (`x`, `y`) is the window's top left corner, measured from the top left of the primary screen (on macOS the one with the menu bar) with `y` growing down, the same on every platform; a `height` without a `y` keeps the top edge where it is, so the window grows and shrinks at its bottom edge. `animated: true` enables macOS's resize animation (default: false). |
| `setLevel(level)` | `set_level(level)` | On macOS and Windows, `"floating"` keeps the window above normal windows and `"normal"` restores the normal level. `"desktopIcon"` selects macOS's desktop icon level (the window also sits on every space, out of Mission Control and Cmd+`); on Windows it moves the window to the bottom of the current z-order, where later activation can raise it. |
| `orderFront()` | `order_front()` | Brings the window to the front of its level and focuses it (the app activates; macOS deminiaturizes, Windows restores minimized windows and sets foreground, GTK presents). The window keeps its level. On macOS, desktop-level surfaces stay behind other windows. GPUI activates its window; the window manager controls foreground requests on Linux. |
| `close()` | `close_window()` | Closes the window; the app ends with it. |

Window sizing is supported on macOS, Windows and Linux; positioning and levels on macOS and Windows. Linux's window manager controls placement and stacking. GPUI's host configures window bounds and level when opening the window.

Terminal surfaces send `setTitle` through the host's title transport, and `close` closes the app. Their menus use
terminal overlays: F10 opens the application menu, arrows navigate, Enter or Space selects, and Escape closes it.

When sizing a window from content measured with `onLayout`, allow room for window decorations on macOS and Windows. `width` and `height` accept positive finite numbers; `x` and `y` accept finite numbers. Invalid fields keep their previous values.

## A title bar of your own

With the title bar hidden, the app draws its own bar and says which parts of it move the window, with `.window_drag(true)` in Rust and `desktop={{ windowDrag: true }}` in TSX:

```rust tabs
use nsh_core::{
    desktop::TitleBarStyle,
    element::{desktop::{set_title_bar, title_bar}}, prelude::*,
};

#[component]
fn TitleBar() -> impl IntoElement {
    set_title_bar(TitleBarStyle::Hidden, Some(px(40.0))); // a bar 40 points tall
    view()
        .window_drag(true)
        .h(move || match title_bar().top {
            top if top > px(0.0) => top,
            _ => px(40.0),
        })
        .pl(move || title_bar().left + px(8.0)) // macOS's traffic lights
        .pr(move || title_bar().right + px(8.0)) // the caption buttons on Windows, GTK's buttons
        .flex_row()
        .items_center()
        .child(text("My App"))
        .child(view().flex_1())
        .child(input().placeholder("Search").w(px(180.0)))
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { titleBar, Window } from "nsh/desktop";

Window.setTitleBar({ style: "hidden", height: 40 }); // a bar 40 points tall

function TitleBar() {
  return (
    <View
      desktop={{ windowDrag: true }}
      style={{
        height: titleBar().height || 40,
        paddingLeft: titleBar().left + 8, // macOS's traffic lights
        paddingRight: titleBar().right + 8, // the caption buttons on Windows, GTK's buttons
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <Text>My App</Text>
      <View style={{ flex: 1 }} />
      <Input placeholder="Search" style={{ width: 180 }} />
    </View>
  );
}
```

Pressing a view with `windowDrag` drags the window as the system's title bar would: a double click maximizes it (or does what the user set: on macOS, "Double-click a window's title bar to"), and on Windows and Linux a right click opens the window menu.

- The nearest view that sets `windowDrag` decides: `.window_drag(false)` (`desktop={{ windowDrag: false }}`) keeps a part of a draggable view clickable.
- Text fields and views with press or touch handlers (`onPress`, `onTouch*`, responders) inside a draggable view stay clickable without it: the search field and any buttons in the example above work as usual.
- `windowDrag` also works with the system's title bar: a sidebar or toolbar can move the window too.

### titleBar

```ts
const titleBar: Accessor<{ height: number; left: number; right: number }>;
```

The hidden title bar's area, in points (reactive): its `height`, and the widths the system's window controls take at its `left` and `right` ends. Lay your bar out with it so that nothing goes under the controls. All three are 0 while the system shows its title bar (and in full screen, and off desktops). Rust: `title_bar() -> Edges<Points>`, whose `top` is the height and `left` and `right` the controls' widths; reading it subscribes to changes.

| | `height` | `left` | `right` |
|---|---|---|---|
| macOS | `height`, else the title bar's (28 or 32, by macOS version) | The traffic lights' width | 0 |
| Windows | `height`, else 32 | 0 | The three caption buttons (138) |
| Linux | `height`, else the header bar's | The window buttons at the start (the desktop's button layout) | The window buttons at the end |

On Windows the caption buttons are drawn by NSH in Windows 11's style and follow the app's appearance; hovering the maximize button shows Windows 11's snap layouts. The window keeps its resize borders, shadow and rounded corners on every platform.

## Menu

```ts
const Menu: {
  setApplicationMenu(items: MenuItem[] | null): void;
  popup(items: MenuItem[], at?: Point): Promise<void>;
};
```

| Member | Description |
|---|---|
| `setApplicationMenu(items)` | Sets the application menu: one submenu per top-level item (`File`, `Edit`, ...). On macOS it is the menu bar, whose first menu is the app menu (AppKit titles it with the app's name). On Windows and Linux it is the window's menu bar, which is not shown while the title bar is hidden; its shortcuts still work, and a title bar of the app's own can open its menus with `Menu.popup`. `null` restores the platform's default menu. |
| `popup(items, at?)` | Shows a context menu with its top left corner at `at` (the window's coordinates, in points: an `onContextMenu`'s `e.pagePosition`), or at the pointer. The promise resolves once the menu closes, whether an item was chosen or not: a button that opened it can stay pressed until then. |

In Rust, `set_application_menu(items)` takes a `Vec<MenuItem>` (`None` restores the platform's default menu), and `popup_menu(items)` (at the pointer) and `popup_menu_at(items, at)` return an `Answer<()>` that comes once the menu closes (awaiting it is optional). An item's handler runs under the owner that set the menu, while that owner lives.

Call `setApplicationMenu` again to change the menu. Inside an `effect` it follows the signals it reads: a check mark or a disabled state that depends on app state stays current.

### Menu items

```ts
type MenuItem =
  | { type: "separator" }
  | {
      label?: string;
      role?: MenuRole;
      shortcut?: string;
      when?: "always" | "auto" | "notEditing";
      disabled?: boolean;
      checked?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
    };
```

| Field | Description |
|---|---|
| `label` | What the item shows. A role's item has a label of its own without it. |
| `onSelect` | Called when the item is chosen, by a click or its shortcut. |
| `shortcut` | Its keyboard shortcut: modifiers and one key joined by `+`, such as `"mod+n"`, `"mod+shift+z"`, `"alt+f4"` or `"f11"`. The modifiers are in the table below. Keys are letters, digits and punctuation, written as the character the key types on a US keyboard without Shift (`,`, `/`; `"shift+/"` for `?`), or a name: `plus` (the `=` / `+` key, also `=`), `minus` (also `-`), `space`, `enter` (`return`), `escape` (`esc`), `tab`, `backspace`, `delete` (`del`), `insert`, the arrows `up`, `down`, `left`, `right` (`arrowup`, …), `home`, `end`, `pageup`, `pagedown`, `f1`–`f24`. Case does not matter (`"Mod+Shift+N"` is `"mod+shift+n"`; a capital letter is the same key, not Shift), and lowercase is the recommended style. An invalid shortcut (`"mod-n"`, `"mod++"`, `"mod+?"`) throws an error that gives the right spelling. `keymap` takes the same keystrokes. Menus show it in the platform's own style (`⇧⌘N` on macOS, `Ctrl+Shift+N` on Windows). |
| `when` | When the shortcut chooses the item while a text field has the keyboard focus, on the GPUI backend: `"always"` (the default), `"auto"` (unless the field uses the key itself: keys that type, move the caret or delete, and the editing shortcuts, as with [`keymap`](./nsh.md#keymap)'s bindings) or `"notEditing"`. A key the item leaves goes to the field. |
| `disabled` | `true` grays the item out (default `false`). |
| `checked` | Set (to `true` or `false`) for an item with a check mark. |
| `submenu` | Makes the item a submenu (it needs a `label`). |
| `role` | A standard item the platform carries out (below). |

`null`, `undefined` and `false` items are left out, so `cond && { … }` works in a list.

In Rust, an item is `MenuItem::new(label)`, `MenuItem::role(role)`, `MenuItem::separator()` or `MenuItem::submenu(label, items)`, with the fields as methods: `.shortcut("mod+n")` (it panics on an invalid shortcut, with the right spelling), `.shortcut_when(When::Auto)`, `.disabled(true)`, `.checked(on)`, `.on_select(f)`, and `.label(..)` for a role's item.

Modifiers:

| Modifier | macOS | Windows | Linux |
|---|---|---|---|
| `mod` (also `cmdorctrl`) | Command (⌘) | Ctrl | Ctrl |
| `cmd` (also `command`, `meta`, `super`, `win`) | Command (⌘) | Windows key | Super |
| `ctrl` (also `control`) | Control (⌃) | Ctrl | Ctrl |
| `alt` (also `option`, `opt`) | Option (⌥) | Alt | Alt |
| `shift` | Shift (⇧) | Shift | Shift |

Use `mod` for an app's own shortcuts: it is the key each platform's apps use for them (⌘N on macOS, Ctrl+N on Windows and Linux), so one spelling fits everywhere. The Windows key and Super mostly belong to the system (Win+E, the GNOME overview), so `cmd` is rarely right outside macOS.

Roles:

| Role | Does | Platforms |
|---|---|---|
| `about`, `hide`, `hideOthers`, `showAll` | The app menu's standard items | macOS (left out elsewhere) |
| `quit` | Quits the app | All |
| `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll` | Edit the focused text field (its own shortcuts stay its own) | All |
| `minimize`, `zoom`, `toggleFullScreen`, `close` | The window | All |

A role's item has the platform's label and shortcut unless it sets its own (macOS adds the app's name to `about`, `hide` and `quit`).

Menu shortcuts come first, as in native apps: a key an item takes never reaches the focused text field or NSH's own keys. Only a binding of [`keymap`](./nsh.md#keymap) of the same keystroke comes before them. So give the editing shortcuts (`mod+c`, `mod+v`, `mod+x`, `mod+a`, `mod+z`) only to the edit roles, which pass them to the text field, and avoid keys without a modifier (`escape`, the arrows, letters), which would take them from text fields and from back navigation. On the GPUI backend, `when: "auto"` lets an item share a key with text fields: `delete` or `mod+z` choose the item while no field has the focus and edit the text while one has it.

On the GPUI backend, a native component with the keyboard focus sees each key first. A key it handles itself never reaches the keymap or the menu. A key it lets through reaches the keymap as if a text field were focused, then the menu.

```rust tabs
use nsh_core::{
    desktop::MenuRole,
    element::desktop::{MenuItem, set_application_menu},
    platform::Os,
    prelude::*,
};

#[component]
fn AppMenu() -> impl IntoElement {
    let mac = os() == Os::MacOs;
    let wrap = signal(true);
    effect(move || {
        let mut menus = Vec::new();
        if mac {
            menus.push(MenuItem::submenu("My App", [
                MenuItem::role(MenuRole::About),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Hide),
                MenuItem::role(MenuRole::HideOthers),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Quit),
            ]));
        }
        let mut file = vec![
            MenuItem::new("New").shortcut("mod+n").on_select(create_document),
            MenuItem::new("Open…").shortcut("mod+o").on_select(open_document),
        ];
        if !mac {
            file.push(MenuItem::separator());
            file.push(MenuItem::role(MenuRole::Quit).label("Exit"));
        }
        menus.push(MenuItem::submenu("File", file));
        menus.push(MenuItem::submenu("Edit", [
            MenuItem::role(MenuRole::Undo),
            MenuItem::role(MenuRole::Redo),
            MenuItem::separator(),
            MenuItem::role(MenuRole::Cut),
            MenuItem::role(MenuRole::Copy),
            MenuItem::role(MenuRole::Paste),
        ]));
        menus.push(MenuItem::submenu("View", [
            MenuItem::new("Word Wrap")
                .checked(wrap.get())
                .on_select(move || wrap.update(|w| *w = !*w)),
            MenuItem::role(MenuRole::ToggleFullScreen),
        ]));
        set_application_menu(menus);
    });
    view()
}
```

```tsx tabs
import { effect, signal } from "nsh";
import { platform } from "nsh";
import { Menu } from "nsh/desktop";

const mac = platform.os === "macos";
const wrap = signal(true);

effect(() => {
  Menu.setApplicationMenu([
    mac && {
      label: "My App",
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "File",
      submenu: [
        { label: "New", shortcut: "mod+n", onSelect: () => createDocument() },
        { label: "Open…", shortcut: "mod+o", onSelect: () => openDocument() },
        !mac && { type: "separator" },
        !mac && { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }],
    },
    {
      label: "View",
      submenu: [
        { label: "Word Wrap", checked: wrap(), onSelect: () => wrap.update((w) => !w) },
        { role: "toggleFullScreen" },
      ],
    },
  ]);
});
```

A context menu, from a button's press:

```rust tabs
text("More").on_press(|| {
    let _ = popup_menu(vec![
        MenuItem::new("Rename").on_select(rename),
        MenuItem::new("Duplicate").on_select(duplicate),
        MenuItem::separator(),
        MenuItem::new("Delete").on_select(remove),
    ]);
})
```

```tsx tabs
<View
  onPress={() =>
    Menu.popup([
      { label: "Rename", onSelect: rename },
      { label: "Duplicate", onSelect: duplicate },
      { type: "separator" },
      { label: "Delete", onSelect: remove },
    ])
  }
>
  <Text>More</Text>
</View>
```

> [!NOTE]
> Menus are the system's (NSMenu, Win32 menus, GTK popover menus): they look and behave like every other app's, follow the system's (or the app's) appearance and are keyboard accessible. `examples/desktop` is an app with a title bar of its own, an application menu and context menus.
