---
title: nsh/base
description: "Unstyled base components for an app's UI: buttons, checkboxes, radios, switches, tabs, resizable panels, dockable workspaces, Markdown and HTML documents, selections across texts, navigation stacks and dialogs, safe areas, system alert dialogs, the software keyboard and the status bar of pages and dialogs."
order: 2.5
demo: ui-navigation
---

# nsh/base

`nsh/base` is the base component layer of an app's UI: unstyled components that own behavior, state, focus and
accessibility, on every platform. It sits between the primitives (`nsh` and the `nsh/<module>` modules) and the
app's own component library, as `gpui-base` sits between `gpui` and a styled library in GPUI Kit (see
[Modules](./index.md#three-layers)). It provides controls (`Button`, `Checkbox`, `Radio` in a `RadioGroup`, `Switch`, `Tab` in `Tabs`), regions that expand and collapse (`Collapsible`), a progress bar (`Progress`), workspaces the user arranges (`ResizablePanel`s in a
`ResizablePanelGroup`, and `DockArea`'s splits, tab groups and docks), documents of Markdown or HTML (`TextView`), selections across texts
(`SelectionArea`), popups shown on top of everything (`Popover`, `Menu` and `ContextMenu` with their `MenuItem`,
`MenuSeparator` and `Submenu`, `Tooltip`, `Sheet`), toasts (`Toast` in a `ToastStack`, their lifecycle in a `ToastManager`), navigation (a `NavStack` of `NavPage`s driven
by the state you create with `createNavStack`, and `Dialog` for content presented over everything else), safe areas
(`SafeAreaView`, `safeArea()` and `safeAreaInsets()`), the system's alert dialogs (`AlertDialog`), the software
keyboard (`Keyboard`, `keyboardFrame()` and `KeyboardAvoidingView`). Pages and dialogs also decide the status bar
(`statusBar`).

The look is the app's: what goes inside a page, a dialog or a header is your own JSX, drawn from the primitives with
styles, [Tailwind](../docs/tailwind.md) classes and your theme, Rust components from [your own crate](../docs/rust.md),
or a component library the community builds on `nsh/base`. Every host serves `nsh/base`; Rust apps use the same API
from the `nsh-base` crate (`nsh_base::{button, safe_area_view, …}`).

```rust tabs
use nsh_base::{
    AvoidBehavior, Edge, MarkdownExtension, MarkdownOptions, alert_dialog, button, checkbox, dialog, dock_area,
    h_resizable, keyboard_avoiding_view, nav_page, nav_stack, radio, radio_group, resizable_panel, safe_area_view,
    selection_area, switch, tab, tabs, text_view, theme, toast, toast_stack, v_resizable,
};
```

```tsx tabs
import {
  AlertDialog, Button, Checkbox, Collapsible, ContextMenu, createNavStack, Dialog, DockArea, Keyboard, keyboardFrame, KeyboardAvoidingView, Menu, Progress,
  MenuItem, MenuSeparator, NavPage, NavStack, Popover, Radio, RadioGroup, ResizablePanel, ResizablePanelGroup, SafeAreaView, safeArea, safeAreaInsets, SelectionArea, Sheet,
  Submenu, Switch, Tab, Tabs, TextView, Toast, ToastManager, ToastStack, Tooltip,
} from "nsh/base";
import type {
  AlertDialogAction, AlertDialogOptions, AlertDialogPresentation, AlertDialogRole, AvoidBehavior, ButtonProps,
  CheckboxProps, CollapsibleProps, DialogChangeReason, DialogProps, DockAreaLayout, DockNode, DockRegion, Edge, Edges, HeaderStyle, NavPageProps, NavStackProps, NavStackState, ProgressProps, StatusBar,
  RadioGroupProps, RadioProps, SelectionAreaProps, StatusBarForeground, SwitchProps, TabProps, TabsProps, TextViewProps, TextViewDocument, MarkdownExtension, MarkdownOptions,
  ToastEntry, ToastMotion, ToastOptions, ToastProps, ToastStackProps, ToastTransitionStatus,
} from "nsh/base";
```

This page is the module's index: each component has an element page with its examples, props and platform notes. For
walkthroughs, see the [Navigation guide](../docs/navigation.md) and [Forms and keyboard](../docs/forms-and-keyboard.md).

| TSX | Rust | What it is |
|---|---|---|
| [`Button`](../elements/button.md) | `button()` | A press target with the disabled and selected states and a role for screen readers. |
| [`Checkbox`](../elements/checkbox.md) | `checkbox()` | A checked, unchecked or indeterminate control with an indicator the app styles and marks. |
| [`Radio`](../elements/radio.md), [`RadioGroup`](../elements/radio.md) | `radio()`, `radio_group()` | One option of a set the user picks one of, and the set; the app owns which one is checked. |
| [`Switch`](../elements/switch.md) | `switch()` | An on / off control with a track and a thumb the app styles. |
| [`Tab`](../elements/tabs.md), [`Tabs`](../elements/tabs.md) | `tab()`, `tabs()` | One tab of a tab list, and the list; the app owns which one is selected and shows its content. |
| [`Collapsible`](../elements/collapsible.md) | `collapsible()` | A region whose content expands and collapses; the app owns `open` and its trigger. |
| [`Progress`](../elements/progress.md) | `progress()` | A progress bar; the app owns `value` (0 to 100) and `indeterminate`. |
| [`ResizablePanelGroup`, `ResizablePanel`](../elements/resizable.md) | `h_resizable()`, `v_resizable()`, `resizable_panel()` | Panels side by side or stacked, with handles the user drags to resize them. |
| [`DockArea`](../elements/dock.md) | `dock_area()` | A workspace of splits, tab groups and edge docks the user arranges; its layout is the app's data. |
| [`NavStack`, `NavPage`, `createNavStack`](../elements/nav-stack.md) | `nav_stack()`, `nav_page()` | A native navigation stack and its pages. |
| [`Dialog`](../elements/dialog.md) | `dialog()` | Content presented over everything else: sheets, full-screen flows, dialogs. |
| [`SafeAreaView`](../elements/safe-area-view.md) | `safe_area_view()` | A view padded clear of system UI and headers. |
| [`safeArea()`, `safeAreaInsets()`](../elements/safe-area-view.md#safearea-and-safeareainsets) | `safe_area()`, `cx.insets()` | The insets themselves, reactive. |
| [`KeyboardAvoidingView`](../elements/keyboard-avoiding-view.md) | `keyboard_avoiding_view()` | A view that keeps its content above the software keyboard. |
| [`Keyboard.dismiss()`, `keyboardFrame()`](../elements/keyboard-avoiding-view.md#hiding-the-keyboard) | `dismiss_keyboard()`, `keyboard_height()` | Hides the keyboard; its height over the surface. |
| [`AlertDialog`](../elements/alert-dialog.md) | `alert_dialog()` | The platform's alert or action sheet. |
| [`TextView`](../elements/text-view.md) | `text_view()` | A document of Markdown, HTML or blocks, drawn with texts and views, for streamed AI replies. |
| [`SelectionArea`](../elements/selection-area.md) | `selection_area()` | One selection across the texts inside it. |
| [`Popover`](../elements/popover.md) | `popover()` | Content anchored to a trigger, on top of everything. |
| [`Menu`, `ContextMenu`, `MenuItem`, `MenuSeparator`, `Submenu`](../elements/menu.md) | `menu()`, ... | Menus: popups with cascading submenus on desktops, sheets on phones. |
| [`Tooltip`](../elements/tooltip.md) | `tooltip()` | A hint next to its trigger. |
| [`Sheet`](../elements/sheet.md) | `sheet()` | A panel at an edge of the screen over a backdrop. |
| [`Toast`, `ToastStack`, `ToastManager`](../elements/toast.md) | `toast()`, `toast_stack()`, `ToastManager` | Unstyled toasts: a semantic root, a stack of layers, their lifecycle. |
| `statusBar` on pages and dialogs | `.status_bar(..)` | The status bar while a page or dialog is up. See [Status bar](#status-bar). |

In Rust, `theme()` reads the app's theme as design tokens (`theme().primary`, `theme().radius`), the same tokens
TSX's [theme classes](../docs/tailwind.md#theme-tokens) use.

## Controls

### Button

A press target that owns its behavior and has no look: presses, the disabled and selected states and its role for
screen readers. Its look is the app's `class` and `style` with state variants, its content is its children. See
[Button](../elements/button.md).

### Checkbox

A checked, unchecked or indeterminate control that owns its behavior and has no look: presses, keyboard activation,
the disabled state and the checkbox role and value for screen readers (mixed while indeterminate), with the value
owned by the app (`checked`, `indeterminate`, `onChange`). The app styles the checkbox and its indicator, whose
`checked:`, `indeterminate:` and `disabled:` classes follow the checkbox, and puts its own mark in the indicator
(`indicator`). See [Checkbox](../elements/checkbox.md).

### Radio and RadioGroup

One option of a set the user picks exactly one of, and the set around them. A radio owns its behavior and has no
look: presses, keyboard activation, the disabled state and the radio role and checked state for screen readers. The
group is the radio group screen readers announce and holds no value: the app tells each radio whether it is checked
(`checked`), and a press on an unchecked one asks for it (`onChange`). The app's indicator and label are the radio's
children, whose `group-checked:` classes follow it. See [Radio](../elements/radio.md).

### Switch

An on / off control that owns its behavior and has no look: presses, keyboard activation, the disabled state and the
switch role and value for screen readers, with the value owned by the app (`checked`, `onChange`). The app styles the
switch, its track and its thumb, whose `checked:` and `disabled:` classes follow the switch. See
[Switch](../elements/switch.md).

### Tab and Tabs

The tabs of a tab list and the list around them. A tab owns its behavior and has no look: presses, keyboard
activation, the disabled state and the tab role and selected state for screen readers. The list is the tab list
screen readers announce and holds no value: the app tells each tab whether it is selected (`selected`), hears
presses (`onPress`) and shows the selected section's content itself. The app's label is the tab's children, whose
`group-selected:` classes follow it. See [Tabs](../elements/tabs.md).

### Collapsible

A region whose content expands and collapses, with no look: its children show always (a summary, the trigger), its
`content` after them while `open`. The app owns `open` and the trigger that flips it, and says the expanded state to
screen readers there. The content is made once and kept while collapsed, so what is inside keeps its state. See
[Collapsible](../elements/collapsible.md).

### Progress

A linear progress bar, with no look: a track with an indicator inside it, the indicator `value` percent of the track's
width. The app owns `value` (0 to 100) and `indeterminate`; screen readers get the progress bar role, the range and the
value, and no value while indeterminate, when the indicator's width and motion are the app's. See
[Progress](../elements/progress.md).

## Workspaces

### ResizablePanelGroup and ResizablePanel

Panels side by side or stacked, with a handle between each two that the user drags to share the room. The group owns
the drag, which runs natively, each panel's limits (`minSize`, `maxSize`) and the resize cursor; the sizes are the
app's (`size`, reported with `onResize`), and so are the handles' look and the panels' content. See
[Resizable](../elements/resizable.md).

### DockArea

A dockable workspace: panels in tab groups, groups split side by side or stacked, and docks on the left, right and
bottom edges. The layout is data the app owns (`layout`, reported with `onLayoutChange`); the area owns tab drags and
drops, resizing, docks, zoom and the lock, keeps each panel's content as it moves, and presents the same layout with
drawers and a bottom sheet when it is narrow. The tabs, handles, drop indicator and the panels' content are the
app's. See [Dock](../elements/dock.md).

## Documents

### TextView

`TextView` shows a document of Markdown, HTML or blocks the app builds, drawn with [`Text`](../elements/text.md)
elements and views: headings, lists, code, tables, images, formulas, footnotes and the app's own syntax. It is made for
AI chat replies that stream in, with a reading typography in the theme's colors that the app restyles part by part,
and render functions that put the app's content in place. See [TextView](../elements/text-view.md).

## Selection

### SelectionArea

`SelectionArea` makes the texts inside it select together, as a web page's do: one selection runs across views,
`Text` elements and `TextView`s, in reading order. See [SelectionArea](../elements/selection-area.md).

## Navigation

A `NavStack` of `NavPage`s is `UINavigationController` on iOS and a stack with a toolbar and predictive back on
Android; on the desktops and the web each page shows the app's own `header`. See
[NavStack](../elements/nav-stack.md), which also covers `createNavStack` and leaving a page.

### Dialog

`Dialog` presents content over everything else, including the stack's header, in its own native window layer. Its
popup and backdrop are styled by the app. See [Dialog](../elements/dialog.md).

## Safe areas

### SafeAreaView

`SafeAreaView` pads its content by the insets where it renders: the nearest page's (below its header), the nearest
dialog's, or else the surface's safe area. See [SafeAreaView](../elements/safe-area-view.md).

### safeArea and safeAreaInsets

`safeArea()` is the surface's safe area; `safeAreaInsets()` the insets where a component renders. Both are reactive
`Edges` (`{ top, right, bottom, left }` in points). See
[safeArea and safeAreaInsets](../elements/safe-area-view.md#safearea-and-safeareainsets).

## Alert dialogs

### AlertDialog

`AlertDialog.show(options)` shows the platform's own alert or action sheet and resolves with the action the user
chose. See [AlertDialog](../elements/alert-dialog.md).

## Keyboard

`Keyboard.dismiss()` hides the software keyboard and `keyboardFrame()` tells you how much of the screen it covers. See
[Hiding the keyboard](../elements/keyboard-avoiding-view.md#hiding-the-keyboard) and
[The keyboard's height](../elements/keyboard-avoiding-view.md#the-keyboards-height).

### KeyboardAvoidingView

`KeyboardAvoidingView` keeps its content above the software keyboard, moving with it. See
[KeyboardAvoidingView](../elements/keyboard-avoiding-view.md).

## Status bar

The status bar belongs to what is on screen, as in UIKit, where each view controller declares its
`preferredStatusBarStyle` and the topmost one decides. In NSH the pages and dialogs are those view controllers: a
`NavPage` or a `Dialog` declares the status bar it wants with `statusBar`, and the app declares its default in
`nsh.json`.

```rust tabs
use nsh_base::nav_page;
use nsh_core::ui::prelude::*;

fn photo_viewer() -> Screen {
    nav_page().header_visible(false).status_bar(
        StatusBarSetting::default()
            .foreground(StatusBarStyle::Light)
            .hidden(true)
            .animated(true),
    )
}
```

```tsx tabs
import { NavPage } from "nsh/base";

function PhotoViewer() {
  return (
    <NavPage headerVisible={false} statusBar={{ foreground: "light", hidden: true, animated: true }}>
      …
    </NavPage>
  );
}
```

`statusBar` takes these fields, each optional (in Rust, a `StatusBarStyle` alone, or `StatusBarSetting`'s builder
methods of the same names):

| Field | Type | Description |
|---|---|---|
| `foreground` | `"auto" \| "light" \| "dark"` (Rust: `StatusBarStyle::Default`, `Light`, `Dark`) | The color of the content (time, battery, signal): `"light"` for dark backgrounds, `"dark"` for light ones, `"auto"` the platform's for the current appearance. |
| `hidden` | `boolean` | Hides the status bar. |
| `animated` | `boolean` | Animates the change when the page or dialog comes and goes. |

The value is reactive: `statusBar={{ foreground: dark() ? "light" : "dark" }}` follows the signal, as does a Rust
closure that reads one.

### Which one applies

The page or dialog shown **most recently** decides, **field by field**: a page pushed onto a stack is over the pages
below it, and an open dialog is over the pages. A field it leaves out comes from the one below it, and in the end
from the app's default. When the page is popped or the dialog closes, the one below it applies again.

```rust tabs
nav_page()
    .title("Inbox")
    .status_bar(StatusBarStyle::Dark);

// Pushed over it: hidden, with the inbox's dark content when it shows again.
nav_page()
    .title("Photo")
    .status_bar(StatusBarSetting::default().hidden(true));
```

```tsx tabs
<NavPage title="Inbox" statusBar={{ foreground: "dark" }}>…</NavPage>

// Pushed over it: hidden, with the inbox's dark content when it shows again.
<NavPage title="Photo" statusBar={{ hidden: true }}>…</NavPage>
```

### The app's default

`nsh.json`'s `"statusBar"` is the setting under every page and dialog, as Info.plist's `UIStatusBarStyle` and
`UIStatusBarHidden` are in a UIKit app:

```json
{
  "statusBar": { "foreground": "light", "hidden": false }
}
```

Both fields are optional. Without it the content is `"auto"` and the bar shows. Packaged iOS apps also show it on the
launch screen.

### The status bar on each platform

- **iOS**: hiding and showing animate with a fade. In an app [embedded](../docs/ios.md) in a native one,
  the host app's view controller decides how the status bar looks. The host applies NSH's setting by returning
  `NshAppView.preferredStatusBarStyle`, `NshAppView.prefersStatusBarHidden` and
  `NshAppView.preferredStatusBarUpdateAnimation` from its view controller.
- **Android**: apps draw edge to edge, behind the status bar (Android 15, API 35): the app's own background is the
  bar's, and `foreground` keeps its content readable on it.
- **Desktops and the web**: the window's title bar and the browser's bars are the system's and the browser's;
  `statusBar` and `nsh.json`'s `"statusBar"` are for the phones.

> [!IMPORTANT]
> When your `nsh.json` declares `"capabilities"`, the status bar changes only when they include
> `"statusBar": true`; other changes are refused and logged. See
> [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

```json
{
  "capabilities": {
    "statusBar": true
  }
}
```

## Related

- [Navigation guide](../docs/navigation.md).
- [Forms and keyboard](../docs/forms-and-keyboard.md).
- [Button](../elements/button.md), [Checkbox](../elements/checkbox.md), [Radio](../elements/radio.md), [Switch](../elements/switch.md), [Tabs](../elements/tabs.md), [Collapsible](../elements/collapsible.md), [Progress](../elements/progress.md), [NavStack](../elements/nav-stack.md), [Dialog](../elements/dialog.md),
  [SafeAreaView](../elements/safe-area-view.md), [KeyboardAvoidingView](../elements/keyboard-avoiding-view.md),
  [AlertDialog](../elements/alert-dialog.md), [TextView](../elements/text-view.md),
  [SelectionArea](../elements/selection-area.md), [Text](../elements/text.md) and
  [Input](../elements/input.md).
- [Device and environment](../docs/device-and-environment.md).
- [nsh/android](./nsh-android.md): `BackHandler`, `Toast.show` for short messages and other Android-only APIs.
