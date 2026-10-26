---
title: Scroll
description: "The native scroll view: vertical and horizontal scrolling, paging and snapping, pull to refresh, zooming and scroll events."
order: 5
group: primitives
demo: el-scroll
---

# Scroll

`Scroll` is a native scroll view (UIScrollView on iOS and Mac Catalyst, a ScrollView on Android). It lays out all its
children as its content and scrolls them natively: scrolling, flinging, bouncing and snapping run on the platform, at
the display's rate. Rust makes one with `scroll()`, TSX with `<Scroll>` from `nsh`.

```rust tabs
use nsh_core::prelude::*;

scroll().flex_1().child(
    view().p_4().gap_2().child(each(
        rows,
        |row: &Row| row.id,
        |row, _index| text(move || row.get().title),
    )),
)
```

```tsx tabs
<Scroll style={{ flex: 1 }}>
  <View style={{ padding: 16, gap: 8 }}>
    <Each of={rows}>{(row) => <Text>{row().title}</Text>}</Each>
  </View>
</Scroll>
```

A scroll view creates every child, which suits pages of moderate size. For long or unbounded data use a
[list](./list.md): it creates the rows near the viewport and recycles them.

A scroll view needs a bounded size along its axis: give it `flex: 1` (`.flex_1()`) or a height inside a container that
has one. Its content is laid out at the scroll view's width (height when horizontal) and as tall (wide) as it needs.

## Props

