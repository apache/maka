---
title: Layout
description: Flexbox with a column default, CSS grid, sizes and percentages, aspect ratio, absolute positioning, measuring with onLayout, responsive layouts and right-to-left, in Rust and TSX.
order: 34
group: ui
demo: guide-layout
---

# Layout

NSH lays out every element with [Taffy](https://github.com/DioxusLabs/taffy), a Rust implementation of CSS flexbox, grid and block layout, configured so that children stack vertically and do not shrink by default. Layout runs in the core, after each turn of your code, and only the frames that changed are sent to the native views. Text is measured by the platform's text engine on the same thread, so layout never waits for the main thread.

The layout properties below are style properties. In Rust they are typed style methods (`.flex_row()`, `.gap_4()`, `.grid_cols(3)`, `.absolute().inset_0()`); in TSX they are keys of the `style` prop, and each has a [Tailwind](./tailwind.md) class (`flex-row`, `gap-4`, `grid-cols-3`, `absolute inset-0`, ...). Both lower to the same native styles.

## Flexbox

A view lays out its children with flexbox. The defaults differ from the web's:

| Property | NSH default | Web default |
|---|---|---|
| `flexDirection` | `"column"` | `row` |
| `flexShrink` | `0` | `1` |
| `alignContent` | `"flex-start"` (grids: `"normal"`) | `normal` |
| `alignItems` | `"stretch"` | `stretch` |
| `minWidth` / `minHeight` | `0` | `auto` |
| `position` | `"relative"` | `static` |

```rust tabs
view()
    .flex_row()
    .items_center()
    .gap_3()
    .p_4()
    .child(image(avatar).size(px(40.0)).rounded(px(20.0)))
    .child(
        view()
            .flex_1()
            .gap_0p5()
            .child(text(name).font_weight(FontWeight::SEMIBOLD))
            .child(text(message).text_color(rgb(0x6e7781)).number_of_lines(1)),
    )
    .child(text(time).text_color(rgb(0x6e7781)))
```

```tsx tabs
<View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
  <Image src={avatar} style={{ width: 40, height: 40, borderRadius: 20 }} />
  <View style={{ flex: 1, gap: 2 }}>
    <Text style={{ fontWeight: "600" }}>{props.name}</Text>
    <Text style={{ color: "#6e7781" }} numberOfLines={1}>{props.message}</Text>
  </View>
  <Text style={{ color: "#6e7781" }}>{props.time}</Text>
</View>
```

| Property | Values | Rust |
|---|---|---|
| `flexDirection` | `"column"`, `"row"`, `"column-reverse"`, `"row-reverse"` | `.flex_col()`, `.flex_row()`, `.flex_col_reverse()`, `.flex_row_reverse()` |
| `justifyContent` | Main axis: `"flex-start"`, `"flex-end"`, `"start"`, `"end"`, `"center"`, `"space-between"`, `"space-around"`, `"space-evenly"`, `"stretch"` | `.justify_start()`, `.justify_center()`, `.justify_end()`, `.justify_between()`, `.justify_around()`, `.justify_evenly()` |
| `alignItems` | Cross axis: `"stretch"`, `"flex-start"`, `"flex-end"`, `"start"`, `"end"`, `"self-start"`, `"self-end"`, `"center"`, `"baseline"` | `.items_stretch()`, `.items_start()`, `.items_center()`, `.items_end()`, `.items_baseline()` |
| `alignSelf` | One child's cross-axis alignment; `"auto"` follows the parent's `alignItems` | `.self_start()`, `.self_center()`, `.self_end()`, `.self_stretch()` |
| `alignContent` | Lines of a wrapping container | |
| `flexWrap` | `"nowrap"`, `"wrap"`, `"wrap-reverse"` | `.flex_wrap()` |
| `flex` | A single-number shorthand (below) | `.flex_1()`, `.flex_auto()`, `.flex_none()` |
| `flexGrow`, `flexShrink`, `flexBasis` | As in CSS | `.flex_grow(n)`, `.flex_shrink(n)`, `.flex_shrink_0()`, `.basis(length)` |
| `gap`, `rowGap`, `columnGap` | Space between children | `.gap(length)`, `.gap_y(length)`, `.gap_x(length)`, and the steps `.gap_2()`, `.gap_x_4()`, ... |

`flex-start` and `flex-end` follow the flex direction; `start` and `end` follow the writing direction, as in CSS (right to left, `start` is the right side), and `self-start` / `self-end` the child's own.

`flex` takes one number and is not the CSS shorthand: a positive number `n` means grow by `n`, shrink by 1 and start from a basis of 0, so `flex: 1` siblings (`.flex_1()` in Rust) share the space equally whatever their content; `flex: 0` (the default) sizes the view to its content; a negative number shrinks it by that much down to its minimum.

```rust tabs
view()
    .flex_row()
    .gap_2()
    // One share.
    .child(view().flex_1().h(px(36.0)).bg(rgb(0xc8e1ff)))
    // Two shares.
    .child(view().flex_grow(2.0).flex_shrink(1.0).basis(px(0.0)).h(px(36.0)).bg(rgb(0x79b8ff)))
    // Fixed.
    .child(view().size(px(36.0)).bg(rgb(0x0366d6)))
```

```tsx tabs
<View style={{ flexDirection: "row", gap: 8 }}>
  <View style={{ flex: 1, height: 36, backgroundColor: "#c8e1ff" }} />   {/* one share */}
  <View style={{ flex: 2, height: 36, backgroundColor: "#79b8ff" }} />   {/* two shares */}
  <View style={{ width: 36, height: 36, backgroundColor: "#0366d6" }} /> {/* fixed */}
</View>
```

Because minimum sizes default to 0, a `flex: 1` text in a row shrinks and wraps instead of pushing its siblings out.

> [!NOTE]
> `display: "flex"` in a style keeps the column default. Only Tailwind's `flex` class means a row, as in CSS ([Tailwind](./tailwind.md#what-differs-from-tailwind-on-the-web)); in Rust, `.flex_row()` sets the direction.

## Sizes

| Property | Values | Rust |
|---|---|---|
| `width`, `height` | Points, a percentage of the parent (`"50%"`), or `"auto"` | `.w(px(120.0))`, `.h(relative(0.5))`, `.w_full()`, `.size(px(44.0))`, the steps `.w_10()`, ... |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | Points or percentages | `.min_w(..)`, `.max_w(..)`, `.min_h(..)`, `.max_h(..)` |
| `aspectRatio` | Width divided by height: `1`, `16 / 9` | `.aspect_ratio(16.0 / 9.0)`, `.aspect_square()` |
| `padding`, `paddingHorizontal`, `paddingVertical`, `paddingTop`, ... | Points or percentages | `.p(..)`, `.px(..)`, `.py(..)`, `.pt(..)`, ..., and the steps `.p_4()`, `.px_2()`, ... |
| `margin`, `marginHorizontal`, `marginVertical`, `marginTop`, ... | Points, percentages, or `"auto"` | `.m(..)`, `.mx(..)`, `.my(..)`, `.mt(..)`, ..., `.mx(auto())` |

In Rust a length is typed: `px(16.0)` is 16 points, `relative(0.5)` is 50% of the parent, `auto()` is `auto`. The step methods follow Tailwind's spacing scale of 4 points per step (`.p_4()` is 16 points, `.gap_0p5()` 2 points).

Without a size, a view is as big as its content (plus padding), stretched across its parent's cross axis by the default `alignItems: "stretch"`. Percentages are relative to the parent's size (for padding and margin, as in CSS, to its width).

`aspectRatio` sizes the other dimension from the one that is known:

```rust tabs
view().w_full().aspect_ratio(16.0 / 9.0).bg(black())
```

```tsx tabs
<View style={{ width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000000" }} />
```

Images from the app's assets have a natural size and lay out at it when no size is given ([Images and assets](./images-and-assets.md)). Remote images have no size until they load: give them one.

## Grid

`display: "grid"` (`.grid()` in Rust) lays out children in CSS grid tracks:

```rust tabs
view()
    .grid()
    .grid_template_columns("repeat(3, 1fr)")
    .gap_2()
    .child(view().col_span(2).h(px(60.0)).bg(rgb(0xd8b9ff)))
    .child(view().h(px(60.0)).bg(rgb(0xb083f0)))
    .child(view().row_span(2).bg(rgb(0x8250df)))
    .child(view().col_start(2).col_end(4).h(px(60.0)).bg(rgb(0x6639ba)))
```

```tsx tabs
<View style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
  <View style={{ gridColumn: "span 2", height: 60, backgroundColor: "#d8b9ff" }} />
  <View style={{ height: 60, backgroundColor: "#b083f0" }} />
  <View style={{ gridRow: "span 2", backgroundColor: "#8250df" }} />
  <View style={{ gridColumn: "2 / 4", height: 60, backgroundColor: "#6639ba" }} />
</View>
```

| Property | Values | Rust |
|---|---|---|
| `gridTemplateColumns`, `gridTemplateRows` | CSS track lists: `"repeat(3, 1fr)"`, `"200px 1fr"`, `minmax()`, `auto-fill` / `auto-fit`, line names | `.grid_cols(3)`, `.grid_rows(2)`, `.grid_template_columns("200px 1fr")`, `.grid_template_rows(..)` |
| `gridAutoColumns`, `gridAutoRows` | Tracks of implicitly created columns and rows | |
| `gridAutoFlow` | `"row"`, `"column"`, `"dense"`, `"row dense"`, `"column dense"` | `.grid_flow_col()`, `.grid_flow_dense()` |
| `gridColumn`, `gridRow` | `"1 / 3"`, `"span 2"`, a line number or name: `"content-start / content-end"`, `"2 col"` (the second line named `col`), `"span col"` (up to the next line named `col`) | `.col_span(2)`, `.row_span(2)`, `.col_span_full()` |
| `gridColumnStart`, `gridColumnEnd`, `gridRowStart`, `gridRowEnd` | Line numbers or names | `.col_start(1)`, `.col_end(3)`, `.row_start(..)`, `.row_end(..)` (line numbers) |
| `justifyItems`, `justifySelf` | How items sit in their areas along the row: `"start"`, `"end"`, `"center"`, `"stretch"`, ... | |
| `alignItems`, `alignSelf` | How items sit in their areas along the column | `.items_*()`, `.self_*()` |
| `justifyContent`, `alignContent` | How the tracks sit in the grid along the row and the column | `.justify_*()` |

Templates name their lines in brackets, one or several names per line, and items are placed by those names, as in CSS (in Rust, by the lines' numbers):

```rust tabs
view()
    .grid()
    .grid_template_columns("[full-start] 16px [content-start] 1fr [content-end] 16px [full-end]")
    // content-start / content-end: lines 2 to 3.
    .child(view().col_start(2).col_end(3).h(px(60.0)).bg(rgb(0xb083f0)))
    // full-start / full-end: lines 1 to 4.
    .child(view().col_start(1).col_end(4).h(px(60.0)).bg(rgb(0x8250df)))
```

```tsx tabs
<View style={{ display: "grid", gridTemplateColumns: "[full-start] 16px [content-start] 1fr [content-end] 16px [full-end]" }}>
  <View style={{ gridColumn: "content-start / content-end", height: 60, backgroundColor: "#b083f0" }} />
  <View style={{ gridColumn: "full-start / full-end", height: 60, backgroundColor: "#8250df" }} />
</View>
```

In a grid, `justifyContent` and `alignContent` default to CSS's `"normal"`: tracks sized `auto` stretch to fill the container, so a grid with a height and no row template shares that height among its rows. A value set explicitly (`"start"`, `"center"`, `"space-between"`, ...) places the tracks as it does in CSS. The alignment classes set exactly what Tailwind CSS sets: `content-start` (`align-content: flex-start`) and `place-content-start` pack the tracks at the start, and `content-normal` and `justify-normal` stretch them, as in a browser.

`display: "block"` uses CSS block layout (children stacked, each as wide as the container), and `display: "none"` (`.hidden()`) removes the view from layout.

## Absolute positioning

`position: "absolute"` (`.absolute()`) takes a view out of the flow and places it by `top`, `right`, `bottom` and `left`, relative to its parent:

```rust tabs
view()
    .h(px(200.0))
    .child(image(cover).absolute().inset_0())
    .child(
        view()
            .absolute()
            .left_3()
            .right_3()
            .bottom_3()
            .child(text("Caption").text_color(white()).font_weight(FontWeight::BOLD)),
    )
```

```tsx tabs
<View style={{ height: 200 }}>
  <Image src={cover} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
  <View style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}>
    <Text style={{ color: "#ffffff", fontWeight: "700" }}>Caption</Text>
  </View>
</View>
```

Offsets accept points and percentages (`.top(..)`, `.right(..)`, `.bottom(..)`, `.left(..)`, `.inset(..)` in Rust). A view with `left` and `right` (or `top` and `bottom`) and no size stretches between them. Later siblings are drawn above earlier ones; `zIndex` (`.z_index(n)`) changes the order.

## Measuring

`onLayout` (`.on_layout(..)`) reports a view's frame, relative to its parent, after each layout in which it changed:

```rust tabs
let width = signal(0.0_f32);

view()
    .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
    .child(text(move || format!("{} points wide", width.get())))
```

```tsx tabs
const width = signal(0);

<View onLayout={(e) => width.set(e.size.width)}>
  <Text>{width()} points wide</Text>
</View>
```

The frame is in points: `Bounds<Points>` in Rust, `Bounds` (`{ origin: { x, y }, size: { width, height } }`) in TSX. For the whole window, read `window()` in Rust or `windowSize()` from [`nsh`](../modules/nsh.md#device) in TSX; both follow rotation and window resizing, and a style that reads them changes with the window:

```rust tabs
view().style_when(|| window().width > px(600.0), |s| s.flex_row())
```

```tsx tabs
import { View } from "nsh";
import { windowSize } from "nsh";

<View style={{ flexDirection: windowSize().width > 600 ? "row" : "column" }} />
```

Tailwind's breakpoints (`sm:`, `md:`, ...) and `portrait:` / `landscape:` give the same result without code.

## Safe areas

The root view covers the whole screen, under the status bar and the home indicator. Pad screens by the safe area insets with CSS's `env()` (`paddingTop: "env(safe-area-inset-top)"`, Tailwind `pt-[env(safe-area-inset-top)]`, `.p_safe_area()` in Rust; see [Safe area](../elements/safe-area.md)), or read the insets with `safe_area()` in Rust or `safeArea()` / `safeAreaInsets()` in TSX and apply them yourself. Pages of a [navigation stack](./navigation.md) already sit below their header.

## Right to left

The app's layout direction follows the system language, and a view's `direction` style (`"ltr"`, `"rtl"` or `"inherit"`; `.direction(LayoutDirection::Rtl)` in Rust) sets the direction of its subtree. When the app lays out right to left:

- rows run from the right;
- `left` and `right` style keys (margins, paddings, positions, borders, corners) swap sides, as in React Native, while Tailwind's physical classes keep theirs, as in a browser: `pl-4`, `ml-2`, `left-0`, `border-l`, `rounded-tl-lg` and `text-left` stay on the left (`ps-4`, `ms-2`, `start-0`, `border-s`, `rounded-ss-lg` and `text-start` follow the direction);
- `start` and `end` properties always mean the leading and trailing side: `marginStart`, `marginEnd`, `paddingStart`, `paddingEnd`, `start`, `end`, `borderStartWidth`, `borderTopStartRadius`, ... (`.ms(..)`, `.me(..)`, `.ps(..)`, `.pe(..)`, `.border_s(..)`, `.rounded_ss(..)`, ... in Rust);
- text with `textAlign: "auto"` aligns right, and native controls mirror.

```rust tabs
view()
    .flex_row()
    .gap_2()
    .child(view().ms_4().rounded_ss(px(12.0)).size(px(44.0)).bg(rgb(0x54aeff)))

let rtl = signal(false);
view()
    .direction(move || if rtl.get() { LayoutDirection::Rtl } else { LayoutDirection::Ltr })
    .on_press(move |_: &()| rtl.set(!rtl.get()))
    .child(text(move || if rtl.get() { "Right to left" } else { "Left to right" }))
```

```tsx tabs
import { signal, Text, View } from "nsh";

const rtl = signal(false);

<View style={{ direction: rtl() ? "rtl" : "ltr" }}>
  <View style={{ flexDirection: "row", gap: 8 }}>
    <View style={{ marginStart: 16, borderTopStartRadius: 12, width: 44, height: 44, backgroundColor: "#54aeff" }} />
  </View>
  <View onPress={() => rtl.set(!rtl())}>
    <Text>{rtl() ? "Right to left" : "Left to right"}</Text>
  </View>
</View>
```

Changes to the direction, the language's or a view's, apply at once, without a restart. The `direction` style also keeps one view and its children in a direction of their own, for example a phone number left to right. On Android, apps that embed NSH need `android:supportsRtl="true"` in their manifest for native controls to mirror.

## Related

- [Styling](./styling.md): how styles combine.
- [Scrolling](./scrolling.md) and [Lists](./lists.md): content larger than the screen.
- [Style reference](../modules/style-reference.md): every layout property and its type.
