---
title: ColorPicker
description: "ColorPicker 组件及其部件：在饱和度与明度区域上、在 RGB、HSL、HSB 或 OKLCH 任一通道及透明度的滑块上选取颜色，以任意 CSS 形式输入、从色板中挑选，或用吸管在屏幕上取色；支持 WAI-ARIA 按键，对屏幕阅读器是可调节元素；布局和样式由应用决定。"
group: base
demo: el-color-picker
---

# ColorPicker

颜色选择器持有一个颜色，放在其中的部件显示并修改它：饱和度与明度的 `ColorArea`，RGB、HSL、HSB 或 OKLCH 任一通道及透明度的
`ColorSlider`，以文本接受整个颜色或以数字接受一个通道的 `ColorField`，预设颜色的 `ColorSwatch`，以及在屏幕任意位置取色的 `ColorEyeDropper`。应用用自己的元素排布这些部件（每个通道一行，带上字母；用
`Tabs` 切换色彩空间；把选择器放进 `Popover`），并为每个部件设置样式：部件绘制通道的颜色，尺寸、圆角、边框和阴影都由应用决定。

```rust tabs
use nsh_base::{
    ColorChannel, ColorPickerEvent, ColorSpace, color_area, color_field, color_picker,
    color_slider, color_swatch, theme,
};
use nsh_core::prelude::*;

fn primary(color: Signal<Hsla>) -> impl IntoElement {
    // A channel of OKLCH: its letter, its slider, its number.
    let channel = move |channel: ColorChannel, letter: &'static str| {
        view()
            .flex_row()
            .items_center()
            .gap_2()
            .child(text(letter).w(px(14.0)).text_sm().text_color(move || theme().muted_foreground))
            .child(
                color_slider()
                    .color_space(ColorSpace::Oklch)
                    .channel(channel)
                    .accessibility_label(letter)
                    .flex_1()
                    .h(px(18.0))
                    .justify_center()
                    .px(px(8.0))
                    .track_style(|s| s.h(px(10.0)).rounded_full())
                    .thumb_style(|s| s.size(px(16.0)).rounded_full().border_2().border_color(white()))
                    .fill_thumb(true),
            )
            .child(
                color_field()
                    .color_space(ColorSpace::Oklch)
                    .channel(channel)
                    .accessibility_label(letter)
                    .w(px(64.0))
                    .h(px(28.0))
                    .px_2()
                    .rounded_md()
                    .border_1()
                    .border_color(move || theme().border)
                    .text_sm(),
            )
    };
    color_picker()
        .value(move || Some(color.get()))
        .on_change(move |e: &ColorPickerEvent| {
            if let ColorPickerEvent::Change(value, _) = e {
                color.set(*value);
            }
        })
        .gap_3()
        .child(
            color_area()
                .accessibility_label("Saturation and brightness")
                .h(px(160.0))
                .panel_style(|s| s.rounded_lg())
                .thumb_style(|s| s.size(px(18.0)).rounded_full().border_2().border_color(white()))
                .fill_thumb(true),
        )
        .child(channel(ColorChannel::Lightness, "L"))
        .child(channel(ColorChannel::Chroma, "C"))
        .child(channel(ColorChannel::Hue, "H"))
        .child(color_swatch().size(px(28.0)).rounded_md())
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { type ColorChannel, ColorArea, ColorField, ColorPicker, ColorSlider, ColorSwatch } from "nsh/base";

const thumb = "rounded-full border-2 border-white";

function Channel(props: { channel: ColorChannel; letter: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <Text class="w-[14px] text-sm text-muted-foreground">{props.letter}</Text>
      <ColorSlider
        colorSpace="oklch"
        channel={props.channel}
        accessibilityLabel={props.letter}
        class="flex-1 h-[18px] justify-center px-2"
        trackClass="h-[10px] rounded-full"
        thumbClass={`size-4 ${thumb}`}
        fillThumb
      />
      <ColorField
        colorSpace="oklch"
        channel={props.channel}
        accessibilityLabel={props.letter}
        class="w-16 h-7 px-2 rounded-md border border-border text-sm text-right"
      />
    </View>
  );
}

function App() {
  const primary = signal("oklch(54.6% 0.215 262.9)");
  return (
    <ColorPicker value={primary()} format="oklch" onChange={({ formatted }) => primary.set(formatted)} class="gap-3">
      <ColorArea accessibilityLabel="Saturation and brightness" class="h-40" panelClass="rounded-lg" thumbClass={`size-[18px] ${thumb}`} fillThumb />
      <Channel channel="lightness" letter="L" />
      <Channel channel="chroma" letter="C" />
      <Channel channel="hue" letter="H" />
      <View class="flex-row items-center gap-2">
        <ColorSwatch class="size-7 rounded-md" />
        <Text class="font-mono text-sm">{`--primary: ${primary()}`}</Text>
      </View>
    </ColorPicker>
  );
}

mount(App);
```

