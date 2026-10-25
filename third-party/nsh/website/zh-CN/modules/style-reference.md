---
title: 样式参考
description: NSH 支持的全部样式属性，按 LayoutStyle、ViewStyle、TextStyle 和 ImageStyle 分组，列出类型与含义。
order: 16
---

# 样式参考

本页列出 `style` 属性可用的每一个键，以及在 Rust 中设置它的 `Styled` 方法。Rust 组件用以 Tailwind 工具类命名的类型化方法为元素设置样式（`.p_4()`、`.rounded(px(12.0))`、`.bg(color)`，来自 `nsh_core::ui::prelude`），它们会落到同样的键上；TSX 传入 `style` 对象（以及 class）。Rust 列给出对应的方法；大多数方法接受一个值、一个 signal 或一个闭包，`.style_when(…)` / `.style_with(…)` 可以让任意样式按条件生效。键名和类型来自生成的声明文件 `.nsh/types/nsh/types.d.ts`，编辑器会在你输入时检查它们。布局是默认纵向排列的 flexbox，数字的单位是点，同时支持这些 CSS 能力：网格、渐变、盒阴影、滤镜、混合模式、轮廓线、过渡和关键帧动画。

样式怎么写、怎样与 class 组合、文字样式如何继承，见 [样式](../docs/styling.md)。class 的语法见 [Tailwind 参考](./tailwind-reference.md)。

## 四个接口

每个接口都扩展前一个：

| 接口 | 扩展自 | 用于 |
|---|---|---|
| `LayoutStyle` | | 所有元素的布局（flexbox、网格、尺寸、间距、定位） |
| `ViewStyle` | `LayoutStyle` | `<View>`、`<Scroll>`、`<List>`、控件及其他所有元素 |
| `TextStyle` | `ViewStyle` | `<Text>` 和 `<Input>`（以及视图：视图上的文字样式会传给其中的文字） |
| `ImageStyle` | `ViewStyle` | `<Image>` |

```rust tabs
use nsh_core::ui::prelude::*;

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

`style` 也接受数组：各项从左到右合并，假值会被跳过，因此条件样式无需展开运算。在 Rust 中，`.style_when(condition, …)` 在条件成立时加上样式：

```rust tabs
card().style_when(selected, |s| s.border_color(rgb(0x2563eb)).border(px(2.0)))
```

```tsx tabs
<View style={[card, selected() && { borderColor: "#2563eb", borderWidth: 2 }]} />
```

> [!NOTE]
> 内联 `style` 总是覆盖 `class`。把某个键设为 `null` 或 `undefined` 会将其恢复为默认值。

## 值类型

| 类型 | 接受 | Rust |
|---|---|---|
| `number` | 点（与密度无关）。`1` 在 iOS 上是一个 point，在 Android 上是一个 dp。 | `Points`：`px(16.0)` |
| `DimensionValue` | `number`（点）、`` `${number}%` ``（相对父元素）或 `"auto"`。 | `Length`：`px(…)`、`relative(0.5)`、`auto()` |
| `LengthValue` | `number`（点）或 `` `${number}%` ``，不接受 `"auto"`。 | `DefiniteLength`：`px(…)`、`relative(0.5)` |
| `ColorValue` | CSS 颜色字符串：`#rgb`、`#rgba`、`#rrggbb`、`#rrggbbaa`、`rgb()`、`rgba()`、`hsl()`、`hsla()`、`oklch()`、`oklab()`，或 CSS 命名颜色（`black`、`white`、`transparent`、`rebeccapurple` 等）。 | `Hsla` / `AdaptiveColor`：`rgb(0x2563eb)`、`hsla(…)`, 主题颜色（`theme().primary`） |
| `AnimatedNode` | 原生动画值，或由它派生的节点（见 [nsh/animated](./nsh-animated.md)）。`backgroundColor`、`opacity` 和 `transform` 的各步骤接受它，值会在 UI 线程上动画，不经过 JS。 | `AnimatedValue` / `AnimatedNode`，用 `.bind_opacity(&v)`、`.bind_background(&v)`、`.bind_translate_x(&v)` 等绑定 |

采用 CSS 语法的字符串（`boxShadow`、`backgroundImage`、`filter`、`gridTemplateColumns` 等）中，长度可写 `px` 或裸数字（都是点）、`pt`（与 CSS 相同，为 4/3 点），或 `rem`（16 点）。

## LayoutStyle

