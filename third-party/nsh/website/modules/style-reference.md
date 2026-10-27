---
title: Style reference
description: Every style key NSH accepts, grouped by LayoutStyle, ViewStyle, TextStyle and ImageStyle, with its type and meaning.
order: 16
---

# Style reference

This page lists every key of the `style` prop, and the method of `Styled` that sets it in Rust. Rust components style elements with typed methods named after Tailwind's utilities (`.p_4()`, `.rounded(px(12.0))`, `.bg(color)`, from `nsh_core::prelude`), which lower to the same keys; TSX passes `style` objects (and classes). The Rust column names the method; a value, a signal or a closure goes to most of them, and `.style_when(…)` / `.style_with(…)` make any of them conditional. The keys and their types come from the generated declarations in `.nsh/types/nsh/types.d.ts`, so your editor checks them as you type. Layout is flexbox with a column default, numbers are points, and the CSS features are there too: grid, gradients, box shadows, filters, blend modes, outlines, transitions and keyframe animations.

For how to apply styles, combine them with classes and inherit text styles, see [Styling](../docs/styling.md). For the class syntax, see the [Tailwind reference](./tailwind-reference.md).

## The four interfaces

Each interface extends the one before it:

| Interface | Extends | Used by |
|---|---|---|
| `LayoutStyle` | | Layout of every element (flexbox, grid, sizes, spacing, position) |
| `ViewStyle` | `LayoutStyle` | `<View>`, `<Scroll>`, `<List>`, controls and every other element |
| `TextStyle` | `ViewStyle` | `<Text>` and `<Input>` (and views, whose text styles pass to the text inside them) |
| `ImageStyle` | `ViewStyle` | `<Image>` |

```rust tabs
use nsh_core::prelude::*;

fn card() -> View {
    view().p_4().rounded(px(12.0)).bg(white()).shadow([BoxShadow {
        offset_y: px(4.0),
        blur: px(12.0),
        color: rgba(0x00000014).into(),
        ..BoxShadow::default()
    }])
}

fn title(label: &str) -> Text {
    text(label.to_string()).text_size(px(17.0)).font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x111111))
}

card().child(title("Hello"))
```

```tsx tabs
import type { ViewStyle, TextStyle } from "nsh";
import { Text, View } from "nsh";

const card: ViewStyle = {
  padding: 16,
  borderRadius: 12,
  backgroundColor: "#fff",
  boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)",
};

const title: TextStyle = { fontSize: 17, fontWeight: "600", color: "#111" };

<View style={card}>
  <Text style={title}>Hello</Text>
</View>;
```

`style` also takes an array; entries merge left to right and falsy entries are skipped, so conditional styles need no spreading. In Rust, `.style_when(condition, …)` adds styles while the condition holds:

```rust tabs
card().style_when(selected, |s| s.border_color(rgb(0x2563eb)).border(px(2.0)))
```

```tsx tabs
<View style={[card, selected() && { borderColor: "#2563eb", borderWidth: 2 }]} />
```

> [!NOTE]
> The inline `style` always wins over `class`. Setting a key to `null` or `undefined` resets it to its default.

## Value types

