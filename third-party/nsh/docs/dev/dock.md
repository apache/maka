# Dock and Resizable

`nsh/base`'s dockable workspace (`DockArea`) and the resizable splits it is built from (`ResizablePanelGroup`,
`ResizablePanel`), in `crates/nsh-base/src/dock/` and `crates/nsh-base/src/resizable/`. Both are ports of
`gpui-base`'s (`gpui-kit/crates/base/src/dock/`, `resizable/`): the same vocabulary, the same layout algebra, the same
persisted format, with NSH's component model in place of GPUI entities and renderer traits. The user-facing pages are
`website/elements/dock.md` and `website/elements/resizable.md`; how each module works inside is in its `//!` docs
(`dock/mod.rs` is the long version of this page's first half).

## Layers

| Layer | Where | What |
|---|---|---|
| Layout data | `dock/layout/` (`PaneTree`, `PaneNode`, `PaneRef`, `NodeId`, `PanelId`, `DockLayout`, `InsertTarget`, `EditResult`, `RootKind`) | One region's layout as a value: edits, normalization, queries. No component, no core, no JS |
| Dock sizing and drop geometry | `dock/dock_placement.rs` (`Dock`, `DockSizing`), `dock/drag.rs` (`DropPlaceholderBounds`, `split_placement_at`) | How big a dock may be; which edge of a group a drop splits off and what its placeholder covers (the target itself is `dock_area.rs`' `DockTarget` / `DockDropIndicator`) |
| Persisted format | `dock/state.rs` (`DockAreaState`, `DockState`, `PanelState`, `PanelInfo`, `DockPlacement`), `dock/state_convert.rs` (`PanelSource`, `PanelBuilder`, `PanelKeys`) | `gpui-base`'s on-disk format, field names and tags frozen |
| JS values | `dock/value.rs` (`DockAreaLayout`, `DockRegion`, `DockNode`) | The `layout` the area takes and reports, and its conversions from and to `PaneTree`s |
| Resizable | `resizable/` (`ResizablePanelGroup`, `ResizablePanel`, `ResizeHandle`, `ResizableState`) | Panels along one axis with handles between them; used on its own and by the dock's splits |
| The area as a value | `dock/area.rs` (`Area`) | The four trees and the docks' states as one value: edits across trees, the rules of what may move and close; plain data, tested alone |
| The component | `dock/dock_area.rs` (`DockArea`, `DockAreaApi`, the values its render props get), `dock/tab_group.rs` (tab groups, the tab drag), `dock/compact.rs` (the compact presentation) | Renders the trees with resizable groups and tab groups, runs drags, docks, zoom and the lock, reports each edit |

The first four layers are plain data with plain `#[test]`s, kept from `gpui-base` test for test; the fixtures in
`dock/fixtures/` are `gpui-base`'s layout files, so a file written by one reads in the other.

## The model

Each region (the center, and an optional left, right and bottom dock) is one `PaneTree`. A node is a `Split` (children
along one axis, each slot with an optional size) or a `Tabs` (panels shown one at a time); there is no leaf variant, so
a panel always lives in a tab group. Two ids, both stable:

- `NodeId` (a `u64`, from one counter per process, so the four trees of an area never share one) survives every edit
  and every normalization rule: a container still present after a drag has the id it had before.
- `PanelId` is the app's key for the panel (a `SharedString`, `"files"`), where `gpui-base` has the panel entity's
  `EntityId`. NSH's panels are content the app renders from its key, not entities the dock holds.

Every edit (`insert_panel`, `remove_panel`, `move_panel`, `split`, `set_active`, `set_sizes`) runs one normalization
pass to a fixpoint before it returns (empty containers removed, a one-child split replaced by its child, a same-axis
child split spliced into its parent with sizes scaled, `active_ix` clamped, the center's root kept a split), so no
caller ever sees a malformed tree, and `normalize(normalize(t)) == normalize(t)`. Each edit returns an `EditResult`
(whether it changed anything; the area reports a layout only then), and a panel moved across trees is detached and
inserted without ever leaving the area, so it is not a removed one.

## Controlled layout

`DockArea`'s `layout` is the app's value (or the area keeps its own from `defaultLayout`). The area installs it
(`DockAreaLayout::to_trees`: ids assigned where the app left them out, a repeated id replaced, a panel listed twice
kept in its first place, `sizes` fitted to the children, every tree normalized) into an `Area` (`dock/area.rs`: the
four trees and the docks' states as one value, where a move across trees is a detach and an insert and a panel never
leaves the area on the way). Every edit, the user's or a method of the ref's (`DockAreaApi`), runs on the `Area` in
the core and is reported as the whole new layout (`onLayoutChange`), every id included; a controlled area shows it
once the app passes it back. Reported ids are what keep containers' identity across that round trip, and what the
ref's methods name groups by.

What crosses to JS is the result of an interaction, never its frames: a split or dock being resized, a tab being
dragged over the groups and its drop indicator all run in the core on the engine thread (the touch responder,
`docs/dev/components.md` "Touches and the responder"), and only the edit they end in is reported. The layout is
reported on every edit, a tab selection and a resize included, so the user-facing page says to debounce writes to
storage. The other events follow `gpui-base`'s panel hooks: `onPanelActiveChange` fires once per real edge of "is its
group's displayed tab" (deactivations first; a panel that leaves is not told `false`), `onPanelRemove` when a panel
leaves for good (a moved one never hears it), `onZoomChange` with the displayed panel or `null`, and
`onDockOpenChange` when a dock shows or hides ("Mobile and compact width"). Per-panel flags (`closable`, `zoomable`,
`visible`, `gpui-base`'s `Panel` methods) are data, the `panels` prop (`DockPanelOptions`).

## Panels' content: render keys

The content of a panel is the app's, rendered by `renderPanel` (a `Renderer<DockPanel>`, `nsh_core::element::renderer`)
keyed by the panel's key. Each group's content frame places a placeholder for every panel of the group with the
panel's key, shows the displayed one and hides the others, and the core shows JS's holder for a key in the last
placeholder placing it (`crates/nsh-core/src/core/renders.rs`). A panel that moves to another tab group, another
region, or into a zoom is the same key placed elsewhere: the core moves the holder JS rendered into the new
placeholder, so what the panel holds (its signals, an input's text, a scroll offset, a web view's page) stays, and
switching tabs keeps it too. JS is asked to render a key again only when the value the area passes for it changes,
and is told to drop it (`JsEvent::Unrender`) when no placeholder places it any more: closing or removing the panel,
or a layout that no longer lists it. The compact presentation places every center panel as well, so crossing the
600-point boundary keeps them.

This is NSH's form of `gpui-base`'s property "a drag does not reset what it did not touch". In `gpui-base` the panel
is an entity the dock holds, and reconciliation against the `NodeId` cache keeps the tab group entities; here the
tab groups are rendered by the area for each `NodeId` and the panels by the app for each `PanelId`, and both survive
every edit that keeps them.

The other parts the app draws are render props as well (`renderTab` and `renderDragPreview` with a `DockTab`,
`renderDropIndicator` with a `DockDropIndicator`, `renderDock` with a `DockInfo`, `renderEmpty`), and every part
takes `<part>Class` / `<part>Style` (group, tab bar, tab, content, drop indicator, handle, handle thumb, dock, and
compact's drawer, sheet and backdrop). The drop indicator moves natively: when its target changes the area asks for a
layout animation of that commit (`tab_group.rs` `animate_indicator`: the indicator eases to its new place, within a
group or across groups, and fades in as it appears and out as it goes; nothing with reduced motion), and the drag preview follows the pointer by
a transform, so nothing else in such a commit changes its frame. The area wraps what the app renders with the behavior: a tab's press selects it, its drag moves
it, a handle's drag resizes. The app draws every pixel; the area draws none.

## Drag and drop

A tab claims the touches of a gesture with the core's responder (`tab_group.rs`). The input decides, not the
platform: a press from a pointer (a mouse, a trackpad, a pen hovering: anything that hovered the tab before pressing
it), and every press on the desktop OSes (a touchscreen laptop's finger too), drags once it moves `DRAG_SLOP` (4
points) from where it went down; a finger's press on iOS and Android only after a long press armed it, so a swipe
over the tabs scrolls them. An iPad with a trackpad, or a phone-width browser window driven by a mouse, drags as a
desktop does. The grant starts the drag: every group's tab bar, tabs and content frame are measured in the root
view's coordinates in one task, answered with the next commit. Each move resolves the target from those bounds: over
a tab bar, the slot between the tabs the pointer is past (counted without the dragged tab); over a content frame, its
middle merges and its outer 35% on each side splits (`split_placement_at`), except back onto its own group when that would change
nothing. The drop indicator part covers what the panel would take in the target group
(`DropPlaceholderBounds::for_placement`): it is one overlay in the root view, placed with the content frame the drag
measured, so it draws above the handles, whose lines lie over the edges of the groups beside them, and no frame clips
it, and the release applies one move (`PaneTree::move_panel` within a tree,
detach and insert across trees) and one `onLayoutChange`. A gesture the system takes away drops nothing.

The rules of what may move are `Area::groups`', as `gpui-base`'s: a locked or zoomed area rearranges nothing, and a
group with nothing beside it in its tree cannot give its last visible panel away (dragging or closing it would empty
the region). Selecting tabs, resizing and toggling docks work in a locked area.

## Docks

A dock (`Dock`) has a size across its edge (default 200 points, never below `PANEL_MIN_SIZE`, 100), an open state
and a collapsible flag. `DockSizing` clamps a resize against the area and the opposite dock, so the center keeps room;
the dock stays at least 100 points and the center keeps 100; a collapsible dock let go below 50 points closes and
keeps its size. A dock's frame clips, so its edge is a `ResizeHandle` hugging it from inside (`HandleEdge`). A closed
dock keeps its tree and its size, and reopening restores both.

The area never exceeds its bounds: its root clips and takes no minimum size from its content, a dock shows at its
`size` clamped to what the area leaves it (at most the area minus the center's 100 points, as `gpui-base` clamps),
the docks shrink with the rest when even that does not fit, and the splits' minimum sizes yield when the area is
smaller than their sum. Every handle (split and dock edge) is `adjustable`, labeled by `handleAccessibilityLabel`. The bottom dock spans the center's column, between the left and right docks, as in `gpui-base`.

## Zoom

A zoom names a container (`NodeId`), not a panel: the zoomed tab group fills the area, and it stays zoomed when its
displayed panel closes and the next takes over. Zoom ends when the container leaves the layout or the app zooms out
(`toggleZoom()`).

## Mobile and compact width

Docking has a mobile counterpart, so the dock runs on every platform and adapts by width, not by operating system:

- Tablets run multi-pane workspaces: iPad's `UISplitViewController` columns, Material 3's canonical layouts
  ("supporting pane", "list-detail"), studio apps with side panels (Affinity, LumaFusion). An area 600 points and wider
  (Material 3's medium and expanded classes: an iPad full screen, Android tablets, foldables open, desktops, the web)
  is the full dock, as on a desktop. With a finger, a tab drag starts on a long press, as iPadOS drag and drop does, so a
  finger can still scroll a tab strip; split and dock handles get a larger touch hit area (`hit_slop`) with the same
  look.
- Phones and narrow windows collapse those workspaces: `UISplitViewController` collapses its columns in compact width,
  and Material 3's supporting pane becomes a bottom sheet in the compact class. In an area narrower than 600 points
  (on phones, iPad Slide Over and narrow Split View, in narrow desktop or browser windows, or in a narrow column of a
  wide window), the layout data is the same and only its presentation changes:
  - the center shows one tab group at a time, full size; its tab bar lists every panel of the center in tree order,
    and selecting a panel of another group makes that group the current one;
  - the left and right docks are drawers over the center from their edge, sliding as `Sheet` does (`SheetMotion`);
    a dismissed one stays placed out of view (`display: none` around its overlays, which also keeps it from taking
    Escape), so its panels keep their content;
  - the bottom dock is a bottom sheet, the same way;
  - a tab drag reorders within the strip and creates no splits.
  The compact presentation keeps its own presented dock: at most one, none on entering it, whatever the layout's
  `open` says. `toggleDock` / `setDockOpen` present one (dismissing the other) or dismiss it, and a press on its
  backdrop, Escape and back dismiss it. The layout's `open` stays the full presentation's: compact never changes it
  and reports no `onLayoutChange`, so an area that widens again shows the docks as they were.
  `onDockOpenChange(placement, open)` reports what shows in either presentation (the layout's `open` in the full one, the presented dock in the compact
  one, and the docks whose shown state changes when the presentation switches; on mount, the docks whose shown state
  differs from the layout's `open`), so a toolbar toggle that starts from the layout's `open` follows both;
  `DockInfo.open` is the same "shown now".
  `compact` overrides the automatic choice (`compact.rs`). The app styles the drawers, the sheet and the backdrop
  through their parts, as every other part: NSH draws no scrim or card.

The width decides, not the device, and it is the area's own width (from its layout; the window's width stands in until
it is first laid out): an iPad in Slide Over is compact, a phone in landscape at 600 points or more is regular, as
both platforms' own adaptive layouts decide, and a dock in a narrow column of a wide window is compact too, since
the room it has is what its presentation must fit. Keeping one layout value for both presentations means an area
resized across the boundary (a foldable unfolding, iPad multitasking, a window or a column made narrow) keeps every
panel where it was, and the app persists one layout.

## Resizable

`ResizablePanelGroup` lays out its `ResizablePanel` children along one axis; the module doc of
`crates/nsh-base/src/resizable/mod.rs` is the detailed version. In short:

- The panels register with the group through a context and report their props and frames; `ResizableState`
  (`gpui-base`'s sizing as data, tested alone) decides every size, and each panel's flex basis, grow, shrink and
  limits are bound to a memo of it, so a change restyles only the panels it moved. Panels without a size have a flex
  basis of 0, so they share the rest evenly whatever their content.
- A handle is a band (9 points: the boundary's line and 4 points either side, `HANDLE_SIZE` / `HANDLE_PADDING`; 10
  more each side on touch screens through `hit_slop`) with the resize cursor and the role `adjustable`. It is a
  `group` whose child, the indicator, is the app's (`handleClass` / `handleStyle`, 1 point across and the boundary's
  full length by default, so one class draws a hairline on either axis and the dock's handles share it; and
  `renderHandle` keyed by the handle's index and drawn again on each `ResizeHandleState` change, never per move).
  Its thumb (`handleThumbClass` / `handleThumbStyle`, `ResizeHandle`'s `thumb_class` / `thumb_style`; none without
  them) is a grip of the app's centered on the line: one view that stays as the state changes, so `group-hover:` /
  `group-active:` classes transition it (a new `renderHandle` render would not), drawn upright as on a vertical line
  and turned a quarter on a horizontal one so one class serves both axes, and centered by transforms (a point half a
  point into the line, the thumb moved back by half its size), which layout does not round
  (`resize_handle.rs` `handle_thumb`). The band is its touches' responder, so it stays pressed for the whole drag.
- Drags run in the core: the band claims the touches that go down on it (the touch responder; the desktops' mouse
  drags are touches too), reads the panels' laid out sizes once as the drag starts, and resizes the panel before the
  handle on every move. Nothing reaches JS until the drag ends: when it changed the sizes, the group reports every
  visible panel's size (`onResize(sizes)`), each changed panel its own.
- A panel's `size` is what it wants, within its range: unsized panels share what is left (in proportion to the sizes
  when every panel has one), and when the group is too small the panels shrink (`fixed` ones aside) and come back to
  their sizes when room returns. A drag gives the panels it moved the user's sizes until the app passes a new `size`;
  only drag ends and screen readers' steps report (`onResize`), never a resize of the group or a panel shown or
  hidden.
- `ResizeHandle` (Rust only) is the same band on a container's edge (`HandleEdge::Leading` / `Trailing` hug it from
  inside, as a clipping dock frame needs), reporting `on_drag_start`, `on_drag_move(offset)` and
  `on_drag_end(offset)`; the dock's edges use it.

## Accessibility

A group's tab bar has the `"tablist"` role and its tabs the `"tab"` role with their selected state, as `Tab` /
`Tabs`. A resizable group's handles (the dock's splits too) are `adjustable` elements labeled by the app, valued with
the size of the panel before them in its range, with the `increment` / `decrement` actions (VoiceOver's swipes,
TalkBack's volume keys) moving them 10 points as a drag would. Keyboards do not move them: the core reports keys
only to inputs and the surface's bindings, and no event says a view other than an input took the focus
(`resizable/mod.rs`).

## From gpui-kit

| `gpui-base` | NSH |
|---|---|
| `PanelId(EntityId)` | `PanelId(SharedString)`: the app's key |
| `Panel` trait, `PanelView` | the app's `renderPanel` by key; `closable`, `zoomable`, `visible` as data (`panels`, `DockPanelOptions`) |
| `set_active`, `on_removed`, `set_zoomed` hooks | `onPanelActiveChange`, `onPanelRemove`, `onZoomChange`; `DockTab`'s `active`, `zoomed` |
| `DockAreaRenderer`, `TabGroupRenderer` | the area's render props (`renderTab`, `renderDropIndicator`, `renderDock`, `renderEmpty`, `renderDragPreview`) and `<part>Class` / `<part>Style` |
| `TabGroupContext`, `DockContext` actions, `DockArea` methods | the behavior the area wraps around rendered parts, and `DockAreaApi` (the ref) |
| `DockEvent::LayoutChanged` | `onLayoutChange` with the whole layout |
| `register_panel` registry | `PanelBuilder` / `PanelKeys` (the key read back from `PanelInfo::Panel({"id": key})`) |
| `Pixels`, `gpui::Axis`, `Bounds` | `Points`, `nsh_core::geometry::Axis`, `Bounds<Points>` |
| reconciliation against the `NodeId` entity cache | render keys (`core/renders.rs`) |
| `ResizeHandleRenderer` | `handleClass` / `handleStyle`, `handleThumbClass` / `handleThumbStyle` (the grip, transitioned by classes) and `renderHandle` (`ResizeHandleContext`) |