布局在 Rust 中计算（flexbox 和 CSS 网格）。默认值与 CSS 不同：`display: "flex"`、`flexDirection: "column"`、`flexShrink: 0`、`alignContent: "flex-start"`（网格中为 CSS 的 `"normal"`）、`alignItems: "stretch"`，并且没有自动最小尺寸。见 [布局](../docs/layout.md)。

### 显示与定位

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `display` | `"flex" \| "grid" \| "block" \| "flow-root" \| "none"` | `.flex()`、`.grid()`、`.hidden()` | 子元素的布局方式。`"none"` 将元素移出布局并隐藏。`"block"` 按 CSS 块级布局堆叠子元素。默认 `"flex"`。 |
| `boxSizing` | `"border-box" \| "content-box"` | | 尺寸包含边框和内边距，或仅包含内容。默认 `"border-box"`。 |
| `position` | `"relative" \| "absolute" \| "static" \| "fixed" \| "sticky"` | `.relative()`、`.absolute()` | `"absolute"` 使元素脱离文档流，按 `top` / `right` / `bottom` / `left` 相对最近的定位祖先定位（父元素为 `"static"` 时再向上找）。`"static"` 留在文档流中并忽略偏移。`"fixed"` 保留元素类型，在窗口或模态框根视图中布局和挂载，周围内容滚动时保持不动。`"sticky"` 留在文档流中，在其父元素可见时，吸附在外层滚动视图视口起始处 `top`（横向滚动视图中为 `left`）的位置，直到它的末端碰到父元素内容框的末端；它绘制在 `zIndex` 相同的兄弟元素之上。默认 `"relative"`。 |
| `top` | `DimensionValue \| AnimatedNode` | `.top(…)`、`.inset(…)`、`.bind_sticky_top(&node)` | 距父元素上边（绝对定位），或相对自身位置的偏移（相对定位）。在吸附视图上表示吸附的位置，动画值让它逐帧移动。 |
| `right` | `DimensionValue` | `.right(…)` | 距右边的偏移。从右到左布局中表示结束边。 |
| `bottom` | `DimensionValue` | `.bottom(…)` | 距下边的偏移。 |
| `left` | `DimensionValue \| AnimatedNode` | `.left(…)`、`.bind_sticky_left(&node)` | 距左边的偏移。从右到左布局中表示起始边。在横向滚动视图中的吸附视图上表示吸附的位置，动画值让它逐帧移动。 |
| `start` | `DimensionValue` | | 从左到右布局中为左，从右到左布局中为右。 |
| `end` | `DimensionValue` | | 从左到右布局中为右，从右到左布局中为左。 |
| `zIndex` | `number` | `.z_index(z)` | 在兄弟元素间的次序（值相同时保持原顺序），也是原生视图的叠放次序。 |
| `direction` | `"inherit" \| "ltr" \| "rtl"` | | 布局方向，默认继承。从右到左时，`left` 和 `right` 属性表示起始和结束。 |