| Type | Accepts | Rust |
|---|---|---|
| `number` | Points (density-independent). `1` is one point on iOS and one dp on Android. | `Points`: `px(16.0)` |
| `DimensionValue` | `number` (points), `` `${number}%` `` (of the parent), or `"auto"`. | `Length`: `px(…)`, `relative(0.5)`, `auto()` |
| `LengthValue` | `number` (points) or `` `${number}%` ``. No `"auto"`. | `DefiniteLength`: `px(…)`, `relative(0.5)` |
| `ColorValue` | A CSS color string: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()`, `oklch()`, `oklab()`, or a named CSS color (`black`, `white`, `transparent`, `rebeccapurple`, ...). | `Hsla` / `AdaptiveColor`: `rgb(0x2563eb)`, `hsla(…)`, theme colors (`theme().primary`) |
| `EnvValue` | An environment variable in a padding or margin: `env(name)`, `env(name, <length>)` (the length stands in for an unknown name), `calc(env(name) + <length>)` or `calc(<length> + env(name))`. The names are `safe-area-inset-top`, `-right`, `-bottom`, `-left` ([Safe area](../elements/safe-area.md)) and `keyboard-inset-height` ([Keyboard](../elements/keyboard.md)). Accepted by the physical padding and margin keys and their shorthands. | `.p_safe_area()`, `.pt_safe_area_plus(px(8.0))`, `.pb_keyboard()`, `.mb_keyboard_plus(…)`, ... |
| `AnimatedNode` | A native animated value or a node derived from it (see [`nsh`'s animation API](./nsh.md#animation)). Accepted by `backgroundColor`, `opacity` and the steps of `transform`; the value then animates on the UI thread without JS. | `AnimatedValue` / `AnimatedNode`, bound with `.bind_opacity(&v)`, `.bind_background(&v)`, `.bind_translate_x(&v)`, ... |

Strings with CSS syntax (`boxShadow`, `backgroundImage`, `filter`, `gridTemplateColumns`, ...) take lengths in `px` and bare numbers (both points), `pt` (4/3 of a point, as in CSS), or `rem` (16 points).

## LayoutStyle

Layout is computed in Rust (flexbox and CSS grid). The defaults differ from CSS's: `display: "flex"`, `flexDirection: "column"`, `flexShrink: 0`, `alignContent: "flex-start"` (grids: CSS's `"normal"`), `alignItems: "stretch"`, and no automatic minimum size. See [Layout](../docs/layout.md).

### Display and position

| Key | Type | Rust | Description |
|---|---|---|---|
| `display` | `"flex" \| "grid" \| "block" \| "flow-root" \| "none"` | `.flex()`, `.grid()`, `.hidden()` | The layout of the children. `"none"` removes the element from layout and hides it. `"block"` stacks children as CSS block layout does. Default `"flex"`. |
| `boxSizing` | `"border-box" \| "content-box"` | | Dimensions include borders and padding, or content alone. Default `"border-box"`. |
| `position` | `"relative" \| "absolute" \| "static" \| "fixed" \| "sticky"` | `.relative()`, `.absolute()` | `"absolute"` takes the element out of the flow and places it by `top` / `right` / `bottom` / `left` relative to its nearest positioned ancestor (its parent unless that is `"static"`). `"static"` stays in flow and ignores insets. `"fixed"` preserves the element type and lays out and mounts it in its surface or modal root, keeping it in place while surrounding content scrolls. `"sticky"` stays in the flow and, while its parent is in view, sticks `top` (`left` in a horizontal scroll view) from the start of the viewport of the scroll view around it, until its end meets its parent's content box's; it draws above its siblings of the same `zIndex`. Default `"relative"`. |
| `top` | `DimensionValue \| AnimatedNode` | `.top(…)`, `.inset(…)`, `.bind_sticky_top(&node)` | Offset from the parent's top edge (absolute) or from the element's own position (relative). On a sticky view, where it sticks, which an animated value moves every frame. |
| `right` | `DimensionValue` | `.right(…)` | Offset from the right edge. In right-to-left layouts it means the end edge. |
| `bottom` | `DimensionValue` | `.bottom(…)` | Offset from the bottom edge. |
| `left` | `DimensionValue \| AnimatedNode` | `.left(…)`, `.bind_sticky_left(&node)` | Offset from the left edge. In right-to-left layouts it means the start edge. On a sticky view in a horizontal scroll view, where it sticks, which an animated value moves every frame. |
| `start` | `DimensionValue` | | Left in left-to-right layouts, right in right-to-left ones. |
| `end` | `DimensionValue` | | Right in left-to-right layouts, left in right-to-left ones. |
| `zIndex` | `number` | `.z_index(z)` | Order among siblings (stable for equal values); also the native stacking order. |
| `direction` | `"inherit" \| "ltr" \| "rtl"` | | Layout direction, inherited by default. Right to left, `left` and `right` properties mean start and end. |

### Flexbox

| Key | Type | Rust | Description |
|---|---|---|---|
| `flexDirection` | `"row" \| "column" \| "row-reverse" \| "column-reverse"` | `.flex_row()`, `.flex_col()`, `.flex_row_reverse()`, `.flex_col_reverse()` | The main axis. Default `"column"`. |
| `flexWrap` | `"wrap" \| "nowrap" \| "wrap-reverse"` | `.flex_wrap()` | Whether children wrap onto several lines. Default `"nowrap"`. |
| `flex` | `number` | `.flex_1()`, `.flex_auto()`, `.flex_none()` | One number, not the CSS shorthand: a positive number sets `flexGrow` to it, `flexShrink: 1` and `flexBasis: 0`; `0` makes the element inflexible; a negative number shrinks it down to its minimum size. |
| `flexGrow` | `number` | `.flex_grow(f)` | How much of the free space the element takes. Default `0`. |
| `flexShrink` | `number` | `.flex_shrink(f)`, `.flex_shrink_0()` | How much the element shrinks when space runs out. Default `0`, not `1` as in CSS. |
| `flexBasis` | `DimensionValue` | `.basis(…)` | The main-axis size before free space is distributed. |
| `justifyContent` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "center" \| "space-between" \| "space-around" \| "space-evenly" \| "stretch" \| "normal"` | `.justify_start()`, `.justify_center()`, `.justify_end()`, `.justify_between()`, `.justify_around()`, `.justify_evenly()` | Distribution of children along the main axis. Default `"normal"`: `"flex-start"` in flex containers; in grids, tracks sized `auto` stretch. |
| `alignItems` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | `.items_start()`, `.items_center()`, `.items_end()`, `.items_stretch()`, `.items_baseline()` | Alignment of children on the cross axis. Default `"stretch"`. |
| `alignSelf` | `"auto" \| "flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | `.self_start()`, `.self_center()`, `.self_end()`, `.self_stretch()` | Overrides the parent's `alignItems` for this element. |
| `alignContent` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "center" \| "stretch" \| "space-between" \| "space-around" \| "space-evenly" \| "normal"` | | Distribution of wrapped lines (and grid tracks) on the cross axis. Default `"flex-start"` in flex containers and `"normal"` in grids, where tracks sized `auto` stretch. `"start"` / `"end"` follow the writing direction. |
| `gap` | `LengthValue` | `.gap(…)`, `.gap_4()` | Space between rows and columns of children. |
| `rowGap` | `LengthValue` | `.gap_y(…)` | Space between rows. |
| `columnGap` | `LengthValue` | `.gap_x(…)` | Space between columns. |