Besides the [common props](./index.md#common-props) (with `style` typed as `ViewStyle`). In Rust, the scrolling props
are methods of the `Scrollable` trait, which lists share.

### Scrolling

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `horizontal` | `.horizontal()` | `boolean` | `false` | Scrolls sideways. |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | The user can scroll it. |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | The scroll indicator shows. On the desktop and in desktop browsers a horizontal view keeps it: it is the mouse's scroll bar. |
| `bounces` | `.bounces(..)` | `boolean` | `true` | Overscroll past the edges. |
| `pagingEnabled` | `.paging(..)` | `boolean` | `false` | Stops at multiples of the viewport. |
| `snapToInterval` | `.snap_interval(px(..))` | `number` | `0` | Stops at multiples of this length (0: off). |
| `snapToOffsets` | `.snap_offsets(..)` | `number[]` | | Stops at these offsets. |
| `snapToAlignment` | `.snap_alignment(SnapAlignment::Center)` | `"start" \| "center" \| "end"` | `"start"` | Which point of an item aligns with the viewport with `snapToInterval`. |
| `disableIntervalMomentum` | `.disable_interval_momentum(..)` | `boolean` | `false` | A fling moves one snap point at most. |
| `decelerationRate` | `.deceleration(rate)` | `"normal" \| "fast" \| number` | platform | How fast a fling slows down: the velocity kept per millisecond (`normal` 0.998, `fast` 0.99). |
| `contentInset` | `.content_inset(EdgeInsets { .. })` | `Partial<Edges>` | | Room around the content. |
| `contentOffset` | `.content_offset(point(..))` | `{ x?, y? }` | | Where it starts. |
| `contentStyle` | the content view's own styles | `ViewStyle` | | The style of a view around the children that scrolls with them; `flexGrow: 1` makes it at least as tall as the viewport (a centered empty state). |
| `contentClass` | the content view's own styles | `string` | | The same as classes, e.g. `"grow justify-center p-4"`. |
| `keyboardDismissMode` | `.keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)` | `"none" \| "on-drag" \| "interactive"` | `"none"` | Whether dragging dismisses the keyboard. |
| `keyboardShouldPersistTaps` | `.keyboard_taps(KeyboardTaps::Handled)` | `"never" \| "always" \| "handled" \| boolean` | `"never"` | Whether a tap dismisses the keyboard: `never` (the tap only dismisses it), `always` (it stays up), `handled` (it stays up when something handles the tap). |
| `scrollValue` | `.scroll_value(&value)` | `AnimatedValue` | | An animated value fed with the scroll offset (main axis), for scroll-linked animations. |
| `scrollEventThrottle` | `.event_throttle(ms)` | `number` | | Minimum milliseconds between `onScroll` events (at most one per frame anyway). |

### Pull to refresh

| Prop | Rust | Type | Description |
|---|---|---|---|
| `refreshing` | `.refreshing(..)` | `boolean` | The refresh spinner shows. |
| `onRefresh` | `.on_refresh(..)` | `() => void` | The user pulled to refresh: start loading and set `refreshing` until it ends. |
| `refreshIndicator` | `.refresh_indicator(Some(height))` | `{ height: number }` | The app draws its own indicator, `height` points tall: the platform's spinner is hidden, a pull refreshes once it reaches `height`, and refreshing keeps `height` above the content. A height of 0 or less is none. |
| `pullValue` | `.pull_value(&value)` | `AnimatedValue` | An animated value fed with how far the view is pulled past its top (0 at rest, growing with the pull; the room kept above the content while it refreshes: `height` with `refreshIndicator`), for the app's indicator. |

```rust tabs
let refreshing = signal(false);

scroll()
    .flex_1()
    .refreshing(refreshing)
    .on_refresh(move || {
        refreshing.set(true);
        spawn(async move {
            load().await;
            refreshing.set(false);
        });
    })
    .child(content())
```

```tsx tabs
const refreshing = signal(false);
async function reload() {
  refreshing.set(true);
  await load();
  refreshing.set(false);
}

<Scroll style={{ flex: 1 }} refreshing={refreshing()} onRefresh={reload}>
  …
</Scroll>;
```

### Zooming

Setting `maximumZoomScale` above `minimumZoomScale` (`.zoom_range(min, max)` in Rust) makes the content zoomable with a
pinch; zoomed in, it scrolls both ways. Lists keep their scale.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `minimumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | The smallest zoom. |
| `maximumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | The largest zoom. |
| `zoomScale` | `.zoom(..)` | `number` | | Zooms to this scale when it changes; otherwise the user's zoom is kept. |
| `bouncesZoom` | `.bounces_zoom(..)` | `boolean` | `true` | Pinching may go past the limits and springs back. |
| `zoomable` | `.zoomable(..)` | `boolean` | `true` | The user can pinch to zoom. |
| `centerContent` | `.center_content(..)` | `boolean` | `false` | Content smaller than the viewport (zoomed out) is centered. |

```rust tabs
let photo = element_ref();

scroll()
    .element_ref(&photo)
    .zoom_range(1.0, 4.0)
    .center_content(true)
    .flex_1()
    .bg(black())
    .child(
        image(PICTURE)
            .w(px(390.0))
            .h(px(520.0))
            .on_press(move || photo.zoom_to(1.0, None, true)),
    )
```

```tsx tabs
let photo!: YNode;
<Scroll ref={photo} maximumZoomScale={4} centerContent style={{ flex: 1, backgroundColor: "#000" }}>
  <Image src={picture} style={{ width: 390, height: 520 }} onPress={() => photo.zoomTo({ scale: 1, animated: true })} />
</Scroll>;
```

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onScroll` | `.on_scroll` | `ScrollEvent` | The offset changed (at most once per frame, and no more often than `scrollEventThrottle`). |
| `onScrollDragStart` / `onScrollDragEnd` | `.on_scroll_drag_start` / `.on_scroll_drag_end` | `{ x, y }` (`Point<Points>`) | The user started / stopped dragging. |
| `onMomentumStart` / `onMomentumEnd` | `.on_momentum_start` / `.on_momentum_end` | `{ x, y }` | A glide after the drag started / stopped. A glide caught by a new drag still ends with `onMomentumEnd`. |
| `onScrollEnd` | `.on_scroll_end` | `{ x, y }` | Scrolling came to rest. |
| `onRefresh` | `.on_refresh` | none | Pulled to refresh. |

`ScrollEvent` is `{ offset: Point; contentSize: Size; size: Size; zoomScale }` (in Rust `offset`, `content_size`,
`size`, `zoom_scale`): the offset, the (zoomed) content size, the viewport size and the zoom scale (1 unless the view
zooms).

> [!TIP]
> To move something with the scroll position (a shrinking header, a parallax image), bind `scrollValue` to a native
> value and interpolate it in a style. It runs on the UI thread at the display's rate, while `onScroll` is an event per
> frame in the app's code. See [animation](../docs/animation.md).

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point(x, y), animated)` | Scrolls to an offset. |
| `zoomTo({ scale, x?, y?, animated? })` | `zoom_to(scale, Some(point(x, y)), animated)` | Zooms to `scale` (clamped to the limits) with the content point (`x`, `y`, unzoomed points) in the middle of the viewport, or around the middle. E.g. a double tap zooming in on the tapped point. |

```rust tabs
let scroller = element_ref();
scroll().element_ref(&scroller).child(content());

scroller.scroll_to(point(px(0.0), px(0.0)), true);
```

```tsx tabs
let scroller!: YNode;
<Scroll ref={scroller}>…</Scroll>;
scroller.scrollTo({ y: 0, animated: true });
```

## Keyboard

Inputs inside a scroll view are kept clear of the keyboard natively: the scroll view gets a bottom inset and scrolls to
the focused input on its own. For content outside scroll views use [`env(keyboard-inset-height)`](./keyboard.md)
in a bottom padding or margin. See [forms and the keyboard](../docs/forms-and-keyboard.md).

## Right to left

Horizontal scroll views start at the right end in right-to-left layouts and keep their distance from it as the content
changes; their children are mirrored.

## Platform notes

- Android: pull to refresh is drawn by NSH (overscroll stays native), `contentInset` is applied as padding, and
  `decelerationRate` shapes snapping glides.
- Android zooms with NSH's own scroll view, which scales the content around its top left and scrolls both ways.
  Pinches start after Android's minimum span between the fingers (about 27 mm).
- On Mac Catalyst (Mac idiom), NSH detects the pull and shows its spinner.
- iOS redraws texts and canvases at the zoomed resolution when a zoom ends.