### Flexbox

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `flexDirection` | `"row" \| "column" \| "row-reverse" \| "column-reverse"` | `.flex_row()`、`.flex_col()`、`.flex_row_reverse()`、`.flex_col_reverse()` | 主轴方向。默认 `"column"`。 |
| `flexWrap` | `"wrap" \| "nowrap" \| "wrap-reverse"` | `.flex_wrap()` | 子元素是否换行。默认 `"nowrap"`。 |
| `flex` | `number` | `.flex_1()`、`.flex_auto()`、`.flex_none()` | 单个数字，不是 CSS 简写：正数会把 `flexGrow` 设为该值，同时 `flexShrink: 1`、`flexBasis: 0`；`0` 让元素不伸缩；负数让元素可以收缩到最小尺寸。 |
| `flexGrow` | `number` | `.flex_grow(f)` | 占用剩余空间的比例。默认 `0`。 |
| `flexShrink` | `number` | `.flex_shrink(f)`、`.flex_shrink_0()` | 空间不足时的收缩比例。默认 `0`，而不是 CSS 的 `1`。 |
| `flexBasis` | `DimensionValue` | `.basis(…)` | 分配剩余空间之前的主轴尺寸。 |
| `justifyContent` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "center" \| "space-between" \| "space-around" \| "space-evenly" \| "stretch" \| "normal"` | `.justify_start()`、`.justify_center()`、`.justify_end()`、`.justify_between()`、`.justify_around()`、`.justify_evenly()` | 子元素沿主轴的分布。默认 `"normal"`：在 flex 容器中即 `"flex-start"`；在网格中，尺寸为 `auto` 的轨道会拉伸。 |
| `alignItems` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | `.items_start()`、`.items_center()`、`.items_end()`、`.items_stretch()`、`.items_baseline()` | 子元素在交叉轴上的对齐。默认 `"stretch"`。 |
| `alignSelf` | `"auto" \| "flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | `.self_start()`、`.self_center()`、`.self_end()`、`.self_stretch()` | 为当前元素覆盖父元素的 `alignItems`。 |
| `alignContent` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "center" \| "stretch" \| "space-between" \| "space-around" \| "space-evenly" \| "normal"` | | 多行（及网格轨道）在交叉轴上的分布。flex 容器中默认 `"flex-start"`，网格中默认 `"normal"`，尺寸为 `auto` 的轨道会拉伸。`"start"` / `"end"` 跟随书写方向。 |
| `gap` | `LengthValue` | `.gap(…)`、`.gap_4()` | 子元素行与列之间的间距。 |
| `rowGap` | `LengthValue` | `.gap_y(…)` | 行间距。 |
| `columnGap` | `LengthValue` | `.gap_x(…)` | 列间距。 |

### 网格

设置 `display: "grid"` 后，子元素按 CSS 网格排列。轨道列表使用 CSS 语法。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `gridTemplateColumns` | `string` | `.grid_template_columns(…)`、`.grid_cols(n)` | 列轨道：`"repeat(3, 1fr)"`、`"200px 1fr"`、`minmax()`、`auto-fill` / `auto-fit`、网格线名称（`"[a] 40px [b c] 1fr [d]"`）。 |
| `gridTemplateRows` | `string` | `.grid_template_rows(…)`、`.grid_rows(n)` | 行轨道，语法同上。 |
| `gridAutoColumns` | `string` | | 隐式创建的列的尺寸。 |
| `gridAutoRows` | `string` | | 隐式创建的行的尺寸。 |
| `gridAutoFlow` | `"row" \| "column" \| "dense" \| "row dense" \| "column dense"` | `.grid_flow_col()`、`.grid_flow_dense()` | 未指定位置的项目如何填入网格。 |
| `gridColumn` | `number \| string` | `.col_span(n)`、`.col_span_full()` | 列位置：`"1 / 3"`、`"span 2"`、网格线编号或名称（`"content-start / content-end"`、`"2 col"`、`"span col"`）。 |
| `gridColumnStart` | `number \| string` | `.col_start(…)` | 起始列线。 |
| `gridColumnEnd` | `number \| string` | `.col_end(…)` | 结束列线。 |
| `gridRow` | `number \| string` | `.row_span(n)`、`.row_span_full()` | 行位置，语法同 `gridColumn`。 |
| `gridRowStart` | `number \| string` | `.row_start(…)` | 起始行线。 |
| `gridRowEnd` | `number \| string` | `.row_end(…)` | 结束行线。 |
| `justifyItems` | `"flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | | 网格项在其区域内沿行方向的位置。 |
| `justifySelf` | `"auto" \| "flex-start" \| "flex-end" \| "start" \| "end" \| "self-start" \| "self-end" \| "center" \| "stretch" \| "baseline" \| "normal"` | | 为当前项覆盖 `justifyItems`。 |

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

### 尺寸

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `width` | `DimensionValue` | `.w(…)`、`.w_full()`、`.size(…)` | 宽度。 |
| `height` | `DimensionValue` | `.h(…)`、`.h_full()` | 高度。 |
| `minWidth` | `LengthValue` | `.min_w(…)` | 最小宽度。 |
| `minHeight` | `LengthValue` | `.min_h(…)` | 最小高度。 |
| `maxWidth` | `LengthValue` | `.max_w(…)` | 最大宽度。 |
| `maxHeight` | `LengthValue` | `.max_h(…)` | 最大高度。 |
| `aspectRatio` | `number` | `.aspect_ratio(r)`、`.aspect_square()` | 宽高比（宽 ÷ 高），缺少的一边由另一边算出。 |

### 外边距

外边距接受 `"auto"`（与 flexbox 中一样吸收剩余空间）和负值。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `margin` | `DimensionValue` | `.m(…)`、`.m_4()` | 四边。 |
| `marginHorizontal` | `DimensionValue` | `.mx(…)` | 左右。 |
| `marginVertical` | `DimensionValue` | `.my(…)` | 上下。 |
| `marginTop` | `DimensionValue` | `.mt(…)` | 上。 |
| `marginRight` | `DimensionValue` | `.mr(…)` | 右。 |
| `marginBottom` | `DimensionValue` | `.mb(…)` | 下。 |
| `marginLeft` | `DimensionValue` | `.ml(…)` | 左。 |
| `marginStart` | `DimensionValue` | `.ms(…)` | 从左到右布局中为左，从右到左布局中为右。 |
| `marginEnd` | `DimensionValue` | `.me(…)` | 与 `marginStart` 相对的一边。 |

