---
title: Scrolling
description: Scroll views in Rust and TSX - paging and snapping, zooming, pull to refresh, scroll events, scroll-linked effects with scrollValue, the keyboard in scroll views, and scrolling from code.
order: 39
group: ui
demo: guide-scrolling
---

# Scrolling

The scroll view (`scroll()` in Rust, `<Scroll>` in TSX) is the platform's own scroll view (UIScrollView on iOS, a ScrollView on Android): flings, bounces, the scroll indicator and pull to refresh are native, and so is snapping. Your code hears about scrolling through events and can bind the offset to an [animated value](./animation.md#animated-values) for effects that follow the finger frame by frame.

Use a scroll view for content of a known, moderate size: a settings page, a form, an article, a row of chips. For long or unbounded data use a [list](./lists.md), which recycles rows and accepts the same scrolling props.

## A scroll view

A scroll view is the viewport; its children are the content. The viewport needs a size from its parent (usually `flex: 1`, `.flex_1()`), and the content is laid out at the viewport's width (vertical) or height (horizontal) and as long as it needs to be.

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    scroll().flex_1().bg(rgb(0xf6f8fa)).child(
        view().p_4().gap_3().children((1..=50).map(|n| {
            view().p_4().rounded(px(10.0)).bg(white()).child(text(format!("Row {n}")))
        })),
    )
}
```

```tsx tabs
import { mount, Scroll, Text, View } from "nsh";

function App() {
  return (
    <Scroll style={{ flex: 1, backgroundColor: "#f6f8fa" }}>
      <View style={{ padding: 16, gap: 12 }}>
        <Each of={Array.from({ length: 50 }, (_, i) => i + 1)}>
          {(n) => (
            <View style={{ padding: 16, borderRadius: 10, backgroundColor: "#ffffff" }}>
              <Text>Row {n()}</Text>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}

mount(App);
```

The child view above is the scroll view's content container; in TSX, `contentStyle` (or `contentClass`) makes one for you, wrapping the children in a view with that style, which scrolls with them. `flexGrow: 1` (`.flex_grow(1.0)`) makes the content at least as tall as the viewport, so a short content can be centered and a long one still scrolls:

```rust tabs
scroll().flex_1().child(
    view().flex_grow(1.0).justify_center().p_4().child(
        when(move || messages.with(|m| !m.is_empty()), move || {
            each(messages, |m| m.id, |m, _| text(move || m.with(|m| m.text.clone())))
        })
        .otherwise(|| text("No messages yet")),
    ),
)
```

```tsx tabs
<Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", padding: 16 }}>
  <If when={messages().length > 0} else={<Text>No messages yet</Text>}>
    <Each of={messages()}>{(m) => <Text>{m().text}</Text>}</Each>
  </If>
</Scroll>
```

A horizontal scroll view takes `horizontal` (`.horizontal()`) and a row as its child:

```rust tabs
scroll().horizontal().scrollbar(false).child(
    view().flex_row().gap_2().px_4().children(["Today", "This week", "This month", "This year"].map(|label| {
        text(label).px(px(14.0)).py_2().rounded(px(16.0)).overflow_hidden().bg(white())
    })),
)
```

```tsx tabs
<Scroll horizontal scrollbar={false}>
  <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16 }}>
    <Each of={["Today", "This week", "This month", "This year"]}>
      {(label) => <Text style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, overflow: "hidden", backgroundColor: "#ffffff" }}>{label()}</Text>}
    </Each>
  </View>
