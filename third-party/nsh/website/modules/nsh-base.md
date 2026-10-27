---
title: nsh/base
description: "Unstyled base components for an app's UI: buttons, checkboxes, radios, switches, tabs, resizable panels, dockable workspaces, Markdown and HTML documents, a code editor, diffs, text inputs, navigation stacks and dialogs, system alert dialogs and the status bar of pages and dialogs."
order: 2.5
demo: ui-navigation
---

# nsh/base

`nsh/base` is the base component layer of an app's UI: unstyled components that own behavior, state, focus and
accessibility, on every platform. It sits between the primitives (`nsh`, `nsh/mobile` and `nsh/desktop`) and the
app's own component library, as `gpui-base` sits between `gpui` and a styled library in GPUI Kit (see
[Modules](./index.md#three-layers)). It provides controls (`Button`, `Checkbox`, `Radio` in a `RadioGroup`, `Slider`, `Switch`, `Tab` in `Tabs`), regions that expand and collapse (`Collapsible`), a progress bar (`Progress`), the parts charts are built from (`Plot` with `Line`, `Area`, `Bar`, `Grid`, `Pie` and `Arc`, in `nsh/base/plot`), workspaces the user arranges (`ResizablePanel`s in a
`ResizablePanelGroup`, and `DockArea`'s splits, tab groups and docks), documents of Markdown or HTML (`TextView`), a code editor (`Editor`) the changes between texts (`DiffView`) and tables of rows and columns (`Table` and its parts, `DataTable`), text inputs
(`Input`), popups shown on top of everything (`Popover`, `Menu` and `ContextMenu` with their `MenuItem`,
`MenuSeparator` and `Submenu`, `Tooltip`, `Sheet`), toasts (`Toast` in a `ToastStack`, their lifecycle in a `ToastManager`), navigation (a `NavStack` of `NavPage`s driven
by the state you create with `createNavStack`, and `Dialog` for content presented over everything else) and the system's
alert dialogs (`AlertDialog`). Pages and dialogs also decide the status bar
(`statusBar`).

The look is the app's: what goes inside a page, a dialog or a header is your own JSX, drawn from the primitives with
styles, [Tailwind](../docs/tailwind.md) classes and your theme, Rust components from [your own crate](../docs/rust.md),
or a component library the community builds on `nsh/base`. Every host serves `nsh/base`; Rust apps use the same API
from the `nsh-base` crate (`nsh_base::{button, dialog, …}`).

```rust tabs
use nsh_base::{
    MarkdownExtension, MarkdownOptions, alert_dialog, button, checkbox, dialog, diff_view, dock_area, editor,
    h_resizable, nav_page, nav_stack, radio, radio_group, resizable_panel, switch, tab, tabs, text_view, theme, toast, toast_stack, v_resizable,
};
```

```tsx tabs
import {
  AlertDialog,
  Button,
  Checkbox,
  Collapsible,
  ContextMenu,
  createNavStack,
  DataTable,
  Dialog,
  DiffView,
  DockArea,
  Editor,
  Menu,
  Progress,
  MenuItem,
  MenuSeparator,
  NavPage,
  NavStack,
  Popover,
  Radio,
  RadioGroup,
  ResizablePanel,
  ResizablePanelGroup,
  Sheet,
  Slider,
  Submenu,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TextView,
  Toast,
  ToastManager,
  ToastStack,
  Tooltip,
} from "nsh/base";
import type {
  AlertDialogAction,
  AlertDialogOptions,
  AlertDialogPresentation,
  AlertDialogRole,
  ButtonProps,
  CheckboxProps,
  CollapsibleProps,
  DialogChangeReason,
  DataTableColumn,
  DataTableProps,
  DataTableRef,
  DataTableSelection,
  DataTableSort,
  DialogProps,
  DiffAnnotation,
  DiffFile,
  DiffHunk,
  DiffLineRange,
  DiffSeparator,
  DiffStats,
  DiffViewProps,
  DiffViewRef,
  DockAreaLayout,
  DockNode,
  DockRegion,
  EditorDecoration,
  EditorDiagnostic,
  EditorProps,
  EditorRef,
  EditorSearch,
  EditorSearchResult,
  EditorSelection,
  Edges,
  HeaderStyle,
  NavPageProps,
  NavStackProps,
  NavStackState,
  ProgressProps,
  StatusBar,
  RadioGroupProps,
  RadioProps,
  SliderProps,
  SliderScale,
  SliderValue,
  StatusBarForeground,
  SwitchProps,
  TabProps,
  TabsProps,
  TextViewProps,
  TextViewDocument,
  MarkdownExtension,
  MarkdownOptions,
  ToastEntry,
  ToastMotion,
  ToastOptions,
  ToastProps,
  ToastStackProps,
  ToastTransitionStatus,
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
| [`Slider`](../elements/slider.md) | `slider()` | A value, or a range of two, picked along a track; the app owns `value` (or the slider keeps its own from `defaultValue`). |
| [`ResizablePanelGroup`, `ResizablePanel`](../elements/resizable.md) | `h_resizable()`, `v_resizable()`, `resizable_panel()` | Panels side by side or stacked, with handles the user drags to resize them. |
| [`DockArea`](../elements/dock.md) | `dock_area()` | A workspace of splits, tab groups and edge docks the user arranges; its layout is the app's data. |
| [`NavStack`, `NavPage`, `createNavStack`](../elements/nav-stack.md) | `nav_stack()`, `nav_page()` | A native navigation stack and its pages. |
| [`Dialog`](../elements/dialog.md) | `dialog()` | Content presented over everything else: sheets, full-screen flows, dialogs. |
| [`AlertDialog`](../elements/alert-dialog.md) | `alert_dialog()` | The platform's alert or action sheet. |
| [`TextView`](../elements/text-view.md) | `text_view()` | A document of Markdown, HTML or blocks, drawn with texts and views, for streamed AI replies. |
| [`Editor`](../elements/editor.md) | `editor()` | A code editor: syntax highlighting, several carets, folding, find and replace, diagnostics. |
| [`DiffView`](../elements/diff-view.md) | `diff_view()` | The changes between two texts or of a patch, side by side or unified, with per-change actions. |
| [`Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption`](../elements/table.md) | `table()`, `table_row()`, ... | A table of the app's own rows and cells, with a table's roles for screen readers. |
| [`DataTable`](../elements/data-table.md) | `data_table()` | A table of any number of rows and columns: selection, sorting, fixed, resizable and movable columns, rows served a page at a time. |
| [`Input`](../elements/input.md) | `nsh_base::input()` | The platform's native text input, one line or several. |
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

### Slider

A value, or a range of two, picked along a track, with no look: a track that takes presses and drags, the indicator
inside it that the values map onto, the range and one thumb per value on it. The app owns `value` (a number or
`[start, end]`; or the slider keeps its own from `defaultValue`) and hears `onChange` for each new value, snapped to
`step` from `min`, and `onChangeEnd` once per change; `scale` spreads the values linearly or by orders of magnitude,
`axis` lays the track out horizontally or vertically. Each thumb is an adjustable element for screen readers with its
own value, a stop of the keyboard focus, and moves with WAI-ARIA's slider keys. See [Slider](../elements/slider.md).

### Plot (`nsh/base/plot`)

The parts charts are built from, as `gpui-base`'s `plot`, in a module of their own: `import { Plot, Line, Area, Bar,
Grid, Pie, Arc } from "nsh/base/plot"`. A `Plot` holds the app's rows (`data`, generic over their type, so `x` and `y`
are checked keys or functions of a row), the `point`, `linear` or `band` scales of its axes, the row under the pointer
(`onHoverChange`) and its motion (`motion`: the appear, the hover's fade and glide); its marks draw natively from the
rows, with no JS per point, and paint with the SVG paint properties (`stroke-*`, `fill-*`), `currentColor` where none
is set; an `Area` or a `Bar` shows a background (a gradient, `bg-linear-*`) inside its shapes. Bars stand in the
bands of a `band` scale, side by side or piled in a `stack`, grow in as the plot appears and fade away from the row
under the pointer, with a `label` part at each bar's end. The hover's cross line, dots (each mark's own
with `hoverDotClass`) and tooltip (`tooltipPlacement`, kept inside the plot) are parts the app styles and fills, moved
natively; axis labels are the app's own elements. A `Pie` splits the turn into a slice per row (a donut with an
`innerRadius`), each painted with its own classes (`sliceClass`, a function of its row), and an `Arc` draws one sector
between two angles (a gauge's track and value); over a pie the plot reports the slice under the pointer, which lifts
(`hoverLift`) while the others fade (`hoverDim`). See [Plot](../elements/plot.md).

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

## Code

### Editor

`Editor` is a code editor for more than fifty languages: syntax highlighting, line numbers, several carets, folding,
soft wrap, find and replace, diagnostics and decorations, with the keys of code editors. The text is the app's
(`value` and `onChange`), and so is the find bar, which drives the editor's `search`. It comes with a look built from
the theme's tokens that the app restyles part by part. See [Editor](../elements/editor.md).

### DiffView

`DiffView` shows the changes between two texts, or of the files of a patch, as code review tools do: side by side or
unified, the words changed within lines highlighted, unchanged lines collapsed into separators that expand, in the
`Editor`'s syntax colors. The app's actions keep or revert each change. See [DiffView](../elements/diff-view.md).

### Table

`Table` and its parts lay out a few rows the app writes as children, and give screen readers a table: groups of rows,
rows, column headers and cells. Every part takes the app's look. See [Table](../elements/table.md).

### DataTable

`DataTable` shows rows and columns and scrolls both ways over any number of either, making only the cells in view. Rows,
columns or cells select; columns resize, move, stay fixed and sort (the app sorts); the app serves rows a page at a time
and can draw cells and titles. See [DataTable](../elements/data-table.md).

## Navigation

A `NavStack` of `NavPage`s is `UINavigationController` on iOS and a stack with a toolbar and predictive back on
Android; on the desktops and the web each page shows the app's own `header`. See
[NavStack](../elements/nav-stack.md), which also covers `createNavStack` and leaving a page.

### Dialog

`Dialog` presents content over everything else, including the stack's header, in its own native window layer. Its
popup and backdrop are styled by the app. See [Dialog](../elements/dialog.md).

## Alert dialogs

### AlertDialog

`AlertDialog.show(options)` shows the platform's own alert or action sheet and resolves with the action the user
chose. See [AlertDialog](../elements/alert-dialog.md).

## Input

`Input` is the platform's native text input: a single-line or multiline field whose typing, caret, selection,
autocorrection and autofill the platform handles. The app owns its value and its look. Its props are the type `InputProps` (with `IOSInputProps` for `ios={{…}}`), exported beside it. See [Input](../elements/input.md).

## Status bar

The status bar belongs to what is on screen, as in UIKit, where each view controller declares its
`preferredStatusBarStyle` and the topmost one decides. In NSH the pages and dialogs are those view controllers: a
`NavPage` or a `Dialog` declares the status bar it wants with `statusBar`, and the app declares its default in
`nsh.json`.

```rust tabs
use nsh_base::nav_page;
use nsh_core::prelude::*;

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
- [Button](../elements/button.md), [Checkbox](../elements/checkbox.md), [Radio](../elements/radio.md), [Switch](../elements/switch.md), [Tabs](../elements/tabs.md), [Collapsible](../elements/collapsible.md), [Progress](../elements/progress.md), [Slider](../elements/slider.md), [Plot](../elements/plot.md), [NavStack](../elements/nav-stack.md), [Dialog](../elements/dialog.md),
  [AlertDialog](../elements/alert-dialog.md), [TextView](../elements/text-view.md), [Editor](../elements/editor.md), [DiffView](../elements/diff-view.md), [Table](../elements/table.md), [DataTable](../elements/data-table.md),
  [Text](../elements/text.md) and
  [Input](../elements/input.md).
- [Device and environment](../docs/device-and-environment.md).
- [`BackHandler`](./nsh-mobile.md#backhandler): `BackHandler` and other Android-only APIs.
