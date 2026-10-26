---
title: 样式
description: Rust 中的类型化样式方法与 TSX 中的 style 属性：flexbox、grid 和 CSS 效果，包括颜色、边框、圆角、阴影、渐变、滤镜、变换和过渡，以及各平台的差异。
order: 32
group: ui
demo: guide-styling
---

# 样式

每个元素都使用同一套原生样式，有两种写法。在 Rust 中，样式是链式调用在元素上的类型化方法（`.p_4()`、`.rounded(px(12.0))`、`.bg(color)`）；在 TSX 中，是一个由 camelCase 属性组成的 `style` 属性，或 [Tailwind 类名](./tailwind.md)。两者都包括盒阴影、渐变、滤镜、轮廓线、过渡和 grid 等 CSS 能力，只有变化了的属性才会发送给原生视图。

CSS 值（颜色、长度、渐变、滤镜、阴影、变换、对齐关键字）的含义与浏览器中完全相同，每个 Rust 方法和 Tailwind 工具类设置的值也与 Tailwind CSS 4 生成的完全相同，因此你在 Web 上的经验可以直接沿用。未写出的属性取下文列出的默认值。

```rust tabs
view()
    .p_4()
    .rounded(px(12.0))
    .bg(white())
    .border_1()
    .border_color(rgb(0xd0d7de))
    .shadow([BoxShadow {
        offset_y: px(4.0),
        blur: px(12.0),
        color: rgba(0x0000001f).into(),
        ..BoxShadow::default()
    }])
    .child(
        text("Card")
            .text_size(px(17.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(0x1f2328)),
    )
```

```tsx tabs
<View
  style={{
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d0d7de",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  }}
>
  <Text style={{ fontSize: 17, fontWeight: "600", color: "#1f2328" }}>Card</Text>
</View>
```

本页介绍样式如何组合以及各种视觉属性。布局属性（flexbox、grid、尺寸、位置）见[布局](./layout.md)，文本属性见[文本](./text.md)，所有属性及其类型列在[样式参考](../modules/style-reference.md)中。

## 组合样式

在 Rust 中，共享样式就是接收元素并返回加好样式的元素的函数，条件就是普通的 Rust：创建元素时已知的条件用 `.when(condition, |v| ..)`，运行时切换的样式用 `.style_when(signal, |s| ..)`。在 TSX 中，`style` 接受一个对象，或者一个从左到右合并的对象数组；假值项（`false`、`null`、`undefined`）会被跳过，这让条件样式写起来很简短：

```rust tabs
fn button(danger: bool, busy: Signal<bool>) -> View {
    view()
        .px_4()
        .py(px(10.0))
        .rounded(px(10.0))
        .bg(rgb(0x0969da))
        .when(danger, |v| v.bg(rgb(0xcf222e)))
        .style_when(busy, |s| s.opacity(0.4))
}
```

```tsx tabs
const styles = {
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: "#0969da" },
  disabled: { opacity: 0.4 },
  danger: { backgroundColor: "#cf222e" },
} as const;

<View style={[styles.button, props.danger && styles.danger, busy() && styles.disabled]} />
```

在 TSX 中，把共享的样式定义为组件外部的常量（加上 `as const`，让 TypeScript 保留 `"row"` 这样的字面量类型）。一个普通对象就够了：样式在每次设置时由 Rust 解析，对象无需事先注册。

读取 signal 的样式会跟随 signal 变化：在 Rust 中给方法传一个闭包（`.bg(move || ..)`），signal 变化时只重新设置这一个属性；在 TSX 中，读取 signal 的样式表达式会重建，NSH 只发送值不同的属性：

```rust tabs
view()
    .p_3()
    .bg(move || if selected.get() { rgb(0xddf4ff) } else { rgb(0xffffff) })
```

```tsx tabs
<View style={{ backgroundColor: selected() ? "#ddf4ff" : "#ffffff", padding: 12 }} />
```