### Grid

Set `display: "grid"` to lay out children in a CSS grid. Track lists use CSS syntax.

| Key | Type | Rust | Description |
|---|---|---|---|
| `gridTemplateColumns` | `string` | `.grid_template_columns(…)`, `.grid_cols(n)` | Column tracks: `"repeat(3, 1fr)"`, `"200px 1fr"`, `minmax()`, `auto-fill` / `auto-fit`, line names (`"[a] 40px [b c] 1fr [d]"`). |
| `gridTemplateRows` | `string` | `.grid_template_rows(…)`, `.grid_rows(n)` | Row tracks, same syntax. |
| `gridAutoColumns` | `string` | | Size of implicitly created columns. |
| `gridAutoRows` | `string` | | Size of implicitly created rows. |
| `gridAutoFlow` | `"row" \| "column" \| "dense" \| "row dense" \| "column dense"` | `.grid_flow_col()`, `.grid_flow_dense()` | How items without a placement fill the grid. |
| `gridColumn` | `number \| string` | `.col_span(n)`, `.col_span_full()` | Column placement: `"1 / 3"`, `"span 2"`, a line number or a line name (`"content-start / content-end"`, `"2 col"`, `"span col"`). |
| `gridColumnStart` | `number \| string` | `.col_start(…)` | Start column line. |
| `gridColumnEnd` | `number \| string` | `.col_end(…)` | End column line. |
| `gridRow` | `number \| string` | `.row_span(n)`, `.row_span_full()` | Row placement, same syntax as `gridColumn`. |
| `gridRowStart` | `number \| string` | `.row_start(…)` | Start row line. |
| `gridRowEnd` | `number \| string` | `.row_end(…)` | End row line. |
| `justifyItems` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | | How grid items sit in their areas along the row. |
| `justifySelf` | `"auto" \| "flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | | Overrides `justifyItems` for this item. |

```rust tabs
view()
    .grid()
    .grid_template_columns("repeat(3, 1fr)")
    .gap_2()
    .child(view().col_span(2).h(px(60.0)).bg(rgb(0xc7d2fe)))
    .child(view().h(px(60.0)).bg(rgb(0xa5b4fc)))
```

```tsx tabs
<View style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
  <View style={{ gridColumn: "span 2", height: 60, backgroundColor: "#c7d2fe" }} />
  <View style={{ height: 60, backgroundColor: "#a5b4fc" }} />
</View>
```

### Size

| Key | Type | Rust | Description |
|---|---|---|---|
| `width` | `DimensionValue` | `.w(…)`, `.w_full()`, `.size(…)` | Width. |
| `height` | `DimensionValue` | `.h(…)`, `.h_full()` | Height. |
| `minWidth` | `LengthValue` | `.min_w(…)` | Minimum width. |
| `minHeight` | `LengthValue` | `.min_h(…)` | Minimum height. |
| `maxWidth` | `LengthValue` | `.max_w(…)` | Maximum width. |
| `maxHeight` | `LengthValue` | `.max_h(…)` | Maximum height. |
| `aspectRatio` | `number` | `.aspect_ratio(r)`, `.aspect_square()` | Width divided by height; the missing dimension is computed from the other one. |

### Margin

Margins accept `"auto"` (absorbs free space, as in flexbox) and negative values. The physical keys (all but `marginStart` / `marginEnd`) also take an `EnvValue`: `marginBottom: "env(keyboard-inset-height)"` (Rust `.mb_keyboard()`, `.mt_safe_area()`, ...).

| Key | Type | Rust | Description |
|---|---|---|---|
| `margin` | `DimensionValue \| EnvValue` | `.m(…)`, `.m_4()` | All four sides. |
| `marginHorizontal` | `DimensionValue \| EnvValue` | `.mx(…)` | Left and right. |
| `marginVertical` | `DimensionValue \| EnvValue` | `.my(…)` | Top and bottom. |
| `marginTop` | `DimensionValue \| EnvValue` | `.mt(…)` | Top. |
| `marginRight` | `DimensionValue \| EnvValue` | `.mr(…)` | Right. |
| `marginBottom` | `DimensionValue \| EnvValue` | `.mb(…)` | Bottom. |
| `marginLeft` | `DimensionValue \| EnvValue` | `.ml(…)` | Left. |
| `marginStart` | `DimensionValue` | `.ms(…)` | Left in left-to-right layouts, right in right-to-left ones. |
| `marginEnd` | `DimensionValue` | `.me(…)` | The opposite of `marginStart`. |

### Padding

The physical keys (all but `paddingStart` / `paddingEnd`) also take an `EnvValue`: `paddingTop: "env(safe-area-inset-top)"`, `paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)"` (Rust `.pt_safe_area()`, `.pb_safe_area_plus(px(16.0))`, `.pb_keyboard()`, ...). A padding is at least 0.