</Scroll>
```

Right to left (see [Device and environment](./device-and-environment.md#right-to-left)), a horizontal scroll view starts at its right end and keeps its distance from it.

Fingers drag scroll views. On the desktop (macOS, Windows, Linux) and in the browser, the mouse scrolls as in desktop apps: with its wheel (Shift + wheel scrolls horizontally), the touchpad, the keyboard and the scroll indicator, which shows while the mouse moves over the view and drags as a scroll bar; mouse drags go to the app's pans, responders and text selection. Touchscreens on desktops drag scroll views as fingers do. Horizontal views keep their indicator there even with `scrollbar={false}`, since it is how a mouse without a horizontal wheel moves them.

### Behavior props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `horizontal` | `.horizontal()` | `boolean` | `false` | Scrolls sideways. |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | The user can scroll it. Scrolling from code still works. |
| `bounces` | `.bounces(..)` | `boolean` | `true` | Overscroll past the edges. |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | The scroll indicator shows. On the desktop and in desktop browsers a horizontal view keeps it: it is the mouse's scroll bar. |
| `contentInset` | `.content_inset(EdgeInsets { .. })` | `Partial<Edges>` | | Room around the content, scrollable into. |
| `contentOffset` | `.content_offset(point(..))` | `{ x?, y? }` | | Where it starts. |
| `decelerationRate` | `.deceleration(rate)` | `"normal" \| "fast" \| number` | the platform's | How fast a fling slows down: `"normal"`, `"fast"`, or the velocity kept per millisecond (`0.998` is normal, `0.99` fast; `0` is the platform's default). |

## Paging and snapping

Snapping is decided natively when the finger lifts, from the release offset, the projected glide and the velocity; the scroll view then glides to the chosen stop, with none of your code involved.

| Prop | Rust | Type | Description |
|---|---|---|---|
| `pagingEnabled` | `.paging(true)` | `boolean` | Stops at multiples of the viewport's size. |
| `snapToInterval` | `.snap_interval(px(..))` | `number` | Stops at multiples of this length (0: off). |
| `snapToOffsets` | `.snap_offsets(vec![..])` | `number[]` | Stops at these offsets. |
| `snapToAlignment` | `.snap_alignment(SnapAlignment::Center)` | `"start" \| "center" \| "end"` | With `snapToInterval`: which point of an item aligns with the viewport. |
| `disableIntervalMomentum` | `.disable_interval_momentum(true)` | `boolean` | A fling moves one stop at most. |

A pager: pages as wide as the scroll view, and an indicator updated when the glide ends.

```rust tabs
const COLORS: [u32; 4] = [0x0969da, 0x8250df, 0xbf3989, 0x1a7f37];

pub fn pager() -> impl IntoElement {
    let width = signal(0.0_f32);
    let page = signal(0_usize);
    let settle = move |e: &Point<Points>| {
        let width = width.get_untracked();
        if width > 0.0 {
            page.set((e.x.0 / width).round() as usize);
        }
    };
    let pages = COLORS.iter().enumerate().map(|(i, &color)| {
        view()
            .w(move || px(width.get()))
            .h(px(160.0))
            .bg(rgb(color))
            .items_center()
            .justify_center()
            .child(text(format!("Page {}", i + 1)).text_color(white()).text_2xl().font_weight(FontWeight::BOLD))
    });
    let dots = (0..COLORS.len()).map(|i| {
        view()
            .size_2()
            .rounded(px(4.0))
            .bg(move || if page.get() == i { rgb(0x0969da) } else { rgb(0xd0d7de) })
    });
    view()
        .gap_2()
        .p_4()
        .child(
            scroll()
                .horizontal()
                .paging(true)
                .scrollbar(false)
                .h(px(160.0))
                .rounded(px(12.0))
                .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
                .on_scroll_end(settle)
                .child(view().flex_row().children(pages)),
        )
        .child(view().flex_row().justify_center().gap(px(6.0)).children(dots))
}
```

```tsx tabs
import { mount, Scroll, signal, Text, View } from "nsh";

const colors = ["#0969da", "#8250df", "#bf3989", "#1a7f37"];

function Pager() {
  const width = signal(0);
  const page = signal(0);
  const settle = (e: { x: number }) => page.set(Math.round(e.x / width()));
  return (
    <View style={{ gap: 8, padding: 16 }}>
      <Scroll
        horizontal
        pagingEnabled
        scrollbar={false}
        style={{ height: 160, borderRadius: 12 }}
        onLayout={(e) => width.set(e.size.width)}
        onScrollEnd={settle}
      >
        <View style={{ flexDirection: "row" }}>
          <Each of={colors}>
            {(color, i) => (
              <View style={{ width: width(), height: 160, backgroundColor: color(), alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "#ffffff", fontSize: 24, fontWeight: "700" }}>Page {i() + 1}</Text>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
        <Each of={colors}>
          {(_, i) => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: page() === i() ? "#0969da" : "#d0d7de" }} />}
        </Each>
      </View>
    </View>
  );
}

