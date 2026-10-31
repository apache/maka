---
title: Scrollbar
description: "The Scrollbar component: a scroll bar of the app's own look for every scroll view and list (a theme set once) or for one, placed where the app wants it, whose thumb follows the content and whose drags and presses scroll it, shown while scrolling, on hover or always, fading in and out by the app's timing."
group: base
demo: el-scrollbar
---

# Scrollbar

A scrollbar gives a scroll view or a list a bar in the app's own look: a thin pill that widens under the pointer, a
track in the brand's tone, a bar beside a fixed header or along two panes. Set once as the app's theme, every scroll
view and list draws one in place of the platform's indicator ([Built-in bars](#built-in-bars)); placed by the app, it
names the scroll view it moves and sits wherever the app puts it. It owns its behavior: the thumb's length and place follow the content, the viewport and
the offset (also while a list grows or the window resizes); dragging the thumb scrolls the content, and a press on the
track brings the thumb's middle there; it shows while the content scrolls, while the pointer is over it, or always,
and fades in and out natively. The look and the timing are the app's: a `Scrollbar` has no colors, sizes or radii of
its own, and its fades take no time until the app gives them some.

```rust tabs
use nsh_base::{ScrollbarEntrance, ScrollbarMode, ScrollbarMotion, scrollbar, theme};
use nsh_core::prelude::*;

fn inbox(rows: impl IntoElement) -> impl IntoElement {
    let list = element_ref();
    // In over 300 ms and out over 500 ms, 2 s after the last scroll; pointing
    // at the hidden thumb slides it in from the edge.
    let mut motion = ScrollbarMotion::default();
    motion.enter = 300.0;
    motion.exit = 500.0;
    motion.thumb_hover_entrance = ScrollbarEntrance::SlideAndFade;
    view()
        .relative()
        .flex_1()
        // The scroll view's own indicator gives way to the app's bar.
        .child(scroll().element_ref(&list).flex_1().scrollbar(false).child(rows))
        .child(
            scrollbar()
                .scroll(list)
                .mode(ScrollbarMode::Hover)
                .motion(motion)
                .accessibility_label("Messages")
                // The track over the right edge; the thumb right-aligned in it.
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(px(16.0))
                .items_end()
                .p(px(4.0))
                .thumb_style(|s| {
                    s.w(px(6.0))
                        .rounded_full()
                        .bg(move || theme().muted_foreground)
                        .opacity(0.6)
                        .group_hover(|s| s.w(px(8.0)).opacity(0.9))
                }),
        )
}
```

```tsx tabs
import { mount, Scroll, Text, View, type YNode } from "nsh";
import { Scrollbar } from "nsh/base";

function App() {
  let list: YNode | undefined;
  return (
    <View class="relative flex-1">
      <Scroll ref={list} scrollbar={false} class="flex-1">
        {Array.from({ length: 60 }, (_, i) => (
          <Text class="px-4 py-3">{`Message ${i + 1}`}</Text>
        ))}
      </Scroll>
      <Scrollbar
        scroll={list}
        mode="hover"
        motion={{ enter: 300, exit: 500, thumbHoverEntrance: "slideAndFade" }}
        accessibilityLabel="Messages"
        class="absolute inset-y-0 right-0 w-4 items-end p-1"
        thumbClass="w-1.5 rounded-full bg-muted-foreground opacity-60 transition-all duration-300 hover:w-2 hover:opacity-90 active:w-2 active:opacity-100"
      />
    </View>
  );
}

mount(App);
```

`Scrollbar` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `scrollbar()` makes
one with a setter per prop (`.scroll(..)`, `.thumb_style(..)`) and the typed style methods for the bar itself; its
`scroll` takes an `ElementRef` (or a `ScrollbarTarget`).

## Built-in bars

Every scroll view and list can draw a `Scrollbar` in place of the platform's indicator, with no bar to place:
`Scrollbar.setTheme` gives the app's look to the bar of each view whose `scrollbar` is `true`, once, wherever the
app starts. Each view gets its own bar over its viewport, which stays there as the content scrolls (on the main
thread, as sticky views do) and draws above the content; it follows, scrolls and fades as a placed `Scrollbar` does.