TSX 元素同时有 `style` 和 `class` 时，`style` 优先：先应用类名，再在其上叠加内联样式。值为 `undefined` 的键不设置任何东西（`backgroundColor: active ? accent : undefined` 在未激活时保留类名的颜色）；`null` 则设为默认值。在 Rust 中，同一属性后调用的方法优先于先调用的。

在同一个样式中（一个对象，或合并成一个对象的数组），键的顺序不影响结果。与 React Native 一样，更具体的属性优先于它的简写：`borderTopWidth` 优先于 `borderWidth`，`borderLeftColor` 优先于 `borderColor`，`marginTop` 优先于 `marginVertical`、再优先于 `margin`（padding 同理），`rowGap` 优先于 `gap`，`flexGrow` 优先于 `flex`，`gridColumnStart` 优先于 `gridColumn`。在其中把具体属性设为 `null` 时，显示简写的值。

## 单位与取值

- **长度的单位是点**（与密度无关的像素）：Rust 中的 `px(100.0)` 和 TSX 中的 `width: 100` 都是 100pt，在 2× 或 3× 屏幕上分别是 200 或 300 个物理像素。
- **百分比**（Rust 中的 `relative(0.5)`，TSX 中的 `"50%"`）相对于父视图，可用于尺寸、位置、外边距和内边距（[布局](./layout.md)）。
- **角度**在 Rust 中是 `deg(45.0)`、`radians(0.5)` 或 `turn(0.25)`，在 TSX 中是以数字表示的度数，或带单位的字符串：`45`、`"45deg"`、`"0.5rad"`。
- **时长**是毫秒数：Rust 中的 `.duration(150.0)`，TSX 中的数字或字符串（`"150ms"`、`"0.2s"`）。

## 默认值

NSH 的默认值与 Web 不同：

| | 默认值 |
|---|---|
| `flexDirection` | `"column"` |
| `flexShrink` | `0`（子视图不会收缩，除非显式要求） |
| `alignContent` | `"flex-start"`（网格中为 CSS 的 `"normal"`） |
| `position` | `"relative"` |
| `minWidth` / `minHeight` | `0` |
| `backgroundColor` | 透明 |
| 文本 | 黑色，14pt，字重 400 |
| `shadowOffset` / `shadowRadius` / `shadowOpacity` | `{ width: 0, height: -3 }` / `3` / `0` |

新视图在你设置样式之前不携带任何样式，因此没有样式的包装视图在原生侧没有开销。

## 颜色