mount(Pager);
```

A carousel of cards that snap to the center, one card per fling:

```rust tabs
scroll()
    .horizontal()
    .snap_interval(px(232.0))          // card width (220) + gap (12)
    .snap_alignment(SnapAlignment::Center)
    .deceleration(0.99)
    .disable_interval_momentum(true)
    .scrollbar(false)
    .child(view().flex_row().gap_3().px_4().children(cards))
```

```tsx tabs
<Scroll
  horizontal
  snapToInterval={232}          // card width (220) + gap (12)
  snapToAlignment="center"
  decelerationRate="fast"
  disableIntervalMomentum
  scrollbar={false}
>
  <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 16 }}>…</View>
</Scroll>
```

Lists take the same snapping props, which makes them the better choice for a long carousel.

## Scroll events

| Prop | Rust | Payload | When |
|---|---|---|---|
| `onScroll` | `.on_scroll(..)` | `ScrollEvent` | The offset changed. At most once per frame; `scrollEventThrottle` spaces them further. |
| `scrollEventThrottle` | `.event_throttle(ms)` | `number` | Minimum milliseconds between `onScroll` events. |
| `onScrollDragStart` | `.on_scroll_drag_start(..)` | `{ x, y }` | The user started dragging. |
| `onScrollDragEnd` | `.on_scroll_drag_end(..)` | `{ x, y }` | The user lifted the finger. |
| `onMomentumStart` | `.on_momentum_start(..)` | `{ x, y }` | The glide after a fling started. |
| `onMomentumEnd` | `.on_momentum_end(..)` | `{ x, y }` | The glide ended (also when a new drag catches it). |
| `onScrollEnd` | `.on_scroll_end(..)` | `{ x, y }` | A user scroll came to rest: after the glide, or at the end of a drag without one. |

`ScrollEvent` carries the offset (`offset`, a `Point`; the same in Rust), the content's size, zoomed (`contentSize`, a `Size`; `content_size`), the viewport (`size`) and `zoomScale` (`zoom_scale`). The other events carry the offset (a `Point<Points>` in Rust).

```rust tabs
let at_bottom = signal(false);

scroll()
    .flex_1()
    .event_throttle(100.0)
    .on_scroll(move |e: &ScrollEvent| {
        at_bottom.set(e.offset.y + e.size.height >= e.content_size.height - px(20.0))
    })
    .child(content)
```

```tsx tabs
const atBottom = signal(false);

<Scroll
  style={{ flex: 1 }}
  scrollEventThrottle={100}
  onScroll={(e) => atBottom.set(e.offset.y + e.size.height >= e.contentSize.height - 20)}
>
  …
</Scroll>
```

> [!TIP]
> `onScroll` runs your code on every frame of a scroll (subject to the throttle). For something that only has to *look* scroll-linked, such as a header that fades or a parallax image, use [`scrollValue`](#scroll-linked-effects-scrollvalue) instead: it runs entirely natively.

## Scroll-linked effects: scrollValue

`scrollValue` (`.scroll_value(&value)`) takes an [animated value](./animation.md#animated-values) and writes the scroll offset (along the main axis) into it natively, in the same frame the content moves. Bind that value, or nodes derived from it with `interpolate`, `diffClamp` (`diff_clamp`) or arithmetic, to styles.

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let offset = animated_value(0.0);
    view()
        .flex_1()
        .child(
            view()
                .h(px(56.0))
                .justify_center()
                .px_4()
                // Transparent at the top, white after 80 points.
                .bind_background(&offset.interpolate_colors(&[0.0, 80.0], &[rgba(0xffffff00), rgba(0xffffffff)]))
                .child(
                    text("Inbox")
                        .text_size(px(22.0))
                        .font_weight(FontWeight::BOLD)
                        .origin_left()
                        .bind_scale(&offset.interpolate(&[0.0, 80.0], &[1.0, 0.8])),
                ),
        )
        .child(scroll().flex_1().scroll_value(&offset).child(view().p_4().gap_2()))
}
```