### 内边距

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `padding` | `LengthValue` | `.p(…)`、`.p_4()` | 四边。 |
| `paddingHorizontal` | `LengthValue` | `.px(…)` | 左右。 |
| `paddingVertical` | `LengthValue` | `.py(…)` | 上下。 |
| `paddingTop` | `LengthValue` | `.pt(…)` | 上。 |
| `paddingRight` | `LengthValue` | `.pr(…)` | 右。 |
| `paddingBottom` | `LengthValue` | `.pb(…)` | 下。 |
| `paddingLeft` | `LengthValue` | `.pl(…)` | 左。 |
| `paddingStart` | `LengthValue` | `.ps(…)` | 从左到右布局中为左，从右到左布局中为右。 |
| `paddingEnd` | `LengthValue` | `.pe(…)` | 与 `paddingStart` 相对的一边。 |

## ViewStyle

视图绘制的一切。`LayoutStyle` 的全部键同样适用。

### 背景

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `backgroundColor` | `ColorValue \| AnimatedNode` | `.bg(color)`、`.bind_background(&node)` | 填充色。接受原生动画颜色。 |
| `backgroundImage` | `string` | `.bg_linear(angle)`、`.bg_radial()`、`.bg_conic()` 配合 `.gradient_from` / `_via` / `_to` | 画在背景色之上的 CSS 渐变：`linear-gradient(...)`、`radial-gradient(...)`、`conic-gradient(...)`，多个用逗号分隔。 |

```rust tabs
view().h(px(120.0)).rounded(px(16.0)).bg_linear(deg(135.0)).gradient_from(rgb(0x6366f1)).gradient_to(rgb(0xec4899))
```

```tsx tabs
<View style={{ height: 120, borderRadius: 16, backgroundImage: "linear-gradient(135deg, #6366f1, #ec4899)" }} />
```

### 边框

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `borderWidth` | `number` | `.border(w)`、`.border_1()`、`.border_2()` | 四边宽度。 |
| `borderTopWidth` | `number` | `.border_t(w)` | 上边。 |
| `borderRightWidth` | `number` | `.border_r(w)` | 右边。 |
| `borderBottomWidth` | `number` | `.border_b(w)` | 下边。 |
| `borderLeftWidth` | `number` | `.border_l(w)` | 左边。 |
| `borderStartWidth` | `number` | `.border_s(w)` | 起始边（从左到右布局中为左）。 |
| `borderEndWidth` | `number` | `.border_e(w)` | 结束边。 |
| `borderColor` | `ColorValue` | `.border_color(c)` | 四边颜色。 |
| `borderTopColor` | `ColorValue` | `.border_t_color(c)` | 上边。 |
| `borderRightColor` | `ColorValue` | `.border_r_color(c)` | 右边。 |
| `borderBottomColor` | `ColorValue` | `.border_b_color(c)` | 下边。 |
| `borderLeftColor` | `ColorValue` | `.border_l_color(c)` | 左边。 |
| `borderStartColor` | `ColorValue` | `.border_s_color(c)` | 起始边。 |
| `borderEndColor` | `ColorValue` | `.border_e_color(c)` | 结束边。 |
| `borderStyle` | `"solid" \| "dashed" \| "dotted" \| "none" \| "hidden"` | `.border_solid()`、`.border_dashed()`、`.border_dotted()`、`.border_none()` | 线型。默认 `"solid"`。`"none"` 和 `"hidden"` 与 CSS 一样，无论宽度在之前还是之后设置，都不绘制边框，也不占布局空间。 |

### 圆角

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `borderRadius` | `number` | `.rounded(r)`、`.rounded_lg()` | 四个角的半径。 |
| `borderTopLeftRadius` | `number` | `.rounded_tl(r)` | 左上角。 |
| `borderTopRightRadius` | `number` | `.rounded_tr(r)` | 右上角。 |
| `borderBottomRightRadius` | `number` | `.rounded_br(r)` | 右下角。 |
| `borderBottomLeftRadius` | `number` | `.rounded_bl(r)` | 左下角。 |
| `borderTopStartRadius` | `number` | `.rounded_ss(r)` | 起始侧的上角。 |
| `borderTopEndRadius` | `number` | `.rounded_se(r)` | 结束侧的上角。 |
| `borderBottomStartRadius` | `number` | `.rounded_es(r)` | 起始侧的下角。 |
| `borderBottomEndRadius` | `number` | `.rounded_ee(r)` | 结束侧的下角。 |
| `borderCurve` | `"circular" \| "continuous"` | `.border_curve(curve)` | `"continuous"`：曲率平滑过渡到直边的圆角，类似 iOS 应用图标。盒子太小时退回普通圆角，所以胶囊形依然是胶囊形。两个平台都支持。 |