| Key | Type | Rust | Description |
|---|---|---|---|
| `padding` | `LengthValue \| EnvValue` | `.p(…)`, `.p_4()` | All four sides. |
| `paddingHorizontal` | `LengthValue \| EnvValue` | `.px(…)` | Left and right. |
| `paddingVertical` | `LengthValue \| EnvValue` | `.py(…)` | Top and bottom. |
| `paddingTop` | `LengthValue \| EnvValue` | `.pt(…)` | Top. |
| `paddingRight` | `LengthValue \| EnvValue` | `.pr(…)` | Right. |
| `paddingBottom` | `LengthValue \| EnvValue` | `.pb(…)` | Bottom. |
| `paddingLeft` | `LengthValue \| EnvValue` | `.pl(…)` | Left. |
| `paddingStart` | `LengthValue` | `.ps(…)` | Left in left-to-right layouts, right in right-to-left ones. |
| `paddingEnd` | `LengthValue` | `.pe(…)` | The opposite of `paddingStart`. |

## ViewStyle

Everything drawn by a view. All keys of `LayoutStyle` apply too.

### Background

| Key | Type | Rust | Description |
|---|---|---|---|
| `backgroundColor` | `ColorValue \| AnimatedNode` | `.bg(color)`, `.bind_background(&node)` | The fill color. Takes a native animated color. |
| `backgroundImage` | `string` | `.bg_linear(angle)`, `.bg_radial()`, `.bg_conic()` with `.gradient_from` / `_via` / `_to` | CSS gradients drawn over the background color: `linear-gradient(...)`, `radial-gradient(...)`, `conic-gradient(...)`, several separated by commas. |

```rust tabs
view().h(px(120.0)).rounded(px(16.0)).bg_linear(deg(135.0)).gradient_from(rgb(0x6366f1)).gradient_to(rgb(0xec4899))
```

```tsx tabs
<View style={{ height: 120, borderRadius: 16, backgroundImage: "linear-gradient(135deg, #6366f1, #ec4899)" }} />
```

### Borders

| Key | Type | Rust | Description |
|---|---|---|---|
| `borderWidth` | `number` | `.border(w)`, `.border_1()`, `.border_2()` | Width of all four sides. |
| `borderTopWidth` | `number` | `.border_t(w)` | Top side. |
| `borderRightWidth` | `number` | `.border_r(w)` | Right side. |
| `borderBottomWidth` | `number` | `.border_b(w)` | Bottom side. |
| `borderLeftWidth` | `number` | `.border_l(w)` | Left side. |
| `borderStartWidth` | `number` | `.border_s(w)` | Start side (left in left-to-right layouts). |
| `borderEndWidth` | `number` | `.border_e(w)` | End side. |
| `borderColor` | `ColorValue` | `.border_color(c)` | Color of all four sides. |
| `borderTopColor` | `ColorValue` | `.border_t_color(c)` | Top side. |
| `borderRightColor` | `ColorValue` | `.border_r_color(c)` | Right side. |
| `borderBottomColor` | `ColorValue` | `.border_b_color(c)` | Bottom side. |
| `borderLeftColor` | `ColorValue` | `.border_l_color(c)` | Left side. |
| `borderStartColor` | `ColorValue` | `.border_s_color(c)` | Start side. |
| `borderEndColor` | `ColorValue` | `.border_e_color(c)` | End side. |
| `borderStyle` | `"solid" \| "dashed" \| "dotted" \| "none" \| "hidden"` | `.border_solid()`, `.border_dashed()`, `.border_dotted()`, `.border_none()` | Line style. Default `"solid"`. `"none"` and `"hidden"` draw and lay out no border whatever the widths, set before or after, as in CSS. |

### Corners

