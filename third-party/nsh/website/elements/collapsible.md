---
title: Collapsible
description: "The Collapsible component: a region whose content expands and collapses, shown after its children while the app has it open, with the trigger and every look the app's."
order: 20.7
group: base
demo: el-collapsible
---

# Collapsible

A collapsible is a region whose content expands and collapses: details under a summary, a "show more", a section of
advanced settings. It renders its children always and its `content` after them while `open`. The app owns `open` and
the trigger that flips it (one of the children), and the look is the app's: a `Collapsible` has no trigger, chevron,
motion or label of its own.

```rust tabs
use nsh_base::{collapsible, theme};
use nsh_core::{AccessibilityState, prelude::*};

fn storage() -> impl IntoElement {
    let open = signal(false);
    collapsible()
        .open(open)
        .gap_2()
        .child(
            view()
                .role(AccessibilityRole::Button)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open.get()),
                    ..AccessibilityState::default()
                })
                .on_press(move || open.update(|o| *o = !*o))
                .flex_row()
                .items_center()
                .justify_between()
                .child(text("Storage"))
                .child(text("›").transition_transform().rotate(move || {
                    if open.get() { deg(90.0) } else { deg(0.0) }
                })),
        )
        .content(text("Photos 120 GB · Apps 54 GB · System 38 GB").text_color(move || theme().muted_foreground))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Collapsible } from "nsh/base";

function App() {
  const open = signal(false);
  return (
    <Collapsible
      open={open()}
      class="gap-2"
      content={<Text class="text-muted-foreground">Photos 120 GB · Apps 54 GB · System 38 GB</Text>}
    >
      <View
        role="button"
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="flex-row items-center justify-between active:opacity-70"
      >
        <Text class="font-medium">Storage</Text>
        <Text class={`transition-transform ${open() ? "rotate-90" : ""}`}>›</Text>
      </View>
    </Collapsible>
  );
}

mount(App);
```

`Collapsible` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is the app's:
its trigger flips `open`, and the collapsible shows the value the app passes. In Rust, `collapsible()` makes one with a
setter per prop (`.open(..)`, `.content(..)`), the typed style methods for the region and `.child(..)` for what shows
always.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | `false` | Expanded: the `content` is in the tree, after the children. The app owns the value. |
| `content` | `.content(..)` | `JSX.Element` | none | What expands. It is made once and kept while collapsed, so what is inside keeps its state (an input's text, a scroll position, a switch) from one opening to the next. |
| `children` | `.child(..)` | `JSX.Element` | none | What shows either way: a summary, the trigger that flips `open`. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The region around the children and the content (`gap-2` spaces them). |

## Events

A collapsible reports nothing of its own: the trigger is the app's, and its press (`onPress` of the `View` with
`role="button"`) is where the app flips `open`.

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The region | | `class`, `style` |
| The children | the region, first | their own elements |
| The content | the region, after the children, while `open` | its own elements (`content`) |

The content comes and goes at once. A transition of the app's shows the change: the trigger's chevron turns
(`transition-transform`), and the content can fade in with its own classes. Each platform lays the region out again
when the content arrives or leaves.

## Accessibility

- The region is no element of its own for screen readers: its children and content are read as they are.
- The trigger says whether the region is expanded: give it `accessibilityState={{ expanded: open }}` and a button role
  (`role="button"` on a `View`), and screen readers announce "expanded" or "collapsed" with its label.
- On macOS and the web the trigger is a stop of the keyboard focus when it takes presses: Tab reaches it, Space and
  Return flip the region.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- Every platform shows the content after the children while `open`, and leaves it out of the layout otherwise.
- iOS, Android and Mac Catalyst: the trigger's press is a tap. Desktops (macOS, Windows, Linux, GPUI) and the web: a
  click, and Space or Return on the focused trigger on macOS and the web.