### 轮廓线

轮廓线画在边框之外，不占布局空间。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `outlineWidth` | `number` | `.outline(w)` | 线宽。 |
| `outlineColor` | `ColorValue` | `.outline_color(c)` | 颜色。 |
| `outlineStyle` | `"solid" \| "dashed" \| "dotted" \| "none" \| "hidden"` | `.outline_dashed()`、`.outline_dotted()`、`.outline_none()` | 线型。 |
| `outlineOffset` | `number` | `.outline_offset(o)` | 与边框外缘的距离；负值向内。 |

### 阴影

两种方式投射阴影：CSS 的 `boxShadow`（多层、扩展、内阴影），或四个 `shadow*` 键。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `boxShadow` | `string` | `.shadow([BoxShadow { … }])`、`.shadow_md()` | CSS `box-shadow`：偏移、模糊、扩展和颜色，多层用逗号分隔，`inset` 表示内阴影。 |
| `shadowColor` | `ColorValue` | `.shadow_color(c)` | 阴影颜色。 |
| `shadowOffset` | `{ width: number; height: number }` | `.shadow_offset(point)` | 偏移。默认 `{ width: 0, height: -3 }`。 |
| `shadowOpacity` | `number` | `.shadow_opacity(o)` | 不透明度，0 到 1。默认 `0`（无阴影）。 |
| `shadowRadius` | `number` | `.shadow_radius(r)` | 模糊半径。默认 `3`。 |

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
> 在 Android 上，阴影需要背景：背景透明的视图（例如没有底色的文字）不会投射阴影。若要 Android 的 Material 阴影，请用 `android={{ elevation }}` 属性，而不是样式。

### 不透明度、可见性与裁剪

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `opacity` | `number \| AnimatedNode` | `.opacity(o)`、`.bind_opacity(&value)` | 0（不可见）到 1。接受原生动画值。 |
| `visibility` | `"visible" \| "hidden" \| "collapse"` | | 隐藏的视图仍占据布局空间（与 `display: "none"` 不同）。 |
| `overflow` | `"visible" \| "hidden"` | `.overflow_hidden()` | `"hidden"` 将子元素裁剪到视图边界（含圆角）。 |
| `backfaceVisibility` | `"visible" \| "hidden"` | `.backface_hidden()`、`.backface_visible()` | `"hidden"`：3D 旋转转到背面时不可见。 |
| `verticalAlign` | `"baseline" \| "text-top" \| "text-bottom" \| "middle"` | `.align_baseline()`、`.align_text_top()`、`.align_text_bottom()`、`.align_middle()` | `<Text>` 中的视图或图片在所在行中的位置，与 CSS 的 `vertical-align` 一致：底边落在基线上（默认）、顶边或底边对齐文本字体的顶部或底部，或中心位于基线上方半个 x 高度处。所在行会撑高以容纳它。 |

### 变换

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `transform` | `TransformStep[]` | `.translate_x(…)`、`.scale(…)`、`.rotate(…)`……（见下文） | 步骤列表，与 CSS 一样从右向左应用。 |
| `transformOrigin` | `string \| (number \| string)[]` | `.transform_origin(…)`、`.origin_top_left()` 等 | `transform` 的作用中心：关键字、百分比和长度（`"top left"`、`"50% 0"`、`[10, 20]`）。默认为中心。 |

`TransformStep` 是只有一个键的对象：

| 步骤 | 值 | Rust | 原生动画 |
|---|---|---|---|
| `translateX`、`translateY` | `number`（点） | `.translate_x(…)`、`.translate_y(…)`；`.bind_translate_x(&v)` | 支持 |
| `scale`、`scaleX`、`scaleY` | `number`（倍数） | `.scale(f)`、`.scale_x(f)`、`.scale_y(f)`；`.bind_scale(&v)` | 支持 |
| `rotate`、`rotateZ`、`rotateX`、`rotateY` | `number`（度）或 `string`（`"45deg"`、`"0.5rad"`） | `.rotate(deg(…))`、`.rotate_x(…)`、`.rotate_y(…)`；`.bind_rotate(&v)` | 支持 |
| `skewX`、`skewY` | `number`（度）或 `string` | `.skew_x(…)`、`.skew_y(…)` | 不支持 |
| `perspective` | `number` | 父视图的 `.perspective(d)`（CSS 的 `perspective` 属性） | 不支持 |

