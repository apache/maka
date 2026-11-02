---
title: Resizable
description: "ResizablePanelGroup and ResizablePanel: panels side by side or stacked, with a handle between each two that the user drags to share the room. The group owns the drag, the panels' limits, the resize cursor and the handles' role for screen readers; the sizes, the handles' look and the panels' content are the app's."
group: base
demo: el-resizable
---

# Resizable

A resizable group lays out panels side by side or stacked, with a handle on each boundary between two of them: a
sidebar beside a document, an editor above its console, a list beside its detail. The user drags a handle to move the
boundary, and each panel stays within the sizes the app allows it. `ResizablePanelGroup` owns the behavior: the drag,
which runs natively frame by frame, how the room is shared, the resize cursor and a larger touch area for a finger.
The look is the app's: a handle is a band with no line, color or grip of its own, and what it draws is the app's
indicator; the panels are the app's views.

```rust tabs
use nsh_base::{h_resizable, resizable_panel, theme};
use nsh_core::prelude::*;

fn workspace() -> impl IntoElement {
    h_resizable()
        .handle_style(|s| s.bg(move || theme().border()))
        .handle_accessibility_label("Resize the sidebar")
        .on_resize(|sizes: &Vec<Points>| log::info!("sizes: {sizes:?}"))
        .child(
            resizable_panel()
                .size(px(240.0))
                .size_range(px(160.0)..px(480.0))
                .p_4()
                .child(text("Files").text_color(move || theme().muted_foreground())),
        )
        .child(
            resizable_panel()
                .p_4()
                .child(text("Editor").text_color(move || theme().foreground())),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";

function App() {
  const sidebar = signal(240);
  return (
    <ResizablePanelGroup
      axis="horizontal"
      handleClass="bg-border group-hover:bg-ring group-active:bg-primary"
      handleAccessibilityLabel="Resize the sidebar"
    >
      <ResizablePanel size={sidebar()} minSize={160} maxSize={480} onResize={({ size }) => sidebar.set(size)} class="p-4">
        <Text class="text-muted-foreground">Files</Text>
      </ResizablePanel>
      <ResizablePanel class="p-4">
        <Text class="text-foreground">Editor</Text>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

mount(App);
```

`ResizablePanelGroup` and `ResizablePanel` come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in
Rust. The panels are the group's direct children. In Rust, `h_resizable()` and `v_resizable()` make a group along each
axis (`resizable_panel_group().axis(..)` takes the axis as a value) and `resizable_panel()` a panel, with a setter per
prop, a listener per event, the typed style methods and `.child(..)` for their content; `.size_range(min..max)` sets
both limits at once.

## Sizes

A panel's `size` is the size it wants, within its `minSize` and `maxSize`. The panels without one share what is left
evenly, whatever their content; when every panel has a size, the room left over is shared in proportion to them.
While the user drags a handle, the group moves the room between the panels in the core, with no JS on the way:

- Growing the panel before the handle takes room from the panels after it, nearest first, each down to its `minSize`,
  passing over `fixed` ones.
- Shrinking it below its `minSize` takes room from the panels before it.
- No panel grows beyond its `maxSize`, and the panels never add up to more than the group.

When a drag ends having changed the sizes, the group reports every visible panel's size, in the order they are laid
out (`onResize` on the group), and each panel whose size changed reports its own (`onResize` on the panel). The panels
a drag moved keep the user's sizes until the app passes a new `size`; the app keeps them beyond the group's life by
passing the reported sizes back as `size`, so a layout it restores from [storage](../modules/nsh.md#storage) opens at
the sizes the user left. Only drags and screen readers' steps report: a window resized or a panel shown or hidden
reports nothing.

When the group grows or shrinks (the window is resized), the panels with a size keep it and the panels without one
take the difference. When the group is too small for the sizes, the panels shrink, `fixed` ones (a sidebar, an
inspector) aside, and they come back to their sizes when the room returns. A panel with `visible={false}` takes no
room: the others share its space, and it comes back at its size when it shows again.

```tsx
<ResizablePanelGroup axis="vertical" handleClass="bg-border">
  <ResizablePanel>
    <Editor />
  </ResizablePanel>
  <ResizablePanel size={180} minSize={120} fixed visible={consoleOpen()}>
    <Console />
  </ResizablePanel>
</ResizablePanelGroup>
```

## Handles

There is a handle on each boundary between two visible panels: a band 9 points thick across the axis, centered on the
boundary, with the resize cursor of its axis. On touch screens its touch area reaches 10 points further on either
side, so a one-point line is still easy to grab. The handle is a `group`: what it draws is the app's indicator, styled
with `handleClass` / `handleStyle`: 1 point across and the boundary's full length, so `bg-border` alone is a hairline on
either axis, and `w-[3px]` or `h-[3px]` thickens it, and its `group-hover:` and `group-active:` classes follow
the pointer over the band and the press or drag. For more than a line (a grip of dots, an icon), `renderHandle` renders
the indicator's content, told the handle's `index`, `axis` and `state`; it is drawn again when the state changes, a
few times per drag, never on every move. A grip that animates is the handle's thumb (`handleThumbClass` /
`handleThumbStyle`): one view centered on the line, drawn upright and turned a quarter on a horizontal line so one class
serves both axes, which `group-hover:` and `group-active:` classes show and transition; the handle stays pressed for
the whole drag, wherever the pointer goes.

