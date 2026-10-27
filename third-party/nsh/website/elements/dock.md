---
title: Dock
description: "DockArea: a dockable workspace of splits, tab groups and docks on the left, right and bottom edges, whose layout is data the app owns. The area owns tab drags and drops, resizing, docks, zoom and the lock, keeps each panel's content as it moves, and adapts to phones; the look and the panels' content are the app's."
order: 29.6
group: base
demo: el-dock
---

# Dock

A dock area is a workspace the user arranges: panels in tab groups, groups split side by side or stacked, and docks on
the left, right and bottom edges that open, close and resize. A tab dragged onto another group joins it, dragged to a
group's edge splits it, and every panel keeps what it holds as it moves. `DockArea` owns the behavior: tab drags and
drops, which run natively frame by frame, resizing splits and docks, opening and closing docks, zoom and the lock. The
look is the app's: the tabs, the tab bars, the handles, the drop indicator and each panel's content are what the app
renders and styles, and the area draws nothing of its own.

```rust tabs
use nsh_base::{
    dock::{DockAreaLayout, DockLayout, DockPanel, DockPlacement, DockRegion, DockTab},
    dock_area, theme,
};
use nsh_core::prelude::*;

fn workspace() -> impl IntoElement {
    let layout = signal(
        DockAreaLayout::new(
            DockLayout::h_split()
                .child(DockLayout::tabs().panel("readme").panel("main"), None)
                .child(DockLayout::tabs().panel("preview"), Some(px(320.0))),
        )
        .with_dock(DockPlacement::Left, DockRegion::new(DockLayout::tabs().panel("files")))
        .with_dock(DockPlacement::Bottom, DockRegion::new(DockLayout::tabs().panel("terminal"))),
    );
    dock_area()
        .layout(move || layout.get())
        .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
        .handle_style(|s| s.bg(move || theme().border()))
        .tab_bar_style(|s| s.flex_row().border_b_1().border_color(move || theme().border()))
        .tab_style(|s| s.px_3().py_1().selected(|s| s.bg(move || theme().muted())))
        .render_tab(|tab: &DockTab| text(tab.panel.to_string()).text_sm().text_color(move || theme().foreground()))
        .render_panel(|panel: &DockPanel| {
            text(format!("{} content", panel.id)).p_4().text_color(move || theme().foreground())
        })
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { DockArea, type DockAreaLayout } from "nsh/base";

const titles: Record<string, string> = {
  files: "Files", readme: "README.md", main: "main.rs", preview: "Preview", terminal: "Terminal",
};

function App() {
  const layout = signal<DockAreaLayout>({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: ["readme", "main"] },
        { type: "tabs", panels: ["preview"] },
      ],
      sizes: [null, 320],
    },
    left: { layout: { type: "tabs", panels: ["files"] }, size: 240 },
    bottom: { layout: { type: "tabs", panels: ["terminal"] }, size: 180 },
  });
  return (
    <DockArea
      class="size-full bg-background"
      layout={layout()}
      onLayoutChange={(v) => layout.set(v)}
      handleClass="bg-border group-active:bg-primary"
      tabBarClass="flex-row border-b border-border"
      tabClass="px-3 py-1.5 selected:bg-muted"
      renderTab={(tab) => <Text class="text-sm text-foreground">{titles[tab.panel]}</Text>}
      renderPanel={(panel) => <Text class="p-4 text-foreground">{titles[panel.id]} content</Text>}
    />
  );
}

mount(App);
```

`DockArea` and the values it takes come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust
(`nsh_base::dock_area()`, the values in `nsh_base::dock`). In Rust, `dock_area()` makes it, with a setter per
prop, a listener per event and the typed style methods; `DockLayout` describes a layout by the panels' keys
(`h_split()`, `v_split()`, `tabs()`, `.child(layout, size)`, `.panel(key)`).

## The layout

The layout is a value, `DockAreaLayout`: the center, and a dock on each of the left, right and bottom edges, each
optional. Each region is a tree of two kinds of node:

| Node | Holds | Fields |
|---|---|---|
| `{ type: "split" }` | Other nodes, side by side (`axis: "horizontal"`) or stacked (`"vertical"`) | `children`, and `sizes`: each child's length along the axis in points, `null` to share the rest |
| `{ type: "tabs" }` | Panels, by key, one shown at a time | `panels` (the keys, in tab order), `activeIndex` (the one shown, default 0) |

A panel always lives in a tab group: a region with one panel is a tab group of one. A panel's key is the app's string
for it (`"files"`, a document's id), and a key appears once in the whole layout. A dock (`DockRegion`) is its tree
(`layout`), its size across its edge (`size`, default 200, at least 100), whether it is open (`open`, default `true`)
and whether dragging its edge below its smallest size closes it (`collapsible`, default `true`).

Every node has an `id`. A layout the app writes may leave ids out: the area assigns them, and every layout it reports
carries them. Passing a reported layout back keeps each group's identity, which the ref's methods name groups by. The
area also tidies what it is given: an empty group or split goes, a split of one child becomes that child, a split
inside a split of the same axis joins its parent, `activeIndex` stays in range, a key listed twice keeps its first
place. The layouts it reports are always in that one canonical shape.

The layout is the app's (`layout`): every change the user makes (a tab selected, dragged or closed, a split or dock
resized, a dock opened or closed) is reported as the whole new layout (`onLayoutChange`), and the area shows the
layout the app passes back. The app changes the layout itself by passing a new value: a saved layout restored, a
command that rearranges the workspace. An area without `layout` keeps its own, starting from `defaultLayout`, and
still reports every change.

## Panels' content

What a panel shows is the app's: `renderPanel` renders it from the panel's key (`panel.id`). Every panel of a group is
placed and only the displayed one shown, so switching tabs keeps each panel's content; and when a panel moves (to
another group, into a dock, into a zoom and back), the same content moves with it: the signals it created, an input's
text, a scroll position, a web view's page all stay. The area renders a panel once, when it first appears, and lets its
content go when the panel leaves the layout (`onPanelRemove`).

```tsx
<DockArea
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  renderPanel={(panel) => (panel.id === "terminal" ? <Terminal /> : <Editor file={panel.id} />)}
  onPanelActiveChange={(panel, active) => active && setTitle(panel)}
  onPanelRemove={(panel) => closeFile(panel)}
/>
```

`panels` sets what each panel allows, by key; a panel not listed allows everything:

| Field | Default | Description |
|---|---|---|
| `id` | | The panel's key. |
| `closable` | `true` | It may be closed. |
| `zoomable` | `true` | Its group may zoom while it is displayed. |
| `visible` | `true` | It shows. A hidden panel keeps its place and comes back there; a group or split whose panels are all hidden takes no room. |

## Tabs