```rust tabs
view().perspective(px(600.0)).child(view().rotate_y(deg(20.0)).scale(0.95))
```

```tsx tabs
<View style={{ transform: [{ perspective: 600 }, { rotateY: "20deg" }, { scale: 0.95 }] }} />
```

> [!NOTE]
> Android 不支持斜切：`skewX` 和 `skewY` 在 Android 上会被忽略。

### 滤镜与混合

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `filter` | `string` | `.blur(r)`、`.brightness(…)`、`.contrast(…)`、`.grayscale(…)`、`.hue_rotate(…)`、`.invert(…)`、`.saturate(…)`、`.sepia(…)` | 作用于视图及其内容的 CSS 滤镜：`brightness()`、`contrast()`、`grayscale()`、`hue-rotate()`、`invert()`、`saturate()`、`sepia()`、`opacity()`、`blur()`、`drop-shadow()`。 |
| `backdropFilter` | `string` | `.backdrop_blur(r)`、`.backdrop_brightness(…)` 等 | 作用于视图背后内容的 CSS 滤镜，例如毛玻璃效果 `"blur(10px)"`。 |
| `glassEffect` | `"none" \| "regular" \| "clear"` | `ViewStyle::glass_effect`（`GlassEffect`） | 在 iOS 26 及更高版本中，于视图内容背后绘制 Liquid Glass。`"regular"` 使用标准材质，`"clear"` 从背景获取的颜色更少，默认值为 `"none"`。配合 `backdropFilter`，可在更早的 iOS 版本及其他平台上显示模糊效果。 |
| `mixBlendMode` | `"normal" \| "multiply" \| "screen" \| "overlay" \| "darken" \| "lighten" \| "color-dodge" \| "color-burn" \| "hard-light" \| "soft-light" \| "difference" \| "exclusion" \| "hue" \| "saturation" \| "color" \| "luminosity" \| "plus-darker" \| "plus-lighter"` | `.mix_blend_mode(mode)` | 视图与背后内容的混合方式。 |

> [!WARNING]
> 平台限制：
> - iOS 上视图只支持 `opacity()`、不超过 1 的 `brightness()` 和 `drop-shadow()`。`<Image>` 支持所有颜色滤镜和 `blur()`，在解码图片时应用。
> - iOS 的 `backdropFilter` 模糊使用按比例调整的系统材质，是对精确半径的近似。
> - Android 上 `blur()`、`drop-shadow()` 和 `backdropFilter` 需要 API 31；更低版本只应用颜色滤镜。混合模式需要 API 29。

### 过渡

当参与过渡的属性改变时（来自新样式、class，或 `active:` 等变体），平台以原生方式执行动画，期间不运行任何 JS。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `transitionProperty` | `string` | `.transition()`、`.transition_all()`、`.transition_colors()`、`.transition_opacity()`、`.transition_shadow()`、`.transition_transform()`、`.transition_none()` | 参与动画的属性，用逗号分隔：`"all"`、`"colors"`（`color`、`backgroundColor`、`borderColor` 等）、`"opacity"`、`"transform"`、`"boxShadow"`、`"borderRadius"`、`"borderWidth"`，或 `"none"`。 |
| `transitionDuration` | `number \| "${number}ms" \| "${number}s"` | `.duration(ms)` | 数字表示毫秒，也可写 `"150ms"` / `"0.2s"`。 |
| `transitionDelay` | `number \| "${number}ms" \| "${number}s"` | `.delay(ms)` | 过渡开始前的延迟。 |
| `transitionTimingFunction` | `"linear" \| "ease" \| "ease-in" \| "ease-out" \| "ease-in-out" \| "cubic-bezier(...)"` | `.ease_linear()`、`.ease_in()`、`.ease_out()`、`.ease_in_out()`、`.ease_bezier(…)` | 缓动曲线。 |

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

### 关键帧动画