```tsx tabs
import { mount, Scroll, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const offset = createAnimatedValue(0);
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          height: 56,
          justifyContent: "center",
          paddingHorizontal: 16,
          // Transparent at the top, white after 80 points.
          backgroundColor: offset.interpolate({ inputRange: [0, 80], outputRange: ["rgba(255,255,255,0)", "#ffffff"] }),
        }}
      >
        <Text
          style={{
            fontSize: 22,
            fontWeight: "700",
            transformOrigin: "left center",
            transform: [{ scale: offset.interpolate({ inputRange: [0, 80], outputRange: [1, 0.8] }) }],
          }}
        >
          Inbox
        </Text>
      </View>
      <Scroll style={{ flex: 1 }} scrollValue={offset}>
        <View style={{ padding: 16, gap: 8 }}>…</View>
      </Scroll>
    </View>
  );
}

mount(App);
```

A header that slides away while the content scrolls up and comes back as soon as it scrolls down is `diffClamp` of the offset:

```rust tabs
let offset = animated_value(0.0);
let header = offset.diff_clamp(0.0, 56.0);

view()
    .flex_1()
    .child(scroll().flex_1().scroll_value(&offset).child(view().pt(px(56.0))))
    .child(view().absolute().top_0().left_0().right_0().h(px(56.0)).bind_translate_y(&header.mul(-1.0)))
```

```tsx tabs
const offset = createAnimatedValue(0);
const header = offset.diffClamp(0, 56);

<View style={{ flex: 1 }}>
  <Scroll style={{ flex: 1 }} scrollValue={offset}>
    <View style={{ paddingTop: 56 }}>…</View>
  </Scroll>
  <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 56, transform: [{ translateY: header.mul(-1) }] }}>…</View>
</View>
```

Interpolations clamp outside their input range by default, so pulling past the top (a negative offset) keeps the effect at its end; pass `extrapolate: "extend"` (`interpolate_with(.., Interpolation::extrapolate(Extrapolate::Extend))` in Rust) for a stretchy header that grows as you pull.

## Pull to refresh

`refreshing` and `onRefresh` (`.refreshing(..)` and `.on_refresh(..)`) add the platform's pull-to-refresh control. The control shows while `refreshing` is true; set it in `onRefresh` and clear it when the work is done.

```rust tabs
let refreshing = signal(false);
let reload = move || {
    refreshing.set(true);
    spawn(async move {
        if let Ok(response) = fetch("https://api.example.com/items").await {
            items.set(parse_items(&response.text()));
        }
        refreshing.set(false);
    });
};

scroll().flex_1().refreshing(refreshing).on_refresh(reload).child(content)
```

```tsx tabs
const refreshing = signal(false);
const reload = async () => {
  refreshing.set(true);
  try {
    items.set(await (await fetch("https://api.example.com/items")).json());
  } finally {
    refreshing.set(false);
  }
};

<Scroll style={{ flex: 1 }} refreshing={refreshing()} onRefresh={reload}>…</Scroll>
```

On iOS the control is UIRefreshControl; in the Mac idiom of Mac Catalyst, NSH shows its own spinner with the same behavior. Lists take the same props. On the desktop and in the browser the pull is a touchscreen's (or a macOS trackpad's, which pulls past the top) gesture, since the mouse scrolls without dragging; offer another way to refresh there, such as a button or a keyboard shortcut.

### An indicator of your own

The look of the pull is the app's to choose. `refreshIndicator={{ height }}` says the app draws its own indicator, `height` points tall: the platform's spinner is hidden, a pull refreshes once it reaches `height`, and refreshing keeps `height` above the content for the indicator. `pullValue` feeds an animated value with how far the content is pulled past the top: 0 at rest, growing with the pull, and `height` while it refreshes. Draw the indicator over the top of the scroll view and interpolate its styles from the value: they follow the finger on the UI thread, with no JS per frame.