| Key | Type | Rust | Description |
|---|---|---|---|
| `borderRadius` | `number` | `.rounded(r)`, `.rounded_lg()` | Radius of all four corners. |
| `borderTopLeftRadius` | `number` | `.rounded_tl(r)` | Top-left corner. |
| `borderTopRightRadius` | `number` | `.rounded_tr(r)` | Top-right corner. |
| `borderBottomRightRadius` | `number` | `.rounded_br(r)` | Bottom-right corner. |
| `borderBottomLeftRadius` | `number` | `.rounded_bl(r)` | Bottom-left corner. |
| `borderTopStartRadius` | `number` | `.rounded_ss(r)` | Top corner on the start side. |
| `borderTopEndRadius` | `number` | `.rounded_se(r)` | Top corner on the end side. |
| `borderBottomStartRadius` | `number` | `.rounded_es(r)` | Bottom corner on the start side. |
| `borderBottomEndRadius` | `number` | `.rounded_ee(r)` | Bottom corner on the end side. |
| `borderCurve` | `"circular" \| "continuous"` | `.border_curve(curve)` | `"continuous"`: corners whose curvature eases into the edges, like iOS app icons. Where the box is too small the curve falls back to circular, so pills stay pills. Works on both platforms. |

### Outline

An outline is drawn outside the border and takes no space in layout.

| Key | Type | Rust | Description |
|---|---|---|---|
| `outlineWidth` | `number` | `.outline(w)` | Line width. |
| `outlineColor` | `ColorValue` | `.outline_color(c)` | Line color. |
| `outlineStyle` | `"solid" \| "dashed" \| "dotted" \| "none" \| "hidden"` | `.outline_dashed()`, `.outline_dotted()`, `.outline_none()` | Line style. |
| `outlineOffset` | `number` | `.outline_offset(o)` | Distance from the border edge; negative values move it inside. |

### Shadows

Two ways to cast a shadow: the CSS `boxShadow` (several layers, spread, inset) or the four `shadow*` keys.

| Key | Type | Rust | Description |
|---|---|---|---|
| `boxShadow` | `string` | `.shadow([BoxShadow { … }])`, `.shadow_md()` | CSS `box-shadow`: offsets, blur, spread and color, several layers separated by commas, `inset` for inner shadows. |
| `shadowColor` | `ColorValue` | `.shadow_color(c)` | Shadow color. |
| `shadowOffset` | `{ width: number; height: number }` | `.shadow_offset(point)` | Offset. Default `{ width: 0, height: -3 }`. |
| `shadowOpacity` | `number` | `.shadow_opacity(o)` | Opacity, 0 to 1. Default `0` (no shadow). |
| `shadowRadius` | `number` | `.shadow_radius(r)` | Blur radius. Default `3`. |

```rust tabs
view().p_4().rounded(px(12.0)).bg(white()).shadow([
    BoxShadow { offset_y: px(1.0), blur: px(2.0), color: rgba(0x0000000f).into(), ..BoxShadow::default() },
    BoxShadow { offset_y: px(8.0), blur: px(24.0), spread: px(-4.0), color: rgba(0x0000001f).into(), ..BoxShadow::default() },
])
```

```tsx tabs
<View style={{ padding: 16, borderRadius: 12, backgroundColor: "#fff",
  boxShadow: "0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px -4px rgb(0 0 0 / 0.12)" }} />
```

> [!NOTE]
> On Android, shadows need a background: a view with a transparent background (text on nothing, for example) casts no shadow. For Android's material shadow use the `android={{ elevation }}` prop instead of a style.

### Opacity, visibility and overflow

| Key | Type | Rust | Description |
|---|---|---|---|
| `opacity` | `number \| AnimatedNode` | `.opacity(o)`, `.bind_opacity(&value)` | 0 (invisible) to 1. Takes a native animated value. |
| `visibility` | `"visible" \| "hidden" \| "collapse"` | | Hidden views keep their space in layout (unlike `display: "none"`). |
| `overflow` | `"visible" \| "hidden"` | `.overflow_hidden()` | `"hidden"` clips children to the view's bounds (and corners). |
| `backfaceVisibility` | `"visible" \| "hidden"` | `.backface_hidden()`, `.backface_visible()` | `"hidden"`: invisible while a 3D rotation turns it away. |
| `verticalAlign` | `"baseline" \| "text-top" \| "text-bottom" \| "middle"` | `.align_baseline()`, `.align_text_top()`, `.align_text_bottom()`, `.align_middle()` | Where a view or image inside a `<Text>` sits in its line, as CSS's `vertical-align`: its bottom on the baseline (default), its top or bottom at the text font's top or bottom, or its middle half the x height above the baseline. The line grows to hold it. |

### Transforms

| Key | Type | Rust | Description |
|---|---|---|---|
| `transform` | `TransformStep[]` | `.translate_x(…)`, `.scale(…)`, `.rotate(…)`, ... (below) | A list of steps, applied right to left like CSS. |
| `transformOrigin` | `string \| (number \| string)[]` | `.transform_origin(…)`, `.origin_top_left()`, ... | The point `transform` acts around: keywords, percentages and lengths (`"top left"`, `"50% 0"`, `[10, 20]`). Default the center. |