Each group has a tab bar with a tab per visible panel, in the order of its `panels`. `renderTab` renders what a tab
shows (its title, an icon, a close button of the app's); without it a tab shows the panel's key. The area makes it the
tab: a press selects it, a drag moves its panel, screen readers hear it as a tab with its selected state, and
`tabClass`'s `selected:` classes style the displayed one. A tab's value says what the app needs to draw it:

| Field | Type | Description |
|---|---|---|
| `panel` | `string` | The panel's key. |
| `group` | `number` | The id of the tab group it is in. |
| `index` | `number` | Its place among the group's visible tabs. |
| `active` | `boolean` | It is the group's displayed tab. |
| `closable` | `boolean` | The area would close it: it is closable, the area is not locked, and its group may give it away. |
| `zoomed` | `boolean` | Its group is zoomed. |

```tsx
let area!: DockAreaRef;

<DockArea
  ref={area}
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  renderTab={(tab) => (
    <View class="flex-row items-center gap-2">
      <Text class="text-sm">{titles[tab.panel]}</Text>
      <If when={tab.closable}>
        <Button onPress={() => area.closePanel(tab.panel)} accessibilityLabel="Close" class="rounded-sm px-1 hover:bg-muted">
          <Text class="text-xs">×</Text>
        </Button>
      </If>
    </View>
  )}
  renderPanel={(panel) => <Editor file={panel.id} />}
/>
```

## Drag and drop

A tab dragged over a group shows where it would land, and the drop puts it there:

| Dropped on | The panel |
|---|---|
| A tab bar | Joins that group, between the tabs it is dropped by |
| The middle of a group's content | Joins that group |
| An edge of a group's content (its outer 35% on each side) | Splits that group: a new group of its own on that side |

While a drag hovers, the area shows the drop indicator over the part of the group the panel would take (all of its
content to join, half of it to split): a part the
app styles (`dropIndicatorClass`), with content of its own if the app renders some (`renderDropIndicator`, told the
`group`, the `side` it splits off or the tab bar `index`). It moves to each new place natively, easing there and fading in on another group as the last one fades out (at once when the user asks for less motion). What follows the pointer or finger is the app's too
(`renderDragPreview`). A drop is one change of the layout, reported once; a drop that would change nothing changes nothing.

A locked area, a zoomed one, and a group's last panel when nothing sits beside the group drag nothing.

## Docks

A dock opens and closes without losing its panels or its size: closing it keeps its tree, and opening it shows the
same groups at the same size. The edge between a dock and the center is a handle the user drags to resize the dock;
it stays at least 100 points and the center keeps at least 100 points, and a collapsible dock let go below 50 points
closes and keeps its size for when it opens. The area always fits its bounds: a dock shows at its `size` within what
the area leaves it, and when even that does not fit, the docks shrink with the rest and the splits' minimum sizes
yield. `renderDock` draws a dock's own chrome before its layout (a title strip, a collapse button), told its
`placement`, `open`, `size` and `collapsible`; `dockClass` styles its frame.

Open, close and resize docks from the app through the ref (`toggleDock`, `setDockOpen`, `setDockSize`), which work
in both presentations, or by writing the dock's `open` and `size` in the layout it passes (`open` is the full
presentation's). `onDockOpenChange` reports
each time a dock shows or hides, measured against the layout's `open` (an area that is compact from the start reports
each layout-open dock hidden), so a toggle that starts from the layout's `open` and follows `onDockOpenChange` always
shows the dock's state:

```tsx
const terminalOpen = signal(true);

<DockArea
  ref={area}
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  onDockOpenChange={(placement, open) => placement === "bottom" && terminalOpen.set(open)}
  renderPanel={(panel) => <Editor file={panel.id} />}
/>

<Button selected={terminalOpen()} onPress={() => area.toggleDock("bottom")} class="px-3 py-1.5 selected:bg-muted">
  <Text>Terminal</Text>
</Button>
```

## Zoom

A zoomed group fills the whole area until it is zoomed out or leaves the layout (`area.toggleZoom(group)`, and `area.toggleZoom()` to zoom
out), and `onZoomChange` reports the panel it displays, or `null`. The zoom belongs to the group, so it stays zoomed
when its displayed panel closes and the next one takes over. A panel with `zoomable: false` keeps its group from
zooming while it is displayed.

## Locking

`locked` keeps the arrangement as it is: no tab drags, no drops, no closes. Selecting tabs, resizing and opening and
closing docks still work, so a locked workspace is still a workspace to use.

## Methods

`ref={area}` gives the area's methods (`DockAreaRef`), for commands, shortcuts and menus of the app's. Each edit is
reported with `onLayoutChange` as the user's are.