```rust tabs
let pull = animated_value(0.0);

view()
    .flex_1()
    .child(
        scroll()
            .flex_1()
            .refreshing(refreshing)
            .on_refresh(reload)
            .pull_value(&pull)
            .refresh_indicator(Some(px(72.0)))
            .child(content),
    )
    .child(
        view()
            .pointer_events(PointerEvents::None)
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(72.0))
            .items_center()
            .justify_center()
            .bind_opacity(&pull.interpolate(&[0.0, 36.0], &[0.0, 1.0]))
            .bind_rotate(&pull.interpolate(&[36.0, 72.0], &[0.0, 180.0]))
            .child(arrow()),
    )
```

```tsx tabs
const pull = createAnimatedValue(0);

<View style={{ flex: 1 }}>
  <Scroll
    style={{ flex: 1 }}
    refreshing={refreshing()}
    onRefresh={reload}
    pullValue={pull}
    refreshIndicator={{ height: 72 }}
  >
    …
  </Scroll>
  <View
    pointerEvents="none"
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 72,
      alignItems: "center",
      justifyContent: "center",
      opacity: pull.interpolate({ inputRange: [0, 36], outputRange: [0, 1] }),
      transform: [{ rotate: pull.interpolate({ inputRange: [36, 72], outputRange: ["0deg", "180deg"] }) }],
    }}
  >
    <Arrow />
  </View>
</View>;
```

Keep `height` within half the viewport: past the top the content resists the finger more the further it goes, and a height too far is never reached. On iOS, an indicator of the app's own replaces UIRefreshControl with the pull NSH detects itself, as in the Mac idiom.

## Zooming

A scroll view (lists keep a scale of 1) zooms when its maximum zoom scale is above its minimum: pinching scales the content, and while zoomed in it scrolls both ways.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `minimumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | The smallest zoom. |
| `maximumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | The largest zoom; above the minimum, pinching zooms. |
| `zoomScale` | `.zoom(scale)` | `number` | | Zooms to this scale when the prop changes; the user's zoom is kept otherwise. |
| `bouncesZoom` | `.bounces_zoom(..)` | `boolean` | `true` | Pinching may go past the limits and springs back. |
| `zoomable` | `.zoomable(..)` | `boolean` | `true` | The user can pinch to zoom. |
| `centerContent` | `.center_content(..)` | `boolean` | `false` | Content smaller than the viewport (zoomed out) is centered. |

The scroll event reports the zoom scale and the zoomed content size. From code, `zoom_to(scale, center, animated)` / `zoomTo({ scale, x, y, animated })` zooms so that the content point (in unzoomed points) lands in the middle of the viewport; double tap to zoom is a press handler calling it:

```rust tabs
pub fn photo() -> impl IntoElement {
    let photo = element_ref();
    let scale = signal(1.0_f32);
    scroll()
        .flex_1()
        .bg(black())
        .zoom_range(1.0, 4.0)
        .center_content(true)
        .on_scroll(move |e: &ScrollEvent| scale.set(e.zoom_scale))
        .element_ref(&photo)
        .child(
            image("https://picsum.photos/id/1015/1200/800")
                .w(px(390.0))
                .h(px(260.0))
                .on_press(move || photo.zoom_to(if scale.get_untracked() > 1.5 { 1.0 } else { 3.0 }, None, true)),
        )
}
```

```tsx tabs
import { Image, mount, Scroll, signal, type YNode } from "nsh";

function Photo() {
  let scroll!: YNode;
  const scale = signal(1);
  return (
    <Scroll
      ref={scroll}
      style={{ flex: 1, backgroundColor: "#000000" }}
      minimumZoomScale={1}
      maximumZoomScale={4}
      centerContent
      onScroll={(e) => scale.set(e.zoomScale)}
    >
      <Image
        src="https://picsum.photos/id/1015/1200/800"
        style={{ width: 390, height: 260 }}
        onPress={() => scroll.zoomTo({ scale: scale() > 1.5 ? 1 : 3 })}
      />
    </Scroll>
  );
}

mount(Photo);
```