`ColorPicker`、`ColorArea`、`ColorSlider`、`ColorField`、`ColorSwatch` 和 `ColorEyeDropper` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中即
`nsh-base` crate。Rust 中 `color_picker()` 及各部件的函数创建它们，每个 prop 有一个 setter（`.channel(..)`、`.thumb_style(..)`），每个事件有一个监听方法（`.on_change(..)`），另有类型化的样式方法；颜色是
`Hsla`，色彩空间、通道和格式分别是 `ColorSpace`、`ColorChannel` 和 `ColorFormat`。

## 值

颜色是 CSS 颜色：十六进制（`#3b82f6`，带透明度的 `#3b82f680`）、`rgb()`、`hsl()`、`hsb()`、`oklch()` 或 CSS 颜色名；Rust 中是
`Hsla`。应用通过 `value` 持有它，并设置 `onChange` 报告的颜色，与 `nsh/base` 的其他控件一样；也可以用 `defaultValue` 把颜色交给选择器自己保存，照样收到变化。

- `onChange({ value, formatted })` 报告用户要的每个颜色：拖动区域或滑块的每一步、每次按键、在字段中输入的数字、按下的色板。`value` 是颜色，`formatted`
  是按 `format`（`"hex"`、`"rgb"`、`"hsl"`、`"hsb"` 或 `"oklch"`）写出的同一颜色，可以直接保存或设为 token。
- `onChangeEnd({ value, formatted })` 报告一次变化结束时的颜色，只报一次：指针抬起时、每次按键后、字段失去焦点或提交时、按下色板时。
- 选择器按用户设置的样子保存颜色在每个空间中的通道值。灰色保留色相和饱和度，所以色相滑块停在用户放下的位置；在 OKLCH 中编辑的颜色保留输入的明度、色度和色相，超出
  sRGB 时也一样（报告的颜色是 sRGB 能显示的最接近颜色，`"oklch"` 的 `formatted` 保留通道值）。
- 应用设置的、不是选择器报告的 `value` 会替换所有空间中的颜色。

## 色彩空间与通道

| `colorSpace` | 通道（`channel`） | 范围 |
|---|---|---|
| `"rgb"` | `"red"`、`"green"`、`"blue"` | 0 到 255 |
| `"hsl"` | `"hue"`、`"saturation"`、`"lightness"` | 色相 0 到 360，其余 0 到 100 |
| `"hsb"` | `"hue"`、`"saturation"`、`"brightness"` | 色相 0 到 360，其余 0 到 100 |
| `"oklch"` | `"lightness"`、`"chroma"`、`"hue"` | 明度 0 到 100（步长 0.1），色度 0 到 0.4（步长 0.001），色相 0 到 360（步长 0.1） |
| 任意 | `"alpha"` | 0 到 100 |

滑块的轨道在其他通道不变的前提下绘制本通道的颜色，因此能看出每个值通向哪里。空间里没有的通道按该空间的第一个通道处理（并给出警告）。

## Props

### ColorPicker

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | 无 | 颜色（受控）。应用设置 `onChange` 报告的颜色。 |
| `defaultValue` | `.default_value(..)` | `string` | `"#000000"` | 未设置 `value` 时的初始颜色；此后由选择器自己保存。 |
| `format` | `.format(..)` | `"hex" \| "rgb" \| "hsl" \| "hsb" \| "oklch"` | `"hex"` | `formatted` 写出颜色的方式。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 任何部件都不接受修改；`disabled:` 类作用于选择器及其部件。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 部件以及应用放在它们之间的元素。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 选择器本身：部件外面的列（或行）。 |

