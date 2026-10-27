---
title: 布局
description: 默认纵向排列的 Flexbox、CSS 网格、尺寸与百分比、宽高比、绝对定位、用 onLayout 测量、响应式布局以及从右到左布局，用 Rust 和 TSX 编写。
order: 34
group: ui
demo: guide-layout
---

# 布局

NSH 使用 [Taffy](https://github.com/DioxusLabs/taffy) 为每个元素做布局。Taffy 是 CSS flexbox、网格和块布局的 Rust 实现，NSH 对它做了配置，让子元素默认纵向排列且不收缩。布局在核心中运行，发生在你的代码每一轮执行之后，只有发生变化的 frame 会被发送到原生视图。文字由平台的文本引擎在同一线程上测量，因此布局从不需要等待主线程。

下面的布局属性都是样式属性。在 Rust 中它们是类型化的样式方法（`.flex_row()`、`.gap_4()`、`.grid_cols(3)`、`.absolute().inset_0()`）；在 TSX 中它们是 `style` 属性的键，每个都有对应的 [Tailwind](./tailwind.md) 类（`flex-row`、`gap-4`、`grid-cols-3`、`absolute inset-0` 等）。两者生成相同的原生样式。

## Flexbox

视图用 flexbox 排列子元素。默认值与 Web 不同：

| 属性 | NSH 默认值 | Web 默认值 |
|---|---|---|
| `flexDirection` | `"column"` | `row` |
| `flexShrink` | `0` | `1` |
| `alignContent` | `"flex-start"`（网格：`"normal"`） | `normal` |
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

| 属性 | 取值 | Rust |
|---|---|---|
| `flexDirection` | `"column"`、`"row"`、`"column-reverse"`、`"row-reverse"` | `.flex_col()`、`.flex_row()`、`.flex_col_reverse()`、`.flex_row_reverse()` |
| `justifyContent` | 主轴：`"flex-start"`、`"flex-end"`、`"start"`、`"end"`、`"center"`、`"space-between"`、`"space-around"`、`"space-evenly"`、`"stretch"` | `.justify_start()`、`.justify_center()`、`.justify_end()`、`.justify_between()`、`.justify_around()`、`.justify_evenly()` |
| `alignItems` | 交叉轴：`"stretch"`、`"flex-start"`、`"flex-end"`、`"start"`、`"end"`、`"self-start"`、`"self-end"`、`"center"`、`"baseline"` | `.items_stretch()`、`.items_start()`、`.items_center()`、`.items_end()`、`.items_baseline()` |
| `alignSelf` | 单个子元素在交叉轴上的对齐；`"auto"` 跟随父元素的 `alignItems` | `.self_start()`、`.self_center()`、`.self_end()`、`.self_stretch()` |
| `alignContent` | 换行容器中各行的对齐 | |
| `flexWrap` | `"nowrap"`、`"wrap"`、`"wrap-reverse"` | `.flex_wrap()` |
| `flex` | 单个数字的简写（见下文） | `.flex_1()`、`.flex_auto()`、`.flex_none()` |
| `flexGrow`、`flexShrink`、`flexBasis` | 与 CSS 相同 | `.flex_grow(n)`、`.flex_shrink(n)`、`.flex_shrink_0()`、`.basis(length)` |
| `gap`、`rowGap`、`columnGap` | 子元素之间的间距 | `.gap(length)`、`.gap_y(length)`、`.gap_x(length)`，以及刻度方法 `.gap_2()`、`.gap_x_4()` 等 |

`flex-start` 和 `flex-end` 跟随 flex 方向；`start` 和 `end` 与 CSS 一样跟随书写方向（从右到左时，`start` 是右侧），`self-start` / `self-end` 跟随子元素自身的方向。

`flex` 只取一个数字，不是 CSS 简写：正数 `n` 表示按 `n` 增长、按 1 收缩、基准尺寸为 0，因此 `flex: 1` 的兄弟元素（Rust 中的 `.flex_1()`）无论内容多少都会平分空间；`flex: 0`（默认值）让视图按内容确定大小；负数表示按该值收缩，直到最小尺寸。

```rust tabs
view()
    .flex_row()
    .gap_2()
    // 一份。
    .child(view().flex_1().h(px(36.0)).bg(rgb(0xc8e1ff)))
    // 两份。
    .child(view().flex_grow(2.0).flex_shrink(1.0).basis(px(0.0)).h(px(36.0)).bg(rgb(0x79b8ff)))
    // 固定尺寸。
    .child(view().size(px(36.0)).bg(rgb(0x0366d6)))
```

```tsx tabs
<View style={{ flexDirection: "row", gap: 8 }}>
  <View style={{ flex: 1, height: 36, backgroundColor: "#c8e1ff" }} />   {/* one share */}
  <View style={{ flex: 2, height: 36, backgroundColor: "#79b8ff" }} />   {/* two shares */}
  <View style={{ width: 36, height: 36, backgroundColor: "#0366d6" }} /> {/* fixed */}
</View>
```

由于最小尺寸默认为 0，行内 `flex: 1` 的文字会收缩并换行，而不会把兄弟元素挤出去。

> [!NOTE]
> 样式中的 `display: "flex"` 仍保持纵向默认值。只有 Tailwind 的 `flex` 类才像 CSS 那样表示横向（[Tailwind](./tailwind.md)）；在 Rust 中由 `.flex_row()` 设置方向。

## 尺寸

| 属性 | 取值 | Rust |
|---|---|---|
| `width`、`height` | 点、相对父元素的百分比（`"50%"`）或 `"auto"` | `.w(px(120.0))`、`.h(relative(0.5))`、`.w_full()`、`.size(px(44.0))`、刻度方法 `.w_10()` 等 |
| `minWidth`、`maxWidth`、`minHeight`、`maxHeight` | 点或百分比 | `.min_w(..)`、`.max_w(..)`、`.min_h(..)`、`.max_h(..)` |
| `aspectRatio` | 宽除以高：`1`、`16 / 9` | `.aspect_ratio(16.0 / 9.0)`、`.aspect_square()` |
| `padding`、`paddingHorizontal`、`paddingVertical`、`paddingTop` 等 | 点或百分比 | `.p(..)`、`.px(..)`、`.py(..)`、`.pt(..)` 等，以及刻度方法 `.p_4()`、`.px_2()` 等 |
| `margin`、`marginHorizontal`、`marginVertical`、`marginTop` 等 | 点、百分比或 `"auto"` | `.m(..)`、`.mx(..)`、`.my(..)`、`.mt(..)` 等，`.mx(auto())` |

在 Rust 中长度是类型化的：`px(16.0)` 是 16 点，`relative(0.5)` 是父元素的 50%，`auto()` 是 `auto`。刻度方法遵循 Tailwind 的间距刻度，每一级 4 点（`.p_4()` 是 16 点，`.gap_0p5()` 是 2 点）。

不指定尺寸时，视图的大小等于内容（加上内边距），并因默认的 `alignItems: "stretch"` 在父元素的交叉轴上被拉伸。百分比相对于父元素的尺寸（内边距和外边距与 CSS 一样，相对于父元素的宽度）。

`aspectRatio` 根据已知的一边计算另一边：

```rust tabs
view().w_full().aspect_ratio(16.0 / 9.0).bg(black())
```

```tsx tabs
<View style={{ width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000000" }} />
```

来自应用资源的图片有自然尺寸，未指定尺寸时按自然尺寸布局（[图片与资源](./images-and-assets.md)）。远程图片在加载完成前没有尺寸：请为它们指定尺寸。

## 网格

`display: "grid"`（Rust 中的 `.grid()`）把子元素排进 CSS 网格轨道：

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

| 属性 | 取值 | Rust |
|---|---|---|
| `gridTemplateColumns`、`gridTemplateRows` | CSS 轨道列表：`"repeat(3, 1fr)"`、`"200px 1fr"`、`minmax()`、`auto-fill` / `auto-fit`、线名 | `.grid_cols(3)`、`.grid_rows(2)`、`.grid_template_columns("200px 1fr")`、`.grid_template_rows(..)` |
| `gridAutoColumns`、`gridAutoRows` | 隐式创建的列和行的轨道 | |
| `gridAutoFlow` | `"row"`、`"column"`、`"dense"`、`"row dense"`、`"column dense"` | `.grid_flow_col()`、`.grid_flow_dense()` |
| `gridColumn`、`gridRow` | `"1 / 3"`、`"span 2"`、线编号或线名：`"content-start / content-end"`、`"2 col"`（第二条名为 `col` 的线）、`"span col"`（跨到下一条名为 `col` 的线） | `.col_span(2)`、`.row_span(2)`、`.col_span_full()` |
| `gridColumnStart`、`gridColumnEnd`、`gridRowStart`、`gridRowEnd` | 线编号或线名 | `.col_start(1)`、`.col_end(3)`、`.row_start(..)`、`.row_end(..)`（线编号） |
| `justifyItems`、`justifySelf` | 项目在其区域内沿行方向的位置：`"start"`、`"end"`、`"center"`、`"stretch"` 等 | |
| `alignItems`、`alignSelf` | 项目在其区域内沿列方向的位置 | `.items_*()`、`.self_*()` |
| `justifyContent`、`alignContent` | 轨道在网格中沿行方向和列方向的位置 | `.justify_*()` |

模板在方括号中为网格线命名，每条线可以有一个或多个名称，项目可以按名称放置，与 CSS 相同（在 Rust 中按线的编号放置）：

```rust tabs
view()
    .grid()
    .grid_template_columns("[full-start] 16px [content-start] 1fr [content-end] 16px [full-end]")
    // content-start / content-end：第 2 到第 3 条线。
    .child(view().col_start(2).col_end(3).h(px(60.0)).bg(rgb(0xb083f0)))
    // full-start / full-end：第 1 到第 4 条线。
    .child(view().col_start(1).col_end(4).h(px(60.0)).bg(rgb(0x8250df)))
```

```tsx tabs
<View style={{ display: "grid", gridTemplateColumns: "[full-start] 16px [content-start] 1fr [content-end] 16px [full-end]" }}>
  <View style={{ gridColumn: "content-start / content-end", height: 60, backgroundColor: "#b083f0" }} />
  <View style={{ gridColumn: "full-start / full-end", height: 60, backgroundColor: "#8250df" }} />
</View>
```

在网格中，`justifyContent` 和 `alignContent` 默认是 CSS 的 `"normal"`：尺寸为 `auto` 的轨道会拉伸以填满容器，因此有高度但没有行模板的网格会把高度分给各行。显式设置的值（`"start"`、`"center"`、`"space-between"` 等）按 CSS 的方式放置轨道。对齐类设置的值与 Tailwind CSS 完全相同：`content-start`（`align-content: flex-start`）和 `place-content-start` 把轨道放在起始处，`content-normal` 和 `justify-normal` 让轨道拉伸，与浏览器中一致。

`display: "block"` 使用 CSS 块布局（子元素依次堆叠，每个都与容器同宽），`display: "none"`（`.hidden()`）则把视图从布局中移除。

## 绝对定位

`position: "absolute"`（`.absolute()`）让视图脱离文档流，并根据 `top`、`right`、`bottom`、`left` 相对父元素定位：

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

偏移量接受点和百分比（Rust 中的 `.top(..)`、`.right(..)`、`.bottom(..)`、`.left(..)`、`.inset(..)`）。同时设置了 `left` 和 `right`（或 `top` 和 `bottom`）而没有设置尺寸的视图，会在两者之间拉伸。靠后的兄弟元素绘制在靠前的之上；`zIndex`（`.z_index(n)`）可以改变这个顺序。

## 测量

`onLayout`（`.on_layout(..)`）在每次布局导致视图 frame 变化后报告它相对父元素的 frame：

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

frame 的单位是点：Rust 中是 `Bounds<Points>`，TSX 中是 `Bounds`（`{ origin: { x, y }, size: { width, height } }`）。要获取整个窗口的大小，在 Rust 中读取 `window()`，在 TSX 中读取 [`nsh` 的设备 API](../modules/nsh.md#device) 的 `windowSize()`；两者都跟随旋转和窗口缩放变化，读取它们的样式会随窗口改变：

```rust tabs
view().style_when(|| window().width > px(600.0), |s| s.flex_row())
```

```tsx tabs
import { View } from "nsh";
import { windowSize } from "nsh";

<View style={{ flexDirection: windowSize().width > 600 ? "row" : "column" }} />
```

Tailwind 的断点（`sm:`、`md:` 等）以及 `portrait:` / `landscape:` 不用写代码就能达到同样的效果。

## 安全区域

根视图覆盖整个屏幕，包括状态栏和主屏幕指示条下方的区域。用 CSS 的 `env()` 按安全区域的 inset 为页面加内边距（`paddingTop: "env(safe-area-inset-top)"`、Tailwind `pt-[env(safe-area-inset-top)]`、Rust 中 `.p_safe_area()`；见[安全区域](../elements/safe-area.md)）；也可以在 Rust 中用 `safe_area()`、在 TSX 中用 `safeArea()` / `safeAreaInsets()` 读取 inset 自行处理。[导航栈](./navigation.md)中的页面本身已经位于标题栏下方。

## 从右到左

应用的布局方向跟随系统语言，视图的 `direction` 样式（`"ltr"`、`"rtl"` 或 `"inherit"`；Rust 中为 `.direction(LayoutDirection::Rtl)`）设置其子树的方向。当应用以从右到左方式布局时：

- 行从右侧开始排列；
- `left` 和 `right` 样式键（外边距、内边距、位置、边框、圆角）与 React Native 一样左右互换；Tailwind 的物理方向类则与浏览器一样保持原侧：`pl-4`、`ml-2`、`left-0`、`border-l`、`rounded-tl-lg` 和 `text-left` 仍在左侧（`ps-4`、`ms-2`、`start-0`、`border-s`、`rounded-ss-lg` 和 `text-start` 跟随方向）；
- `start` 和 `end` 属性始终表示起始侧和结束侧：`marginStart`、`marginEnd`、`paddingStart`、`paddingEnd`、`start`、`end`、`borderStartWidth`、`borderTopStartRadius` 等（Rust 中的 `.ms(..)`、`.me(..)`、`.ps(..)`、`.pe(..)`、`.border_s(..)`、`.rounded_ss(..)` 等）；
- `textAlign: "auto"` 的文字右对齐，原生控件也会镜像。

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

方向的变化（语言的或视图的）会立即生效，无需重启。`direction` 样式也可以让单个视图及其子元素保持自己的方向，例如让电话号码保持从左到右。在 Android 上，嵌入 NSH 的应用需要在 manifest 中设置 `android:supportsRtl="true"`，原生控件才会镜像。

## 相关内容

- [样式](./styling.md)：样式如何组合。
- [滚动](./scrolling.md)和[列表](./lists.md)：超出屏幕的内容。
- [样式参考](../modules/style-reference.md)：所有布局属性及其类型。