Text and canvases inside a zoomed scroll view are drawn again at the new resolution when the zoom ends, so they stay sharp on iOS. On Android, NSH zooms with a scroll view of its own, which scales around the pinch's focal point, pans with any number of fingers, flings and rubber-bands at the edges and zoom limits. Android starts a pinch once the fingers are about 27 mm apart, as the system's gesture detector does.

## Scrolling from code

Give the scroll view a ref (`element_ref()` and `.element_ref(&scroller)` in Rust, a [`ref`](./jsx-and-components.md) in TSX) and call its methods. Commands run after the rest of the changes in the same update, so scrolling to content you just added works.

| Rust | TSX | Description |
|---|---|---|
| `scroll_to(point, animated)` | `scrollTo({ x?, y?, animated? })` | Scrolls to an offset. Animated by default in TSX. |
| `zoom_to(scale, center, animated)` | `zoomTo({ scale, x?, y?, animated? })` | Zoomable scroll views: zooms to `scale` (clamped to the limits), around the content point or the middle. |

```rust tabs
let scroller = element_ref();

scroll().flex_1().element_ref(&scroller).child(content)
view().on_press(move || scroller.scroll_to(point(px(0.0), px(0.0)), true))
```

```tsx tabs
let scroll!: YNode;

<Scroll ref={scroll} style={{ flex: 1 }}>…</Scroll>
<View onPress={() => scroll.scrollTo({ y: 0 })}>…</View>
```

Lists add `scrollToIndex`, `scrollToOffset` and `scrollToEnd`; see [Lists](./lists.md#scrolling-from-code).

## Scroll views and the keyboard

NSH keeps a focused input visible on its own: when the keyboard shows, the scroll view around the input gets a bottom inset as tall as the keyboard and scrolls the input into view. This happens natively, with no code in your app. Use `env(keyboard-inset-height)` as a bottom padding ([Content outside scroll views](./forms-and-keyboard.md#content-outside-scroll-views)) for content outside scroll views, such as a message bar pinned to the bottom.

Two props decide how scrolling and taps interact with the keyboard:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `keyboardDismissMode` | `.keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)` | `"none" \| "on-drag" \| "interactive"` | `"none"` | Whether dragging the content hides the keyboard. `"interactive"` lets the keyboard follow the finger down on iOS; on Android it behaves like `"on-drag"`. |
| `keyboardShouldPersistTaps` | `.keyboard_taps(KeyboardTaps::Handled)` | `"never" \| "always" \| "handled"` | `"never"` | What a tap does while the keyboard is up. |

`keyboardShouldPersistTaps`:

- `"never"`: a tap outside the focused input only hides the keyboard, and buttons get the next tap. The user taps once to dismiss, again to press.
- `"handled"`: a tap on something that handles it (a button) goes through and the keyboard stays; a tap on empty space hides it. Usually the right choice for forms.
- `"always"`: the keyboard stays up through every tap.

Both are decided natively when the tap or drag happens, without waiting for your code. To hide the keyboard from code, call `dismiss_keyboard()` in Rust or `Keyboard.dismiss()` from [`nsh`](../modules/nsh.md#keyboard-and-keyboardframe) in TSX.

## Nested scroll views

A horizontal scroll view inside a vertical one works as expected: each takes the drags along its own axis. Two scroll views on the same axis nest too (the inner one scrolls first). Responders that need the finger, such as a drawing canvas inside a scroll view, keep it from the scroll views around them: `.keep_touches(true)` in Rust, `true` returned from `onResponderGrant` in TSX; see [Touch and gestures](./touch-and-gestures.md#the-responder-system).

## Related

- [Scroll](../elements/scroll.md): the element reference, every prop and event.
- [Lists](./lists.md): virtualized lists with the same scrolling props.
- [Animation](./animation.md): animated values, `interpolate` and `diffClamp` for scroll-linked effects.
- [Forms and the keyboard](./forms-and-keyboard.md): inputs, focus and the keyboard.