```tsx
<ResizablePanelGroup
  handleClass="w-[3px] items-center justify-center bg-border"
  renderHandle={(handle) => (
    <View class={handle.state === "dragging" ? "h-8 w-1 rounded-full bg-primary" : "h-6 w-1 rounded-full bg-muted-foreground"} />
  )}
>
  {/* panels */}
</ResizablePanelGroup>
```

`disabled` keeps every handle where it is (a locked layout).

## Props

### ResizablePanelGroup

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `axis` | `h_resizable()`, `v_resizable()`, `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | Side by side (the handles are dragged left and right) or stacked (up and down). |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No drags: the handles stay where they are. |
| `handleClass`, `handleStyle` | `.handle_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each handle's indicator, on the boundary in the handle's band: 1 point across the axis and the boundary's full length unless it says otherwise (`w-[3px]`, `h-[3px]`); `group-hover:` and `group-active:` follow the band. |
| `handleThumbClass`, `handleThumbStyle` | `.handle_thumb_class(..)`, `.handle_thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each handle's thumb: a grip centered on the line, drawn upright as on a vertical line and turned a quarter on a horizontal one, so one class serves both axes. It stays the same view while the handle is hovered, pressed and dragged, so `group-hover:` and `group-active:` classes transition it (`h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100`). |
| `renderHandle` | `.render_handle(\|handle\| ..)` | `(handle: ResizeHandleContext) => JSX.Element` | none | What is inside each indicator, drawn again when the handle's `state` changes. |
| `handleAccessibilityLabel` | `.handle_accessibility_label(..)` | `string` | none | What screen readers say for each handle: what it resizes. They adjust it 10 points at a time. |
| `children` | `.child(..)` | `JSX.Element` | none | The `ResizablePanel`s, its direct children. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | `size-full` | The group itself; it fills its parent unless its class says otherwise. |

### ResizablePanel

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `size` | `.size(..)` | `number` | none | The length it wants along the group's axis, in points, within `minSize` and `maxSize`; a new value resizes it. Without one it shares what is left. |
| `minSize` | `.min_size(..)`, `.size_range(..)` | `number` | `100` | The smallest it gets. |
| `maxSize` | `.max_size(..)`, `.size_range(..)` | `number` | no limit | The largest it gets. |
| `fixed` | `.fixed(..)` | `boolean` | `false` | Keeps its size when the group is too small for the panels; dragging its own handle still resizes it. It takes a `size`. |
| `visible` | `.visible(..)` | `boolean` | `true` | Hidden, it takes no room and the others share its space. |
| `children` | `.child(..)` | `JSX.Element` | none | Its content. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The panel's own surface. Its size along the axis is the group's. |

### ResizeHandleContext

| Field | Type | Description |
|---|---|---|
| `index` | `number` | The boundary after the `index`th visible panel. |
| `axis` | `"horizontal" \| "vertical"` | The axis it resizes along. |
| `state` | `"idle" \| "hovered" \| "pressed" \| "dragging"` | How far the pointer or finger has gone with it. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onResize` (`ResizablePanelGroup`) | `.on_resize(\|sizes: &Vec<Points>\| ..)` | A drag ended and moved a handle, or a screen reader adjusted one: `sizes`, every visible panel's size, in the order they are laid out (left to right, top to bottom). |
| `onResize` (`ResizablePanel`) | `.on_resize(\|size: &Points\| ..)` | A drag ended and changed this panel's size: `size`, the new one, to pass back as its `size`. |

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The group | | `ResizablePanelGroup`'s `class`, `style` | |
| A panel | the group | `ResizablePanel`'s `class`, `style` | |
| A handle's indicator | the handle's band, on a boundary | `handleClass`, `handleStyle`, `renderHandle` | `group-hover:` under a pointer, `group-active:` while pressed or dragged; `state` in `renderHandle` |
| A handle's thumb | centered on a handle's line | `handleThumbClass`, `handleThumbStyle` | `group-hover:`, `group-active:` (pressed until the drag ends) |

## Accessibility

- Each handle is an adjustable element for screen readers, with `handleAccessibilityLabel` as its label. Its value
  is the size of the panel before it, within that panel's `minSize` and `maxSize`.
- Swiping up or down on a handle with VoiceOver, or TalkBack's volume keys, moves it 10 points, as a drag would; the
  group reports it with `onResize`. A `disabled` group's handles stay where they are.
- The panels' content is the app's and is read as it is anywhere else.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- Desktops (macOS, Windows, Linux, GPUI) and the web: the pointer over a handle shows the column or row resize cursor,
  and a drag with the mouse or a touchpad moves the boundary.
- iOS, Android and Mac Catalyst: a finger drags the handle, within a touch area 10 points wider on either side than
  the band.
- In right-to-left layouts the panels and their sizes follow the layout's order.
- Every platform draws what the app styles: the indicators and the panels.
- [Dock](./dock.md)'s splits are resizable groups: they are resized the same way.