```rust tabs
use nsh_base::{ScrollbarLook, ScrollbarMode, ScrollbarTheme, set_scrollbar_theme};

fn use_app_scrollbars() {
    let mut vertical = ScrollbarLook::default();
    vertical.class = Some("absolute inset-y-0 right-0 w-4 items-end p-1".into());
    vertical.thumb_class = Some("w-1.5 rounded-full bg-muted-foreground opacity-60 hover:w-2".into());
    let mut horizontal = ScrollbarLook::default();
    horizontal.class = Some("absolute inset-x-0 bottom-0 h-4 items-end p-1".into());
    horizontal.thumb_class = Some("h-1.5 rounded-full bg-muted-foreground opacity-60 hover:h-2".into());
    let mut theme = ScrollbarTheme::default();
    theme.mode = ScrollbarMode::Hover;
    theme.motion.enter = 300.0;
    theme.motion.exit = 500.0;
    theme.vertical = Some(vertical);
    theme.horizontal = Some(horizontal);
    set_scrollbar_theme(Some(theme));
}
```

```tsx tabs
import { Scrollbar } from "nsh/base";

Scrollbar.setTheme({
  mode: "hover",
  motion: { enter: 300, exit: 500 },
  vertical: {
    class: "absolute inset-y-0 right-0 w-4 items-end p-1",
    thumbClass: "w-1.5 rounded-full bg-muted-foreground opacity-60 transition-all duration-300 hover:w-2",
  },
  horizontal: {
    class: "absolute inset-x-0 bottom-0 h-4 items-end p-1",
    thumbClass: "h-1.5 rounded-full bg-muted-foreground opacity-60 transition-all duration-300 hover:h-2",
  },
});
```

