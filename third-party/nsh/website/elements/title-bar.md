---
title: TitleBar
description: "TitleBar: the row an app draws as its window's title bar. Its background spans the row, it moves the window, and its content keeps clear of the system's window controls only where the row meets them."
group: base
demo: el-title-bar
---

# TitleBar

A window with `titleBar: { style: "hidden" }` keeps the system's window controls (macOS's traffic lights, Windows'
caption buttons, the window buttons of a Linux desktop) and leaves the rest of its top row to the app. `TitleBar` is
that row: pressing and dragging it moves the window, double clicking it does what the system's title bar does, and the
buttons, inputs and links inside it still take their presses. It is as tall as the window's title bar area at least,
lays its children out in a row, and adds padding at its left and right edges only where it overlaps the window
controls, so its background still reaches the window's edge under them.

The overlap is measured where the bar is. A split view gives each pane a bar of its own: the sidebar's bar steps aside
of the traffic lights at the left, the content pane's bar starts past them and gets none, and once the sidebar hides,
the content pane's bar meets them and steps aside. Entering full screen (no controls) takes the padding away. The
controls are those of the window the bar renders in: a `TitleBar` in a second `<Window>` follows that window's.

```tsx tabs
import { mount, Text, View } from "nsh";
import { TitleBar } from "nsh/base";
import { Window } from "nsh/desktop";

function App() {
  return (
    <View class="flex-1 flex-row">
      {/* The sidebar's part of the title bar: past the traffic lights. */}
      <TitleBar class="h-11 w-60 bg-muted">
        <Text class="px-3">Library</Text>
      </TitleBar>
      {/* The content's part: no padding while the sidebar is shown. */}
      <TitleBar class="h-11 flex-1 border-b border-border">
        <Text class="px-3">Inbox</Text>
      </TitleBar>
    </View>
  );
}

mount(() => (
  <Window id="main" titleBar={{ style: "hidden" }}>
    <App />
  </Window>
));
```

```rust tabs
use nsh_base::{theme, title_bar};
use nsh_core::prelude::*;

fn chrome() -> impl IntoElement {
    view()
        .flex_row()
        .flex_1()
        // The sidebar's part of the title bar: past the traffic lights.
        .child(
            title_bar()
                .w(px(240.0))
                .h(px(44.0))
                .bg(move || theme().muted)
                .child(view().px_3().child(text("Library"))),
        )
        // The content's part: no padding while the sidebar is shown.
        .child(
            title_bar()
                .flex_1()
                .h(px(44.0))
                .border_b_1()
                .border_color(move || theme().border)
                .child(view().px_3().child(text("Inbox"))),
        )
}
```

`TitleBar` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust (`title_bar()`). The padding
it adds is the part of the controls' width it overlaps: an app's own padding goes on a view inside it, as a padding on
the bar itself would replace it. A window with the system's title bar (the default) reports no title bar area: the bar
adds nothing and is just a row. On platforms without windows it is a row as well.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | none | What the bar holds: a title, a sidebar toggle, the app's buttons. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The bar's look and layout: its background, border, height above the title bar area's, gaps. |

To read the title bar area yourself (a layout of your own), use `titleBar()` from [`nsh/desktop`](../modules/nsh-desktop.md)
(`current_window().title_bar()` in Rust): its `height` and the `left` and `right` widths the controls take.