内置的关键帧动画，以原生方式运行（对应 Tailwind 的 `animate-*`）。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `animationName` | `"none" \| "spin" \| "ping" \| "pulse" \| "bounce"` | `.animate_spin()`、`.animate_ping()`、`.animate_pulse()`、`.animate_bounce()`、`.animate_none()` | 动画名称。 |
| `animationDuration` | `number \| "${number}ms" \| "${number}s"` | `.animation(KeyframeAnimation { … })` | 单次时长。 |
| `animationDelay` | `number \| "${number}ms" \| "${number}s"` | `.animation(KeyframeAnimation { … })` | 首次开始前的延迟。 |
| `animationTimingFunction` | `"linear" \| "ease" \| "ease-in" \| "ease-out" \| "ease-in-out" \| "cubic-bezier(...)"` | `.animation(KeyframeAnimation { … })` | 缓动曲线。 |
| `animationIterationCount` | `number \| "infinite"` | `.animation(KeyframeAnimation { … })` | 重复次数。 |

由数值、手势或弹簧驱动的动画请使用 [nsh/animated](./nsh-animated.md)。

### 指针

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `cursor` | `"auto" \| "default" \| "pointer" \| "text" \| "grab" \| "grabbing" \| "not-allowed" \| ...`（所有 CSS 光标关键字及 `"none"`） | `.cursor(Cursor)`、`.cursor_pointer()` | 指针悬停在视图上时的形状，适用于指针设备（iPad 触控板、Mac Catalyst、桌面）。 |

### SVG 绘制

CSS 中 SVG 图形的绘制属性：任何元素都可以设置，并像在浏览器中一样由内部元素继承。它们决定 Rust 组件在画布上绘制的内容的颜色和线条。

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `fill` | `"none" \| "currentColor" \| ColorValue` | `.fill_color(c)`、`.fill_none()`、`.fill_current()` | 图形的填充；`currentColor` 是元素的文字颜色。 |
| `stroke` | `"none" \| "currentColor" \| ColorValue` | `.stroke_color(c)`、`.stroke_none()`、`.stroke_current()` | 图形轮廓的颜色。 |
| `strokeWidth` | `number \| string` | `.stroke_width(w)` | 轮廓的宽度，一个长度（默认 1）。 |
| `strokeDasharray` | `number \| string` | — | 轮廓上的虚线与间隔：用空格或逗号分隔的长度（`"4 2"`），奇数个时重复一遍，或 `"none"`。 |

## TextStyle

文字样式用于 `<Text>` 和 `<Input>`。它们也像 CSS 一样会继承：视图上设置的文字属性会传给其中的文字和输入框，嵌套的 `<Text>` 片段继承父文字的样式。`ViewStyle` 的全部键同样适用。见 [文字](../docs/text.md)。

### 字体

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `color` | `ColorValue` | `.text_color(c)` | 文字颜色。 |
| `fontSize` | `number` | `.text_size(s)`、`.text_sm()`、`.text_lg()` 等 | 字号，单位为点。 |
| `fontWeight` | `"normal" \| "bold" \| number \| "${number}"` | `.font_weight(FontWeight::SEMIBOLD)` | `"normal"`（400）、`"bold"`（700）或 100–900。 |
| `fontFamily` | `string` | `.font_family(name)` | 系统字体族，或导入字体得到的名字（`import Inter from "./Inter.ttf"`）。见 [字体](../docs/fonts.md)。 |
| `fontStyle` | `"normal" \| "italic"` | `.italic()` | 斜体。 |
| `fontVariant` | `("small-caps" \| "oldstyle-nums" \| "lining-nums" \| "tabular-nums" \| "proportional-nums")[]` | `.small_caps()`、`.oldstyle_nums()`、`.lining_nums()`、`.tabular_nums()`、`.proportional_nums()` | OpenType 数字与字母形式。`tabular-nums` 让数字等宽，适合计数器和计时器。 |

### 间距与对齐

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `lineHeight` | `number` | `.line_height(h)` | 行高，单位为点。 |
| `letterSpacing` | `number` | `.letter_spacing(s)` | 字符间的额外间距，单位为点。 |
| `textAlign` | `"auto" \| "left" \| "center" \| "right" \| "justify"` | `.text_left()`、`.text_center()`、`.text_right()`、`.text_justify()` | 水平对齐。 |
| `textAlignVertical` | `"auto" \| "top" \| "center" \| "bottom"` | | 文字比盒子矮时的位置（设置了高度的 `<Text>`）。 |
| `writingDirection` | `"auto" \| "ltr" \| "rtl"` | `.writing_direction(d)` | 文字的基础方向；`"auto"` 由内容决定。 |
| `textTransform` | `"none" \| "uppercase" \| "lowercase" \| "capitalize"` | `.uppercase()`、`.lowercase()`、`.capitalize()`、`.normal_case()` | 大小写转换。 |