A `TransformStep` is an object with one key:

| Step | Value | Rust | Native animated |
|---|---|---|---|
| `translateX`, `translateY` | `number` (points) | `.translate_x(…)`, `.translate_y(…)`; `.bind_translate_x(&v)` | yes |
| `scale`, `scaleX`, `scaleY` | `number` (factor) | `.scale(f)`, `.scale_x(f)`, `.scale_y(f)`; `.bind_scale(&v)` | yes |
| `rotate`, `rotateZ`, `rotateX`, `rotateY` | `number` (degrees) or `string` (`"45deg"`, `"0.5rad"`) | `.rotate(deg(…))`, `.rotate_x(…)`, `.rotate_y(…)`; `.bind_rotate(&v)` | yes |
| `skewX`, `skewY` | `number` (degrees) or `string` | `.skew_x(…)`, `.skew_y(…)` | no |
| `perspective` | `number` | `.perspective(d)` on the parent (CSS's `perspective` property) | no |

```rust tabs
view().perspective(px(600.0)).child(view().rotate_y(deg(20.0)).scale(0.95))
```

```tsx tabs
<View style={{ transform: [{ perspective: 600 }, { rotateY: "20deg" }, { scale: 0.95 }] }} />
```

> [!NOTE]
> Android has no skew: `skewX` and `skewY` are ignored there.

### Filters and blending

| Key | Type | Rust | Description |
|---|---|---|---|
| `filter` | `string` | `.blur(r)`, `.brightness(…)`, `.contrast(…)`, `.grayscale(…)`, `.hue_rotate(…)`, `.invert(…)`, `.saturate(…)`, `.sepia(…)` | CSS filters of the view and its content: `brightness()`, `contrast()`, `grayscale()`, `hue-rotate()`, `invert()`, `saturate()`, `sepia()`, `opacity()`, `blur()`, `drop-shadow()`. |
| `backdropFilter` | `string` | `.backdrop_blur(r)`, `.backdrop_brightness(…)`, ... | CSS filters of what is behind the view, such as `"blur(10px)"` for frosted glass. |
| `glassEffect` | `"none" \| "regular" \| "clear"` | `ViewStyle::glass_effect` (`GlassEffect`) | Liquid Glass behind the view's content on iOS 26 and later. `"regular"` uses the standard material; `"clear"` takes less color from the background. `"none"` is the default. Pair with `backdropFilter` for the blur shown on earlier iOS versions and other platforms. |
| `mixBlendMode` | `"normal" \| "multiply" \| "screen" \| "overlay" \| "darken" \| "lighten" \| "color-dodge" \| "color-burn" \| "hard-light" \| "soft-light" \| "difference" \| "exclusion" \| "hue" \| "saturation" \| "color" \| "luminosity" \| "plus-darker" \| "plus-lighter"` | `.mix_blend_mode(mode)` | How the view blends with what is behind it. |

> [!WARNING]
> Platform limits:
> - iOS applies only `opacity()`, `brightness()` up to 1 and `drop-shadow()` to views. `<Image>` takes every color filter and `blur()`, applied while the image is decoded.
> - iOS `backdropFilter` blur uses a system material at a fraction, an approximation of the exact radius.
> - Android needs API 31 for `blur()`, `drop-shadow()` and `backdropFilter`; below that only color filters apply. Blend modes need API 29.

### Transitions

When a transitioned property changes (from a new style, a class or a variant such as `active:`), the platform animates it natively. No JS runs during the animation.

| Key | Type | Rust | Description |
|---|---|---|---|
| `transitionProperty` | `string` | `.transition()`, `.transition_all()`, `.transition_colors()`, `.transition_opacity()`, `.transition_shadow()`, `.transition_transform()`, `.transition_none()` | Comma-separated properties that animate: `"all"`, `"colors"` (`color`, `backgroundColor`, `borderColor`, ...), `"opacity"`, `"transform"`, `"boxShadow"`, `"borderRadius"`, `"borderWidth"`, or `"none"`. |
| `transitionDuration` | `number \| "${number}ms" \| "${number}s"` | `.duration(ms)` | Milliseconds as a number, or `"150ms"` / `"0.2s"`. |
| `transitionDelay` | `number \| "${number}ms" \| "${number}s"` | `.delay(ms)` | Delay before the transition starts. |
| `transitionTimingFunction` | `"linear" \| "ease" \| "ease-in" \| "ease-out" \| "ease-in-out" \| "cubic-bezier(...)"` | `.ease_linear()`, `.ease_in()`, `.ease_out()`, `.ease_in_out()`, `.ease_bezier(…)` | The easing curve. |

```rust tabs
view()
    .on_press(move || open.update(|o| *o = !*o))
    .h(move || px(if open.get() { 160.0 } else { 56.0 }))
    .opacity(move || if open.get() { 1.0 } else { 0.8 })
    .transition()
    .duration(200.0)
```

```tsx tabs
<View
  onPress={() => open.set(!open())}
  style={{ height: open() ? 160 : 56, opacity: open() ? 1 : 0.8,
    transitionProperty: "opacity, transform", transitionDuration: 200 }}
/>
```

### Keyframe animations

Built-in keyframe animations, run natively (Tailwind's `animate-*`).

| Key | Type | Rust | Description |
|---|---|---|---|
| `animationName` | `"none" \| "spin" \| "ping" \| "pulse" \| "bounce"` | `.animate_spin()`, `.animate_ping()`, `.animate_pulse()`, `.animate_bounce()`, `.animate_none()` | The animation. |
| `animationDuration` | `number \| "${number}ms" \| "${number}s"` | `.animation(KeyframeAnimation { … })` | Length of one iteration. |
| `animationDelay` | `number \| "${number}ms" \| "${number}s"` | `.animation(KeyframeAnimation { … })` | Delay before the first iteration. |
| `animationTimingFunction` | `"linear" \| "ease" \| "ease-in" \| "ease-out" \| "ease-in-out" \| "cubic-bezier(...)"` | `.animation(KeyframeAnimation { … })` | The easing curve. |
| `animationIterationCount` | `number \| "infinite"` | `.animation(KeyframeAnimation { … })` | How many times it runs. |

For animations driven by values, gestures or springs, use [`nsh`'s animation API](./nsh.md#animation) instead.

### Pointer

| Key | Type | Rust | Description |
|---|---|---|---|
| `cursor` | `"auto" \| "default" \| "pointer" \| "text" \| "grab" \| "grabbing" \| "not-allowed" \| ...` (every CSS cursor keyword, and `"none"`) | `.cursor(Cursor)`, `.cursor_pointer()` | The pointer shape over the view, for pointers (iPad trackpads, Mac Catalyst, desktops). |

### SVG paint

CSS's paint properties of SVG shapes, which any element takes and the elements inside it inherit, as in a browser.
They paint what Rust components draw on canvases.

| Key | Type | Rust | Description |
|---|---|---|---|
| `fill` | `"none" \| "currentColor" \| ColorValue` | `.fill_color(c)`, `.fill_none()`, `.fill_current()` | What shapes are filled with; `currentColor` is the element's text color. |
| `stroke` | `"none" \| "currentColor" \| ColorValue` | `.stroke_color(c)`, `.stroke_none()`, `.stroke_current()` | What the outlines of shapes are painted with. |
| `strokeWidth` | `number \| string` | `.stroke_width(w)` | The width of those outlines, a length (1 by default). |
| `strokeDasharray` | `number \| string` | — | Dashes and gaps along those outlines: lengths separated by spaces or commas (`"4 2"`), an odd list repeated, or `"none"`. |

## TextStyle

Text styles apply to `<Text>` and `<Input>`. They are also inherited, as in CSS: text properties set on a view pass to the texts and inputs inside it, and nested `<Text>` spans inherit from their parent text. All keys of `ViewStyle` apply too. See [Text](../docs/text.md).

### Font

| Key | Type | Rust | Description |
|---|---|---|---|
| `color` | `ColorValue` | `.text_color(c)` | Text color. |
| `fontSize` | `number` | `.text_size(s)`, `.text_sm()`, `.text_lg()`, ... | Size in points. |
| `fontWeight` | `"normal" \| "bold" \| number \| "${number}"` | `.font_weight(FontWeight::SEMIBOLD)` | `"normal"` (400), `"bold"` (700) or 100–900. |
| `fontFamily` | `string` | `.font_family(name)` | A system family, or the name an imported font evaluates to (`import Inter from "./Inter.ttf"`). See [Fonts](../docs/fonts.md). |
| `fontStyle` | `"normal" \| "italic"` | `.italic()` | Italic. |
| `fontVariant` | `("small-caps" \| "oldstyle-nums" \| "lining-nums" \| "tabular-nums" \| "proportional-nums")[]` | `.small_caps()`, `.oldstyle_nums()`, `.lining_nums()`, `.tabular_nums()`, `.proportional_nums()` | OpenType number and letter forms. `tabular-nums` keeps digits the same width, useful for counters and timers. |

### Spacing and alignment

| Key | Type | Rust | Description |
|---|---|---|---|
| `lineHeight` | `number` | `.line_height(h)` | Line height in points. |
| `letterSpacing` | `number` | `.letter_spacing(s)` | Extra space between characters, in points. |
| `textAlign` | `"auto" \| "left" \| "center" \| "right" \| "justify"` | `.text_left()`, `.text_center()`, `.text_right()`, `.text_justify()` | Horizontal alignment. |
| `textAlignVertical` | `"auto" \| "top" \| "center" \| "bottom"` | | Where text shorter than its box sits (a `<Text>` with a height). |
| `writingDirection` | `"auto" \| "ltr" \| "rtl"` | `.writing_direction(d)` | Base direction of the text; `"auto"` takes it from the content. |
| `textTransform` | `"none" \| "uppercase" \| "lowercase" \| "capitalize"` | `.uppercase()`, `.lowercase()`, `.capitalize()`, `.normal_case()` | Case transformation. |

> [!TIP]
> Tailwind's `leading-*` and `tracking-*` classes set line heights as multiples of the font size and letter spacing in `em`, so they scale with `text-*` sizes.

### Decoration

| Key | Type | Rust | Description |
|---|---|---|---|
| `textDecorationLine` | `"none" \| "underline" \| "line-through" \| "underline line-through"` | `.underline()`, `.line_through()`, `.no_underline()` | Lines drawn with the text. |
| `textDecorationColor` | `ColorValue` | `.text_decoration_color(c)` | Color of the lines (default the text color). |
| `textDecorationStyle` | `"solid" \| "double" \| "dotted" \| "dashed" \| "wavy"` | `.text_decoration_solid()`, `_double()`, `_dotted()`, `_dashed()`, `_wavy()` | Line style. |
| `textDecorationThickness` | `number \| "auto" \| "from-font"` | `.text_decoration_thickness(t)` | Line thickness. |
| `textUnderlineOffset` | `number \| "auto"` | `.underline_offset(o)` | Distance of the underline from the baseline. |

### Placeholder and selection

| Key | Type | Rust | Description |
|---|---|---|---|
| `placeholderColor` | `ColorValue` | `.placeholder_color(c)` of an input | The color of an `<Input>`'s placeholder (`placeholder:text-*`). |
| `selectionColor` | `ColorValue` | `.selection_color(c)` of an input or a text | An `<Input>`'s caret and selection, a selectable `<Text>`'s selection highlight and handles (`selection:bg-*`); the platform's accent by default. |

### Text shadow

| Key | Type | Rust | Description |
|---|---|---|---|
| `textShadowColor` | `ColorValue` | `.text_shadow_color(c)` | Shadow color. |
| `textShadowOffset` | `{ width: number; height: number }` | `.text_shadow_offset(point)` | Shadow offset. |
| `textShadowRadius` | `number` | `.text_shadow_radius(r)` | Blur radius. |

> [!NOTE]
> iOS draws no gradients (`backgroundImage`) or inset box shadows on `<Text>`.

## ImageStyle

All keys of `ViewStyle`, plus:

| Key | Type | Rust | Description |
|---|---|---|---|
| `tintColor` | `ColorValue` | `.tint_color(c)` of an image | Recolors a template image (every opaque pixel takes this color), for monochrome icons. |
| `objectPosition` | `string` | `.object_position(p)`, `.object_top()`, ... of an image | Where the image sits in its box once `resizeMode` has sized it, as CSS's `object-position`: keywords, percentages and lengths (`"top"`, `"left bottom"`, `"25% 75%"`, `"right 10px bottom 20%"`). A covering image is cropped around it. Default the center. |

How an image fills its box is the `resizeMode` prop of `<Image>`, not a style; see [image](../elements/image.md).

## Props that look like styles

Some settings are props in NSH, not style keys. Their Tailwind classes exist, but an explicit prop wins over the class:

| Setting | Prop | Rust | Class |
|---|---|---|---|
| Line limit | `numberOfLines` on `<Text>` | `.number_of_lines(n)` | `line-clamp-*`, `truncate` |
| Ellipsis position | `ellipsizeMode` on `<Text>` | `.ellipsize_mode(mode)` | `text-ellipsis`, `text-clip` |
| Touch pass-through | `pointerEvents` | `.pointer_events(…)` | `pointer-events-none`, `pointer-events-auto` |
| Image fit | `resizeMode` on `<Image>` | `.resize_mode(mode)` | `object-cover`, `object-contain`, ... |
| Selectable text | `selectable` on `<Text>` | `.selectable(true)` | `select-text`, `select-none` |
| Material shadow (Android) | `android={{ elevation }}` | `.elevation(e)` | |

## Related

- [Styling](../docs/styling.md): `style`, `class`, inheritance and precedence.
- [Tailwind reference](./tailwind-reference.md): every supported utility and variant.
- [Layout](../docs/layout.md): flexbox and grid in practice.
- [view](../elements/view.md), [text](../elements/text.md), [image](../elements/image.md): the elements these styles apply to.

`width`, `height` and `flexBasis` also accept `"min-content"`, `"max-content"` and `"fit-content"`, computed by Taffy.