| Method | Description |
|---|---|
| `layout()` | `Promise<DockAreaLayout>`: the layout shown. |
| `addPanel(panel, placement?, size?)` | Adds a panel to a region (`"center"`, the default, `"left"`, `"right"`, `"bottom"`), into its first tab group, displayed; a missing dock is made, `size` across. A panel the area holds moves there. |
| `removePanel(panel)` | Removes a panel, whatever its options say. |
| `closePanel(panel)` | Closes a panel as its tab would: unless the area is locked, the panel is not closable, or it is the last panel of a group with nothing beside it. |
| `movePanel(panel, target)` | Moves a panel to `target`: `{ group, side?, index?, activate?, size? }`, into tab group `group` (at `index`) or a new group on its `side` (`size` points along the new split). |
| `splitAt(group, panel, side)` | Puts a panel in a new tab group on a side (`"left"`, `"right"`, `"top"`, `"bottom"`) of a container. |
| `selectPanel(panel)` | Displays a panel in its group. |
| `selectTab(group, index)` | Displays a tab of a group. |
| `toggleDock(placement)`, `setDockOpen(placement, open)` | Opens or closes a dock. |
| `setDockSize(placement, size)` | Sets a dock's size across its edge (at least 100). |
| `toggleZoom(group?)` | Zooms a group in, or out when it is zoomed; without `group`, the zoomed group out. |
| `zoomedGroup()` | `Promise<number \| null>`: the zoomed group's id. |
| `groupOf(panel)` | `Promise<number \| null>`: the id of the tab group holding a panel. |

In Rust, `component_ref::<DockArea>()` and `.component_ref(&r)` on the area give a ref whose `r.api::<DockAreaApi>()` has
the same methods in snake case.

## Saving and restoring