### ColorArea

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `panelClass`、`panelStyle` | `.panel_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 填满区域的面板：色相的颜色，饱和度从左到右、明度从下到上，按面板圆角裁剪。 |
| `thumbClass`、`thumbStyle` | `.thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 以颜色为中心的滑块。 |
| `fillThumb` | `.fill_thumb(..)` | `boolean` | `false` | 滑块背景为当前颜色。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受指针、键盘或屏幕阅读器的修改。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器为滑块读出的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 区域，尺寸由应用决定。 |

### ColorSlider

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `colorSpace` | `.color_space(..)` | `"rgb" \| "hsl" \| "hsb" \| "oklch"` | `"hsb"` | 通道所在的空间。 |
| `channel` | `.channel(..)` | `ColorChannel` | `"hue"` | 修改的通道：该空间的通道之一，或 `"alpha"`。 |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | 轨道方向：最小值在左边，或在底部。创建滑块时读取。 |
| `trackClass`、`trackStyle` | `.track_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 轨道：沿轨道绘制通道的颜色，按圆角裁剪；滑块放在轨道上。 |
| `thumbClass`、`thumbStyle` | `.thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 以数值为中心的滑块。 |
| `fillThumb` | `.fill_thumb(..)` | `boolean` | `false` | 滑块背景为当前颜色（透明度滑块上带透明度）。 |
| `checkerboardColor` | `.checkerboard_color(..)` | `string` | 无 | 轨道下棋盘格的颜色，透过透明度滑块的颜色显示出来。 |
| `checkerboardSize` | `.checkerboard_size(..)` | `number` | `4` | 棋盘格方块的边长。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受指针、键盘或屏幕阅读器的修改。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器为滑块读出的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 滑块：轨道外接受按压和拖动的区域。 |