在 Rust 中，颜色是类型化的值：`rgb(0x0099ff)`、`rgba(0x0099ffcc)`、`hsla(..)`、`white()`、`black()`，以及 `nsh_core::element::palette` 中的 Tailwind 调色板（`BLUE.shade(500)`）。颜色方法接受 `AdaptiveColor`，即一个浅色值和一个深色值：`AdaptiveColor::rgb(0xffffff, 0x0d1117)` 以原生方式随系统外观切换，无需重新渲染。来自应用主题的颜色（`nsh_base` 的 `theme().primary`）同样会自适应（[Rust](./rust.md#主题)）。

在 TSX 中，颜色属性接受 CSS 颜色字符串：

| 形式 | 示例 |
|---|---|
| 十六进制 | `"#09f"`、`"#09fc"`、`"#0099ff"`、`"#0099ffcc"` |
| `rgb()` / `rgba()` | `"rgb(0, 153, 255)"`、`"rgba(0, 0, 0, 0.5)"`、`"rgb(0 0 0 / 10%)"` |
| `hsl()` / `hsla()` | `"hsl(210 100% 50%)"` |
| `oklch()` / `oklab()` | `"oklch(62.3% 0.214 259.8)"` |
| 颜色名 | `"white"`、`"black"`、`"transparent"`、`"rebeccapurple"` 等 |

在 TSX 中要支持深色模式，可以读取 `nsh` 中的 [`colorScheme()`](../modules/nsh.md#device)（一个跟随系统外观的访问器），或使用 Tailwind 的 `dark:` 变体：

```rust tabs
view()
    .flex_1()
    .bg(AdaptiveColor::rgb(0xffffff, 0x0d1117))
    .child(text("Follows the system appearance").text_color(AdaptiveColor::rgb(0x1f2328, 0xe6edf3)))
```

```tsx tabs
import { Text, View } from "nsh";
import { colorScheme } from "nsh";

const palette = () =>
  colorScheme() === "dark"
    ? { background: "#0d1117", text: "#e6edf3" }
    : { background: "#ffffff", text: "#1f2328" };

<View style={{ flex: 1, backgroundColor: palette().background }}>
  <Text style={{ color: palette().text }}>Follows the system appearance</Text>
</View>
```

对于颜色以外的样式，Rust 中的 `.dark(|s| ..)` 在深色外观下应用样式，`dark()` 读取当前外观。两种外观下默认文本颜色都是黑色：支持深色模式的应用需要显式设置颜色。

## 边框与圆角

```rust tabs
view()
    .border_1()
    .border_color(rgb(0xd0d7de))
    .border_dashed()               // .border_solid() | .border_dashed() | .border_dotted()
    .rounded(px(12.0))
    .rounded_tl(px(24.0))          // 按角设置，覆盖 .rounded(..)
    .border_b(px(3.0))             // 按边设置
    .border_b_color(rgb(0x0969da))
```

```tsx tabs
<View
  style={{
    borderWidth: 1,
    borderColor: "#d0d7de",
    borderStyle: "dashed",          // "solid" | "dashed" | "dotted"
    borderRadius: 12,
    borderTopLeftRadius: 24,        // per corner, overrides borderRadius
    borderBottomWidth: 3,           // per side
    borderBottomColor: "#0969da",
  }}
/>
```

- **宽度和颜色**可按边设置：`borderTopWidth`、`borderRightWidth`……`borderTopColor`……；以及跟随方向的 `borderStartWidth`、`borderEndWidth`、`borderStartColor`、`borderEndColor`（Rust 中的 `.border_t(..)`、`.border_t_color(..)`、`.border_s(..)`、`.border_e_color(..)` 等）。
- **圆角半径**可按角设置：`borderTopLeftRadius`、`borderTopRightRadius`、`borderBottomRightRadius`、`borderBottomLeftRadius`，以及跟随[布局方向](./layout.md)的 `borderTopStartRadius` / `borderTopEndRadius` / `borderBottomStartRadius` / `borderBottomEndRadius`（Rust 中的 `.rounded_tl(..)` 等、`.rounded_ss(..)`、`.rounded_se(..)`、`.rounded_es(..)`、`.rounded_ee(..)`，以及预设 `.rounded_lg()`、`.rounded_full()` 等）。
- **`borderCurve: "continuous"`**（`.border_curve(BorderCurve::Continuous)`）绘制曲率平滑过渡到边的圆角，就像 iOS 应用图标，两个平台都支持。胶囊形状（`borderRadius` 为高度的一半）依然是胶囊。
- **`overflow: "hidden"`**（`.overflow_hidden()`）把子视图裁剪到圆角形状内。裁掉的部分在布局上同样被裁掉：它不会进入外层滚动视图的内容尺寸，所以一个盒子把子视图按更大的尺寸排版、再用 `transform` 缩小（transform 不影响布局）时，不会让滚动视图多出可滚动的范围。

超过边长一半的半径会被截断，所以 `borderRadius: 9999`（`.rounded_full()`）会得到圆形或胶囊。

## 阴影

有三种投射阴影的方式：

```rust tabs
// shadow* 属性。
view()
    .shadow_color(black())
    .shadow_opacity(0.2)
    .shadow_radius(px(8.0))
    .shadow_offset(point(px(0.0), px(4.0)))

// CSS box-shadow：多层，支持扩展和内阴影。
view().shadow([
    BoxShadow { offset_y: px(1.0), blur: px(2.0), color: rgba(0x00000014).into(), ..BoxShadow::default() },
    BoxShadow { offset_y: px(8.0), blur: px(24.0), color: rgba(0x0000001f).into(), ..BoxShadow::default() },
])
view().shadow([BoxShadow { offset_y: px(2.0), blur: px(4.0), color: rgba(0x00000026).into(), inset: true, ..BoxShadow::default() }])

// Android 的 Material elevation。
view().elevation(px(6.0)).bg(white()).rounded(px(12.0))
```

```tsx tabs
// The shadow* properties
<View style={{ shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }} />

// CSS box-shadow: several, comma separated, with spread and inset
<View style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12)" }} />
<View style={{ boxShadow: "inset 0 2px 4px rgba(0,0,0,0.15)" }} />

// Android's material elevation (a prop, not a style)
<View android={{ elevation: 6 }} style={{ backgroundColor: "#ffffff", borderRadius: 12 }} />
```

`boxShadow` 遵循 CSS 语法：`offsetX offsetY blur spread color`，`inset` 表示内阴影。阴影会贴合视图的圆角形状。Tailwind 的阴影预设在 Rust 中是 `.shadow_sm()`、`.shadow_md()`、`.shadow_lg()` 等。

> [!NOTE]
> 在 Android 上，阴影需要背景：背景透明的视图（例如没有背景的文本）不会投射阴影。`elevation` 的颜色取自 `shadowColor`。

## 渐变

`backgroundImage` 接受 CSS 渐变，绘制在背景色之上；在 Rust 中是 `.bg_linear(angle)`、`.bg_radial()` 和 `.bg_conic(angle)`，配合色标 `.gradient_from(..)`、`.gradient_via(..)` 和 `.gradient_to(..)`，与 Tailwind 的 `bg-linear-*` 加 `from-*`、`via-*`、`to-*` 相同。在 TSX 中，多个渐变用逗号分隔。

```rust tabs
view().h(px(120.0)).rounded(px(16.0)).bg_linear(deg(135.0)).gradient_from(rgb(0x54aeff)).gradient_to(rgb(0x8250df))
view().bg_radial().gradient_from(rgb(0xfff8c5)).gradient_to(rgb(0xfd8c73))
view().bg_conic(deg(0.0)).gradient_from(rgb(0xff0000)).gradient_via(rgb(0x00ff00)).gradient_to(rgb(0x0000ff))
view()
    .bg_linear_to_r()
    .gradient_from(rgb(0x8250df))
    .gradient_from_position(percentage(0.3))
    .gradient_to(rgb(0x54aeff))
    .gradient_to_position(percentage(0.3))
```

```tsx tabs
<View style={{ height: 120, borderRadius: 16, backgroundImage: "linear-gradient(135deg, #54aeff, #8250df)" }} />
<View style={{ backgroundImage: "radial-gradient(circle at top left, #fff8c5, #fd8c73)" }} />
<View style={{ backgroundImage: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }} />
<View style={{ backgroundImage: "linear-gradient(90deg, #8250df 0 12px, #54aeff 12px)" }} />
```

线性和径向渐变的色标位置可以是百分比或长度（`px`、`pt`、`rem`；纯数字表示点），锥形渐变的色标位置可以是百分比或角度（`deg`、`turn`、`rad`、`grad`）。带两个位置的色标（`#8250df 0 12px`）是一段纯色，位置相同的两个色标也是。长度沿视图当前尺寸下的渐变线计算，因此视图尺寸变化时，12px 的色带始终是 12px 宽。

色标之间的颜色与 CSS 一样混合：在渐变指定的色彩空间中（`linear-gradient(in oklab, …)`；还有 `srgb`、`srgb-linear`、`xyz`、可带色相方法（如 `longer hue`）的 `oklch` 以及 `hsl`）；未指定时，若所有颜色都是十六进制、`rgb()`、`hsl()` 或具名颜色，则在 sRGB 中混合，若有颜色是 `oklch()`、`oklab()`、`lab()`、`lch()` 或 `color()`，则在 Oklab 中混合。

在 iOS 上，文本元素不绘制渐变。

## 滤镜与混合

| 属性 | 取值 | Rust |
|---|---|---|
| `filter` | 作用于视图及其内容的 CSS 滤镜：`brightness()`、`contrast()`、`grayscale()`、`hue-rotate()`、`invert()`、`saturate()`、`sepia()`、`opacity()`、`blur()`、`drop-shadow()`；多个之间用空格分隔 | `.brightness(n)`、`.contrast(n)`、`.grayscale(n)`、`.hue_rotate(angle)`、`.invert(n)`、`.saturate(n)`、`.sepia(n)`、`.blur(px(..))` |
| `backdropFilter` | 作用于视图背后内容的滤镜：`"blur(10px)"`（毛玻璃） | `.backdrop_blur(px(10.0))`、`.backdrop_saturate(n)` 等 |
| `glassEffect` | `"regular"` 或 `"clear"`，在 iOS 26 及更高版本绘制 Apple 的 Liquid Glass；`"none"`（默认值）使用 `backdropFilter` | `ViewStyle::glass_effect`（`GlassEffect`） |
| `mixBlendMode` | 视图与其背后内容的混合方式：`"multiply"`、`"screen"`、`"overlay"` 等 | `.mix_blend_mode(BlendMode::Multiply)` |

```rust tabs
image(photo).size(px(120.0)).grayscale(1.0).contrast(1.2)
view()
    .absolute()
    .bottom_0()
    .left_0()
    .right_0()
    .p_3()
    .bg(rgba(0xffffff66))
    .backdrop_blur(px(12.0))
```

```tsx tabs
<Image src={photo} style={{ width: 120, height: 120, filter: "grayscale(1) contrast(1.2)" }} />
<View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 12, backgroundColor: "rgba(255,255,255,0.4)", backdropFilter: "blur(12px)" }} />
```

各平台的支持情况不同：

| | iOS | Android |
|---|---|---|
| 视图上的 `filter` | 仅支持 `opacity`、不超过 1 的 `brightness` 和 `drop-shadow` | Android 12（API 31）起全部支持；更低版本仅支持颜色滤镜 |
| 图片上的 `filter` | 所有颜色滤镜以及 `blur` | 与视图相同 |
| `backdropFilter` | 系统模糊材质，近似给定半径 | Android 12（API 31）起支持 |
| `mixBlendMode` | 支持 | Android 10（API 29）起支持 |

Web、Windows 和 Linux 对视图应用所有滤镜，macOS 与 iOS 相同；GPUI 绘制颜色滤镜和 `drop-shadow()`。背景滤镜在 iOS、macOS 和 Android 上是模糊，在 Web 和 Windows 上支持所有滤镜；Linux 和 GPUI 不绘制背景滤镜，GPUI 以普通混合模式绘制视图。对于包含多个 `drop-shadow()` 的 `filter`，iOS、macOS 和 Android 绘制最后一个。`mixBlendMode` 让视图与其后绘制的一切混合。

在 iOS 上，`ios={{ backdropMaterial: "regular" }}` 选择 `backdropFilter` 模糊所使用的系统材质。
可选值为 `"ultraThin"`（默认）、`"thin"`、`"regular"`、`"thick"` 和 `"chrome"`。
与正数模糊半径配合使用即可显示材质。Rust 使用 `.backdrop_material(BackdropMaterial::Regular)`
与 `.backdrop_blur(px(30.0))`。半径用于近似控制材质强度：NSH 按比例应用所选材质，
在 30 点达到完整强度。浅色或深色变体由视图的背景色决定。
这些选项对应 Apple 的[系统模糊材质](https://developer.apple.com/documentation/uikit/uiblureffect/style/systemmaterial)。

```rust tabs
view().backdrop_blur(px(30.0)).backdrop_material(BackdropMaterial::Regular)
```

```tsx tabs
<View ios={{ backdropMaterial: "regular" }} style={{ height: 64, backdropFilter: "blur(30px)" }} />
```

`glassEffect` 在 iOS 26 及更高版本中，于视图内容背后绘制 Liquid Glass。`"regular"` 使用标准材质，
`"clear"` 从背景获取的颜色更少。配合 `backdropFilter`，可在更早的 iOS 版本及其他平台上显示模糊效果。
玻璃层随视图的尺寸和圆角更新。

```tsx
<View style={{ height: 80, borderRadius: 16, backdropFilter: "blur(12px)", glassEffect: "regular" }} />
```

## 轮廓线、不透明度与可见性

- `outlineWidth`、`outlineColor`、`outlineStyle`、`outlineOffset`（`.outline(..)`、`.outline_color(..)`、`.outline_dashed()`、`.outline_offset(..)`）：边框之外、不占空间的一条线（负偏移会画在内侧）。与 CSS 一样，`outlineStyle: "none"`（或 `"hidden"`，`.outline_none()`）会隐藏轮廓，无论宽度是多少。
- `opacity`（`.opacity(n)`）：0 到 1，作用于视图及其子视图。
- `visibility: "hidden"`：视图不绘制，但保留所占空间；与浏览器中一样，屏幕阅读器也会跳过它及其子树。`display: "none"`（`.hidden()`）则将它移出布局。
- `zIndex`（`.z_index(n)`）：在兄弟视图中的顺序，也是原生的层叠顺序（值相同时保持稳定）。
- `cursor`（`.cursor(..)`、`.cursor_pointer()`）：鼠标指针在视图上的形状，用于指针设备和桌面平台。

## 变换

在 Rust 中，变换是方法（`.translate_x(..)`、`.rotate(..)`、`.scale(..)` 等），按 Tailwind 的顺序组合；在 TSX 中，`transform` 是一个步骤列表，与 CSS 一样从右到左应用：

```rust tabs
view().translate_x(px(20.0)).rotate(deg(-8.0)).scale(0.9)
view().perspective(px(600.0)).child(view().rotate_y(deg(35.0)).backface_hidden())
view().origin_top_left().rotate(deg(30.0))
```

```tsx tabs
<View style={{ transform: [{ translateX: 20 }, { rotate: "-8deg" }, { scale: 0.9 }] }} />
<View style={{ transform: [{ perspective: 600 }, { rotateY: "35deg" }], backfaceVisibility: "hidden" }} />
<View style={{ transformOrigin: "top left", transform: [{ rotate: "30deg" }] }} />
```

可用步骤：`translateX`、`translateY`、`scale`、`scaleX`、`scaleY`、`rotate`（`rotateZ`）、`rotateX`、`rotateY`、`skewX`、`skewY`、`perspective`。Rust 的 `.perspective(..)` 是 CSS 的 `perspective` 属性，与 Tailwind 的 `perspective-*` 相同：它给视图的子视图景深。`transformOrigin` 接受关键字、百分比和长度（`"top left"`、`"50% 0"`、`[10, 20]`；Rust 中的 `.origin_top_left()`、`.transform_origin(..)`），默认为中心。变换不影响布局：兄弟视图的位置按视图未变换时计算。

Android 不支持斜切（skew）变换。

## 过渡

只要指明要动画的属性，视图就会为自身样式的变化播放动画。动画在原生侧运行，每一帧都不会执行你的代码。

```rust tabs
let open = signal(false);

view()
    .on_press(move || open.update(|o| *o = !*o))
    .w(px(150.0))
    .h(px(72.0))
    .rounded(move || px(if open.get() { 36.0 } else { 12.0 }))
    .bg(move || if open.get() { rgb(0x8250df) } else { rgb(0x54aeff) })
    .translate_x(move || px(if open.get() { 120.0 } else { 0.0 }))
    .transition_all()
    .duration(300.0)
    .ease_in_out()
```

```tsx tabs
<View
  onPress={() => open.set(!open())}
  style={{
    width: 150,
    height: 72,
    borderRadius: open() ? 36 : 12,
    backgroundColor: open() ? "#8250df" : "#54aeff",
    transform: [{ translateX: open() ? 120 : 0 }],
    transitionProperty: "all",
    transitionDuration: 300,
    transitionTimingFunction: "ease-in-out",
  }}
/>
```

| 属性 | 取值 | Rust |
|---|---|---|
| `transitionProperty` | 要动画的属性：`"all"`，或用逗号分隔的名称：颜色（`"colors"`、`"backgroundColor"`、`"borderColor"` 等）、`"opacity"`、`"transform"`、`"boxShadow"`、`"borderRadius"` / `"borderWidth"` | `.transition()`、`.transition_all()`、`.transition_colors()`、`.transition_opacity()`、`.transition_transform()`、`.transition_shadow()` |
| `transitionDuration` | `300`、`"300ms"`、`"0.3s"` | `.duration(300.0)` |
| `transitionDelay` | 同时长 | `.delay(100.0)` |
| `transitionTimingFunction` | `"linear"`、`"ease"`、`"ease-in"`、`"ease-out"`、`"ease-in-out"`、`"cubic-bezier(x1, y1, x2, y2)"` | `.ease_linear()`、`.ease_in()`、`.ease_out()`、`.ease_in_out()`、`.ease_bezier(x1, y1, x2, y2)` |

尺寸和位置属于布局而不是样式，不会产生过渡；要为布局变化做动画，使用 `LayoutAnimation`，或用原生动画驱动数值（[动画](./animation.md)）。

### 关键帧动画

`animationName` 以原生方式运行 Tailwind 内置的关键帧动画之一：`"spin"`、`"ping"`、`"pulse"` 或 `"bounce"`，配合 `animationDuration`、`animationDelay`、`animationTimingFunction` 和 `animationIterationCount`（数字或 `"infinite"`），顺序不限。在 Rust 中，`.animate_spin()`、`.animate_ping()`、`.animate_pulse()` 和 `.animate_bounce()` 以 Tailwind 的时间参数运行它们，`.animation(KeyframeAnimation::new(..))` 则使用你自己的参数：

```rust tabs
view()
    .size(px(24.0))
    .rounded(px(4.0))
    .bg(rgb(0x0969da))
    .animation(KeyframeAnimation::new(Keyframes::Spin).duration(1000.0).easing([0.0, 0.0, 1.0, 1.0]))
```

```tsx tabs
<View style={{ width: 24, height: 24, borderRadius: 4, backgroundColor: "#0969da", animationName: "spin", animationDuration: 1000, animationIterationCount: "infinite", animationTimingFunction: "linear" }} />
```

## 按压反馈

按压反馈是应用为按下状态设置的样式，由原生应用，无需与你的代码往返；悬停、聚焦和禁用状态也以同样方式设置样式（Rust 中的 `.hover(..)`、`.focus(..)`、`.disabled_style(..)`；TSX 中的 `hoverStyle`、`focusStyle` 和 `disabledStyle`，或 `hover:`、`focus:`、`disabled:`）：

| Rust | TSX | 按下时的效果 |
|---|---|---|
| `.active(\|s\| s.opacity(0.6))` | `activeStyle={{ opacity: 0.6 }}` | 视图淡化到该不透明度 |
| `.active(\|s\| s.bg(rgb(0xeaeef2)))` | `activeStyle={{ backgroundColor: "#eaeef2" }}` | 背景变为该颜色 |
| `.ripple(Ripple { color: Some(rgba(0x00000022).into()), ..Ripple::default() })` | `android={{ ripple: { color: "#0002" } }}` | Android 的 Material 水波纹 |
| `.active(\|s\| s.bg(ZINC.shade(100)).scale(0.95))` | `class="active:bg-zinc-100 active:scale-95"` | 任意样式 |

参见[触摸与手势](./touch-and-gestures.md)。

## 相关内容

- [Tailwind](./tailwind.md)：以类名表达同样的样式，并提供深色模式、按下状态和断点等变体，以及它们对应的类型化写法。
- [布局](./layout.md)和[文本](./text.md)。
- [样式参考](../modules/style-reference.md)：所有样式属性及其类型。