A reported layout is plain data, so saving it is `JSON.stringify(layout)` into [storage](../modules/nsh.md#storage),
and restoring it is passing the parsed value as `layout`. `onLayoutChange` reports every change, a resize and a tab
selection included, so write to storage once the changes settle (a short timer reset on each report).

In Rust, `DockAreaLayout::to_state` and `from_state` read and write `DockAreaState`, the layout file format
`gpui-base`'s dock uses too.

## Phones and narrow windows

The dock adapts to its own width. An area 600 points wide and wider (in a window on a desktop, the web, a tablet, an
iPad full screen, a foldable open) is the whole workspace: splits, groups and docks side by side, as a tablet's
multi-pane apps are. With a finger on a phone or tablet, a tab drag starts on a long press, as iPadOS drag and drop does, so a tab bar
still scrolls under a swipe, and handles take a wider touch area with the same look.

An area narrower than 600 points (on a phone, an iPad in Slide Over, in a narrow desktop or browser window, or in a
narrow column of a wide one) presents the same layout for one screen, as iPad's split views collapse their columns and Material Design's supporting
pane becomes a bottom sheet:

- The center shows one group at a time, full size. Its tab bar lists every visible panel of the center, and selecting
  a panel of another group makes that group the one shown.
- The left and right docks are drawers over the center from their edge, as wide as the dock, and the bottom dock is a
  sheet as tall as the dock. One shows at a time, when the app presents it (`toggleDock`, `setDockOpen`, which
  dismiss the other); it slides in and out, and a press on its backdrop, Escape or back dismiss it. Entering the
  compact presentation shows none.
- A tab dragged (a finger after a long press, a pointer at once) moves within the tab bar to reorder it.

Every panel stays placed in both presentations, so switching keeps its content. The drawer or sheet shown is the
compact presentation's own: the layout's `open` belongs to the full presentation, and presenting or dismissing a
drawer reports no `onLayoutChange`, so an area that widens again shows the docks exactly as they were.
`onDockOpenChange` reports both: a dock whose layout `open` changes in the full presentation, a drawer or sheet shown
or dismissed in the compact one, and each dock whose shown state changes when the presentation switches. In
`renderDock`, `open` is whether the dock shows in the current presentation. The layout stays the same value too,
so an area that crosses 600 points (a foldable opening, an iPad joining Split View, a window or a column resized)
keeps every panel where it was, and the app saves one layout. The area's width decides once it is laid out (the
window's width stands in before that), and `compact` chooses the presentation instead of the width. The
drawers, the sheet and the backdrop are parts the app styles (`drawerClass`, `sheetClass`, `backdropClass`), as the
rest of the area.

```tsx
<DockArea
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  drawerClass="bg-background border-r border-border"
  sheetClass="rounded-t-(--radius-lg) bg-background"
  backdropClass="bg-black/40"
  renderTab={(tab) => <Text>{titles[tab.panel]}</Text>}
  renderPanel={(panel) => <Editor file={panel.id} />}
/>
```

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `layout` | `.layout(..)` | `DockAreaLayout` | none | The layout shown (controlled): pass back what `onLayoutChange` reports. |
| `defaultLayout` | `.default_layout(..)` | `DockAreaLayout` | an empty center | The layout at first, when `layout` is not set; the area keeps its own from then on. |
| `locked` | `.locked(..)` | `boolean` | `false` | No tab drags, drops or closes. |
| `compact` | `.compact(..)` | `boolean` | by width | The phone presentation (`true`) or the full one (`false`); without it, compact while the area is narrower than 600 points. |
| `panels` | `.panels(..)` | `DockPanelOptions[]` | `[]` | What each panel allows, by key: `closable`, `zoomable`, `visible`. |
| `renderPanel` | `.render_panel(\|panel\| ..)` | `(panel: DockPanel) => JSX.Element` | none | A panel's content, by its key (`panel.id`). |
| `renderTab` | `.render_tab(\|tab\| ..)` | `(tab: DockTab) => JSX.Element` | the key | What a tab shows. |
| `renderDropIndicator` | `.render_drop_indicator(\|drop\| ..)` | `(drop: DockDropIndicator) => JSX.Element` | none | What is inside the drop indicator: `group`, `side`, `index`. |
| `renderDock` | `.render_dock(\|dock\| ..)` | `(dock: DockInfo) => JSX.Element` | none | A dock's own chrome, before its layout: `placement`, `open` (shown in the current presentation), `size`, `collapsible`. |
| `renderEmpty` | `.render_empty(\|placement\| ..)` | `(placement: DockPlacement) => JSX.Element` | none | What an empty center shows. |
| `renderDragPreview` | `.render_drag_preview(\|tab\| ..)` | `(tab: DockTab) => JSX.Element` | none | What follows the pointer or finger while a tab is dragged. |
| `groupClass`, `groupStyle` | `.group_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each tab group's frame. |
| `tabBarClass`, `tabBarStyle` | `.tab_bar_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each tab bar (`flex-row` for a row). |
| `tabClass`, `tabStyle` | `.tab_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each tab; `selected:` for the displayed one. |
| `contentClass`, `contentStyle` | `.content_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each group's content frame, where its panels show. |
| `dropIndicatorClass`, `dropIndicatorStyle` | `.drop_indicator_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The drop indicator. |
| `handleClass`, `handleStyle` | `.handle_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The indicator of each handle, between a split's groups and at each dock's edge; `group-hover:` and `group-active:` follow the handle. It is 1 point across the handle and runs its full length unless it says otherwise, so `bg-border` is a hairline either way; `w-[3px]` / `h-[3px]` thicken it. |
| `handleThumbClass`, `handleThumbStyle` | `.handle_thumb_class(..)`, `.handle_thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each handle's thumb: a grip centered on the line, drawn upright as on a vertical line and turned a quarter on a horizontal one, so one class serves both axes. It stays the same view while the handle is hovered, pressed and dragged, so `group-hover:` and `group-active:` classes transition it (`h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100`). |
| `dockClass`, `dockStyle` | `.dock_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each dock's frame. |
| `drawerClass`, `drawerStyle` | `.drawer_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Compact: the side docks' drawers. |
| `sheetClass`, `sheetStyle` | `.sheet_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Compact: the bottom dock's sheet. |
| `backdropClass`, `backdropStyle` | `.backdrop_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Compact: the backdrop behind an open drawer or sheet, whose press closes it. |
| `handleAccessibilityLabel` | `.handle_accessibility_label(..)` | `string` | none | What screen readers say for every handle, between a split's groups and at each dock's edge. |
| `ref` | `.component_ref(&r)` (`component_ref::<DockArea>()`) | `DockAreaRef` | | The area's [methods](#methods). |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The area itself: its size in its parent (`flex-1`), its background. It stays within its bounds and takes no minimum size from its content. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onLayoutChange` | `.on_layout_change(\|layout: &DockAreaLayout\| ..)` | The layout changed (a drag, a selection, a resize, a dock opened or closed, a method): the whole new layout, every id in it. |
| `onPanelActiveChange` | `.on_panel_active_change(\|e: &DockAreaEvent\| ..)` (`PanelActiveChange(panel, active)`) | A panel became, or stopped being, its group's displayed tab (a closed dock displays none). Once per change; a panel that leaves is not told `false`: `onPanelRemove` is its end. |
| `onPanelRemove` | `.on_panel_remove(\|panel: &PanelId\| ..)` | A panel left the area for good: closed, removed, or missing from a new layout. A panel that moves never hears it. |
| `onZoomChange` | `.on_zoom_change(\|panel: &Option<PanelId>\| ..)` | A group zoomed in (the panel it displays) or out (`null`). |
| `onDockOpenChange` | `.on_dock_open_change(\|e: &DockAreaEvent\| ..)` (`DockOpenChange(placement, open)`) | A dock showed or hid: its layout `open` changed in the full presentation, its drawer or sheet was shown or dismissed in the compact one, or the presentation switched. |

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The area | | `class`, `style` | |
| A tab group | a region | `groupClass`, `groupStyle` | |
| A tab bar | a group | `tabBarClass`, `tabBarStyle` | |
| A tab | a tab bar | `tabClass`, `tabStyle`; `renderTab` | `selected:`, `active:`, `hover:` |
| A group's content | a group | `contentClass`, `contentStyle`; `renderPanel` | |
| A handle's indicator | between a split's groups, at a dock's edge | `handleClass`, `handleStyle` | `group-hover:`, `group-active:` |
| A handle's thumb | centered on a handle's line | `handleThumbClass`, `handleThumbStyle` | `group-hover:`, `group-active:` (pressed until the drag ends) |
| A dock | an edge | `dockClass`, `dockStyle`; `renderDock` | |
| The drop indicator | over a group during a drag | `dropIndicatorClass`, `dropIndicatorStyle`; `renderDropIndicator` | |
| The drag preview | under the pointer or finger | `renderDragPreview` | |
| The empty center | the center | `renderEmpty` | |
| A drawer, the sheet, the backdrop | over the center, compact | `drawerClass`, `sheetClass`, `backdropClass` (and their styles) | |

## Accessibility

- Each tab is a tab with its selected state for screen readers, as [`Tab`](./tabs.md) is, and activating it selects
  it. Its label is the text `renderTab` draws.
- Every handle, between a split's groups and at each dock's edge, is an adjustable element labeled
  `handleAccessibilityLabel`. The handles between a split's groups are [Resizable](./resizable.md)'s: a screen reader
  moves them 10 points at a time, reported with `onLayoutChange`.
- In the compact presentation, Escape and back dismiss the drawer or sheet shown.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- A pointer (a mouse, a trackpad, a pen hovering over the screen) drags a tab once it moves 4 points with the button
  down, on every platform: an iPad with a trackpad and a narrow browser window driven by a mouse drag as a desktop
  does. On macOS, Windows, Linux and GPUI every press counts as a pointer's, a finger on a touchscreen laptop's
  included.
- A finger on iOS, iPadOS and Android drags a tab after a long press, as iPadOS drag and drop does, so a swipe over
  the tab bar scrolls it.
- Desktops and the web: handles show the resize cursor of their axis.
- Phones and narrow areas: the compact presentation, with drawers and a bottom sheet.
- Every platform draws what the app styles: tabs, tab bars, handles, the drop indicator, docks, drawers and the sheet.