> [!TIP]
> Tailwind 的 `leading-*` 和 `tracking-*` 把行高设为字号的倍数、把字间距设为 `em`，因此会随 `text-*` 字号缩放。

### 装饰线

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `textDecorationLine` | `"none" \| "underline" \| "line-through" \| "underline line-through"` | `.underline()`、`.line_through()`、`.no_underline()` | 与文字一起绘制的线。 |
| `textDecorationColor` | `ColorValue` | `.text_decoration_color(c)` | 线的颜色（默认为文字颜色）。 |
| `textDecorationStyle` | `"solid" \| "double" \| "dotted" \| "dashed" \| "wavy"` | `.text_decoration_solid()`、`_double()`、`_dotted()`、`_dashed()`、`_wavy()` | 线型。 |
| `textDecorationThickness` | `number \| "auto" \| "from-font"` | `.text_decoration_thickness(t)` | 线的粗细。 |
| `textUnderlineOffset` | `number \| "auto"` | `.underline_offset(o)` | 下划线与基线的距离。 |

### 占位符与选区

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `placeholderColor` | `ColorValue` | 输入框的 `.placeholder_color(c)` | `<Input>` 占位文字的颜色（`placeholder:text-*`）。 |
| `selectionColor` | `ColorValue` | 输入框或文本的 `.selection_color(c)` | `<Input>` 的光标和选区、可选 `<Text>` 的选区高亮和选择柄（`selection:bg-*`）；默认为平台的强调色。 |

### 文字阴影

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `textShadowColor` | `ColorValue` | `.text_shadow_color(c)` | 阴影颜色。 |
| `textShadowOffset` | `{ width: number; height: number }` | `.text_shadow_offset(point)` | 阴影偏移。 |
| `textShadowRadius` | `number` | `.text_shadow_radius(r)` | 模糊半径。 |

> [!NOTE]
> iOS 不会在 `<Text>` 上绘制渐变（`backgroundImage`）或内阴影。

## ImageStyle

包含 `ViewStyle` 的全部键，另加：

| 键 | 类型 | Rust | 说明 |
|---|---|---|---|
| `tintColor` | `ColorValue` | 图片的 `.tint_color(c)` | 为模板图片重新着色（所有不透明像素都变成这个颜色），用于单色图标。 |
| `objectPosition` | `string` | 图片的 `.object_position(p)`、`.object_top()` 等 | `resizeMode` 确定尺寸后图片在盒子中的位置，同 CSS 的 `object-position`：关键字、百分比与长度（`"top"`、`"left bottom"`、`"25% 75%"`、`"right 10px bottom 20%"`）。覆盖盒子的图片围绕它裁剪。默认居中。 |

图片如何填充盒子由 `<Image>` 的 `resizeMode` 属性决定，不是样式；见 [image](../elements/image.md)。

## 看起来像样式的属性

有些设置在 NSH 中是属性而不是样式键。它们有对应的 Tailwind class，但显式设置的属性优先于 class：

| 设置 | 属性 | Rust | Class |
|---|---|---|---|
| 行数限制 | `<Text>` 的 `numberOfLines` | `.number_of_lines(n)` | `line-clamp-*`、`truncate` |
| 省略位置 | `<Text>` 的 `ellipsizeMode` | `.ellipsize_mode(mode)` | `text-ellipsis`、`text-clip` |
| 触摸穿透 | `pointerEvents` | `.pointer_events(…)` | `pointer-events-none`、`pointer-events-auto` |
| 图片填充 | `<Image>` 的 `resizeMode` | `.resize_mode(mode)` | `object-cover`、`object-contain` 等 |
| 文字可选 | `<Text>` 的 `selectable` | `.selectable(true)` | `select-text`、`select-none` |
| Material 阴影（Android） | `android={{ elevation }}` | `.elevation(e)` | |

## 相关

- [样式](../docs/styling.md)：`style`、`class`、继承与优先级。
- [Tailwind 参考](./tailwind-reference.md)：支持的全部工具类和变体。
- [布局](../docs/layout.md)：flexbox 和网格的实际用法。
- [view](../elements/view.md)、[text](../elements/text.md)、[image](../elements/image.md)：这些样式所作用的元素。

`width`、`height` 和 `flexBasis` 也接受 `"min-content"`、`"max-content"` 和 `"fit-content"`，由 Taffy 计算。