A `ScrollbarTheme` has the props of a bar that are the same for every view, and the look of each axis:

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `"scrolling" \| "hover" \| "always"` | `"scrolling"` | When the bars show: [When it shows](#when-it-shows). |
| `motion` | `ScrollbarMotion` | snaps, `idle` `2000` | How they show and hide: [Motion](#motion). |
| `minThumbLength` | `number` | `48` | The shortest a thumb gets. |
| `vertical`, `horizontal` | `ScrollbarLook` | none | The look of the bars of vertical and of horizontal views: `class` and `style` for the track, placed in the view's viewport; `thumbClass` and `thumbStyle`; `accessibilityLabel`. A view whose axis has no look keeps the platform's indicator. |

A later `setTheme` restyles the bars, and `Scrollbar.setTheme(null)` gives the views the platform's indicator back. One
view takes a theme of its own as its `scrollbar` prop (`<Scroll scrollbar={{ mode: "always", vertical: { … } }}>`),
whether or not the app set one; `scrollbar={false}` leaves a view without a bar. A list laid out in its parent's
viewport (`viewport="parent"`) scrolls with that view and its bar. A multiline `Input` gets the bar of its vertical look
too, over its text, which it scrolls as the text view's own indicator does.

## The scroll view it moves

`scroll` names the scroll view or the list the bar follows: its `ref`. The bar finds it once it is on screen, so the
`ref` may be set by an element later in the same render; write the bar after its scroll view (or keep the `ref` in a
signal). Turn the scroll view's own indicator off with `scrollbar={false}`, and place the bar with `class`: over the
scroll view's edge in a `relative` box around both, or anywhere else on the screen.

- The thumb is as long as the share of the content the viewport shows, along the track's content box (inside its
  padding), and no shorter than `minThumbLength`. Its place is how far the content is scrolled; while the content
  bounces past an end, the thumb stays at that end.
- A drag of the thumb scrolls the content by as much as the thumb moves. A press on the track brings the thumb's middle
  under the pointer, and a drag goes on from there.
- A vertical bar follows a vertical scroll view; `axis="horizontal"` makes a bar for a horizontal one (place it along
  the bottom edge). One bar per axis.
- Lists work alike: the thumb follows the list's whole length as rows are measured and added.

## When it shows

| `mode` | Shows |
|---|---|
| `"scrolling"` (default) | While the content scrolls, and until `motion.idle` after it stops; the pointer on the bar while it shows keeps it. |
| `"hover"` | While the pointer is over the bar (where it shows, even while hidden), and as `"scrolling"` does. |
| `"always"` | Always. |

In every mode it shows while its thumb is dragged, and stays `motion.idle` after the last scroll, drag or hover. While
the content fits the viewport, it stays hidden. Hidden, the bar is at `opacity: 0` and passes presses through to what
is under it.

## Motion

`motion` times the bar's fades, which run natively, as `gpui-base`'s `ScrollbarMotion` does:

| Field | Default | Description |
|---|---|---|
| `idle` | `2000` | How long the bar stays after the last scroll, drag or hover, in milliseconds. |
| `enter` | `0` | How long it takes to appear: its opacity rises linearly, a slide eases out. |
| `exit` | `0` | How long it takes to fade away once `idle` is over, easing in; it slides out of its track as it fades. |
| `entrance` | `"fade"` | How it comes in: `"fade"` in place, or `"slideAndFade"` from the edge it is on (the right, the bottom). |
| `thumbHoverEntrance` | `"fade"` | How it comes in when the pointer on its hidden thumb shows it (`"hover"`). |

With no durations the bar snaps in and out. A fade reversed halfway keeps its speed: it runs for the share of its
duration still to cover. An `"always"` bar never animates, nor does any while the user asks for less motion. The
track clips what slides. The thumb's own motion, such as a width that grows on `hover:`, is its style's
(`transition-all` on `thumbClass`).

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `scroll` | `.scroll(..)` | `YNode` | none | The scroll view or list the bar follows and moves (its `ref`). |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"vertical"` | The axis of the scroll view: the track runs along it. Read when the bar is made. |
| `mode` | `.mode(..)` | `"scrolling" \| "hover" \| "always"` | `"scrolling"` | When the bar shows. |
| `motion` | `.motion(..)` | `ScrollbarMotion` | snaps, `idle` `2000` | How it shows and hides: [Motion](#motion). |
| `minThumbLength` | `.min_thumb_length(..)` | `number` | `48` | The shortest the thumb gets on a long content, so it stays easy to grab. |
| `thumbClass`, `thumbStyle` | `.thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The thumb. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say of the bar. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The bar: its track, where the app places it. |

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The track | where the app places it | `class`, `style` |
| The thumb | the track's content box | `thumbClass`, `thumbStyle` |

The bar sizes the thumb along the axis and moves it; its thickness and its place across the track are the app's
(`w-1.5` and `items-end` on the track put a 6-point thumb at the right). The track's padding keeps the thumb off its
ends and sides.

States the parts show:

- The track: `hover:` under the pointer; it is a `group`, so the thumb takes `group-hover:` from it (a thumb that
  widens as the pointer comes near).
- The thumb: `hover:` under the pointer, `active:` while it is dragged.

The bar's visibility is its opacity: give the colors' transparency to the track's background or the thumb. A thumb
that widens takes `transition-all` (it never delays the thumb's place, which the bar sets apart from the thumb's
styles), and `motion-reduce:` keeps it still for people who ask for less motion.

## Accessibility

- The scroll view stays what screen readers scroll: they move it with their own gestures and read its content.
- The bar is labelled by `accessibilityLabel` for the screen readers that reach it.

See [Accessibility](../docs/accessibility.md) for labels, roles and actions in general.

## Platform notes

- Every platform draws what the app styles, and the thumb follows the offset each platform reports for the scroll
  view. Drags of the thumb and presses on the track work with a mouse, a pen or a finger.
- `"hover"` follows a mouse or a touchpad pointer (the desktops and the web); on a touch screen, the bar shows while
  the content scrolls, and its hidden track lets touches through.