### ColorField

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `channel` | `.channel(..)` | `ColorChannel` | 无 | 以数字接受的通道。不设置时，字段以文本接受整个颜色。 |
| `colorSpace` | `.color_space(..)` | `ColorSpace` | `"hsb"` | `channel` 所在的空间。 |
| `format` | `.format(..)` | `ColorFormat` | `"hex"` | 字段写出整个颜色的方式；读取时接受任意 CSS 形式。 |
| `placeholder` | `.placeholder(..)` | `string` | 无 | 字段为空时显示。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受输入。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器为字段读出的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<TextStyle>` | 无 | 字段本身，一个文本输入框。 |

通道字段在输入数字时即修改颜色，数值限制在通道范围内；整个颜色的字段在失去焦点或提交时，若文本能读成颜色才修改。离开字段时，值会按字段的形式重新写出。

### ColorSwatch

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `color` | `.color(..)` | `string` | 无 | 显示的颜色；按下时在外层选择器中选中它。不设置时显示选择器自己的颜色，作为预览。 |
| `selectedStyle` | `.selected_style(..)` | `StyleProp<ViewStyle>` | 无 | 它是选择器当前颜色时的样式，与 `selected:` 类相同。 |
| `checkerboardColor` | `.checkerboard_color(..)` | `string` | 无 | 半透明颜色下的棋盘格。 |
| `checkerboardSize` | `.checkerboard_size(..)` | `number` | `4` | 棋盘格方块的边长。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受按压。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 十六进制颜色 | 屏幕阅读器读出的内容。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 叠在颜色上的内容：选中色板上的对勾（`group-selected:`）。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 色板的尺寸、形状和边框；颜色按其圆角裁剪。 |

### ColorEyeDropper

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受按压。平台没有吸管时也处于禁用状态。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的内容。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 按钮的内容：应用的图标或文字。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 按钮本身。 |

按下时显示系统的吸管：macOS 上是 AppKit 的取色器，Web 上是浏览器的 `EyeDropper`（Chrome 和 Edge）。取到的颜色成为选择器的颜色（先报告
`onChange`，再报告 `onChangeEnd`）；按 Escape 则不取色。平台没有吸管时按钮处于禁用状态，用 `disabled:hidden` 即可在这些平台上隐藏它。

## 事件

| 事件 | 所属 | Rust | 参数 | 时机 |
|---|---|---|---|---|
| `onChange` | `ColorPicker` | `.on_change(\|e: &ColorPickerEvent\| ..)` | `({ value: string, formatted: string })` | 用户修改了颜色。 |
| `onChangeEnd` | `ColorPicker` | `.on_change_end(\|e: &ColorPickerEvent\| ..)` | `({ value: string, formatted: string })` | 一次修改结束，每次修改只报一次。 |
| `onPress` | `ColorSwatch` | `.on_press(\|color: &Hsla\| ..)` | `({ color: string })` | 色板被按下；色板也可以单独使用，作为调色板的色块。 |
| `onPick` | `ColorEyeDropper` | `.on_pick(\|color: &Hsla\| ..)` | `({ color: string })` | 用户在屏幕上取到了颜色；吸管也可以单独使用。 |

Rust 中 `ColorPickerEvent::Change(Hsla, SharedString)` 和 `ColorPickerEvent::ChangeEnd(Hsla, SharedString)` 携带颜色及其
`formatted` 文本。

## 部件

| 部件 | 位于 | 样式 |
|---|---|---|
| `ColorArea` | 选择器内 | `class`、`style` |
| 区域的面板 | 区域内，填满区域 | `panelClass`、`panelStyle` |
| 区域的滑块 | 区域内，以颜色为中心 | `thumbClass`、`thumbStyle` |
| `ColorSlider` | 选择器内 | `class`、`style` |
| 滑块的轨道 | 滑块内 | `trackClass`、`trackStyle` |
| 滑块的拇指 | 滑块内，以轨道上的数值为中心 | `thumbClass`、`thumbStyle` |
| `ColorField` | 选择器内 | `class`、`style` |
| `ColorSwatch` | 选择器内，或单独使用 | `class`、`style`、`selectedStyle` |
| `ColorEyeDropper` | 选择器内，或单独使用 | `class`、`style` |

通道两端的值对应轨道两端，滑块的拇指以这两端为中心。给滑块留出半个拇指宽度的内边距（`h-3` 轨道外用 `h-6 justify-center px-2.5`），拇指就完整地留在滑块内，两端都能接受按压。部件显示的状态：拖动时拇指的
`active:`，有键盘焦点时的 `focus:`，色板的 `selected:`，以及每个部件的 `disabled:`。

## 键盘

在 macOS 和 Web 上，每个拇指都是键盘焦点的一站（Tab）：

| 按键 | 滑块上 | 区域上 |
|---|---|---|
| Right、Up | 增加一步 | Right：饱和度增加；Up：明度增加 |
| Left、Down | 减少一步 | Left：饱和度减少；Down：明度减少 |
| Shift 加方向键 | 十步 | 十步 |
| Page Up、Page Down | 十步 | 明度十步 |
| Home、End | 通道的两端 | |

色板接受 Space 和 Return。每次按键先报告 `onChange`，再报告 `onChangeEnd`；按住方向键会重复。

## 无障碍

- 区域和每个滑块的拇指都是可调节元素（`"adjustable"`，浏览器中为 slider），带有标签、数值和范围；屏幕阅读器的增加、减少操作会逐步调节它们。
- 每个字段是带标签的文本框；每个色板是按钮，是选择器当前颜色时为选中状态，未设置 `accessibilityLabel` 时以十六进制颜色命名。吸管是带应用所给标签的按钮。
- 禁用时，屏幕阅读器会说明部件已变暗，部件不接受任何操作。

标签、角色和操作的通用说明见[无障碍](../docs/accessibility.md)。

## 平台说明

- 每个平台都绘制应用设置的样式；轨道和面板的颜色是平台绘制的渐变。按压和拖动由核心跟踪，鼠标、触控笔和手指都适用；外层的滚动视图只处理从别处开始的拖动。
- `ColorEyeDropper` 在 macOS 上使用 AppKit 的取色器，在 Web 上使用浏览器的 `EyeDropper`；取到的颜色为 sRGB。
