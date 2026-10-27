---
title: Slider
description: "Slider 组件：沿轨道选取一个值或两个值组成的范围；支持触摸屏和鼠标的按压与拖动、WAI-ARIA 的滑块按键，每个滑块向屏幕阅读器报告自己的数值；轨道、指示条、范围和滑块由应用设置样式。"
order: 20.85
group: base
demo: el-slider
---

# Slider

滑块沿轨道选取一个值（音量、亮度），或两个值组成的范围，每个值一个滑块（价格区间）。它负责行为：按压轨道时，较近的滑块跳到按下的位置；拖动滑块时它跟随指针或手指；数值按
`step` 对齐；每个滑块都是键盘焦点的一站，可以用方向键移动，并且对屏幕阅读器是带自己数值的可调节元素。外观由应用决定：`Slider`
没有自己的颜色、尺寸、圆角或动效。它由轨道、轨道里的指示条、指示条上的范围和滑块，以及之后的子元素（标签、文字形式的数值）组成，每个部件都由应用设置样式。

```rust tabs
use nsh_base::{SliderValue, slider, theme};
use nsh_core::prelude::*;

fn strength(level: Signal<SliderValue>) -> impl IntoElement {
    let percent = move || format!("{}%", level.get().end());
    slider()
        .value(move || level.get())
        .accessibility_label("选项强度")
        .on_change(move |next: &SliderValue| level.set(*next))
        // The value in a column after the rail.
        .flex_row()
        .items_center()
        .gap_2()
        // An 8-point rail; the thumbs travel inside it.
        .track_style(|s| s.h(px(8.0)).flex_1().px(px(8.0)).rounded_full().bg(move || theme().muted))
        .indicator_style(|s| s.h_full())
        // The fill, from the rail's edge, fading into the thumb's tone.
        .range_style(|s| {
            s.ml(-px(8.0))
                .rounded_full()
                .bg_linear_to_r()
                .gradient_from(move || theme().primary)
                .gradient_to(move || theme().muted_foreground)
        })
        // A 16 x 8 pill sitting in the rail.
        .thumb_style(|s| {
            s.w(px(16.0))
                .h(px(8.0))
                .rounded_full()
                .bg(move || theme().muted_foreground)
                .hover(|s| s.brightness(1.1))
                .active(|s| s.brightness(1.25))
        })
        .child(
            text(percent)
                .w(px(42.0))
                .text_right()
                .text_xs()
                .tabular_nums()
                .text_color(move || theme().muted_foreground),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Slider } from "nsh/base";

function App() {
  const strength = signal(64);
  return (
    <Slider
      value={strength()}
      onChange={(next) => strength.set(next as number)}
      accessibilityLabel="选项强度"
      class="flex-row items-center gap-2"
      trackClass="h-2 flex-1 px-2 rounded-full bg-muted focus-within:ring-2 focus-within:ring-primary/36 focus-within:ring-offset-2 focus-within:ring-offset-background disabled:opacity-35"
      indicatorClass="h-full"
      rangeClass="-ml-2 rounded-full bg-linear-to-r from-primary via-primary to-muted-foreground"
      thumbClass="h-2 w-4 rounded-full bg-muted-foreground transition hover:brightness-110 active:brightness-125 focus:outline-none disabled:brightness-100 motion-reduce:transition-none"
      thumbStyle={{ boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.42)" }}
    >
      <Text class="w-[42px] text-right font-mono text-[11px] text-muted-foreground">{`${strength()}%`}</Text>
    </Slider>
  );
}

mount(App);
```

`Slider` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`slider()`
创建一个滑块，每个 prop 有一个 setter（`.value(..)`、`.thumb_style(..)`），每个事件有一个监听方法（`.on_change(..)`），滑块本身用带类型的样式方法设置，标签用
`.child(..)` 添加。它的值是 `SliderValue`：`Single(f64)` 或 `Range(f64, f64)`。

## 值

值是一个数字，或两个滑块的范围 `[start, end]`；值的形状决定有几个滑块。应用用 `value` 持有它，并设置 `onChange` 报告的值，和 `nsh/base`
的每个控件一样；也可以用 `defaultValue` 把值交给滑块自己保存，修改照样会报告给应用。

```tsx
const price = signal<[number, number]>([200, 800]);

<Slider
  value={price()}
  onChange={(next) => price.set(next as [number, number])}
  onChangeEnd={(next) => save(next)}
  min={0}
  max={1000}
  step={10}
  accessibilityLabel="最高价格"
  startAccessibilityLabel="最低价格"
/>;
```

- `onChange` 报告用户要的每个新值：按压轨道时、拖动的每一步、每次按键。每次报告都是一个新值。
- `onChangeEnd` 报告修改结束时的值，只报告一次：按压或拖动设置过值之后指针抬起时，以及每次按键或屏幕阅读器的步进之后（每一次都是完整的修改）。在这里保存或发送数值。
- 数值按 `step` 对齐，从 `min` 起算（`min={1} step={2}` 得到 1、3、5……），并保持在 `min` 和 `max` 之间；`max`
  总能取到，所以范围不是步长整数倍时最后一步更短。`step={0}` 可取任意值。
- 范围的两个滑块不会交叉：拖动的滑块停在另一个滑块处。从同一个值上的两个滑块开始拖动时，移动能朝指针方向走的那个。
- 显示的值是应用的值，限制在 `min` 和 `max` 之间（范围的两端按顺序），不在步长网格上的值显示在它所在的位置；用户下一次修改时对齐。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `number \| [number, number]` | 无 | 值（受控）：一个数字，或带两个滑块的范围。应用设置 `onChange` 报告的值。 |
| `defaultValue` | `.default_value(..)` | `number \| [number, number]` | `0` | 未设置 `value` 时的初始值；之后由滑块自己保存。 |
| `min` | `.min(..)` | `number` | `0` | 最小值。 |
| `max` | `.max(..)` | `number` | `100` | 最大值；小于 `min` 时取 `min`。 |
| `step` | `.step(..)` | `number` | `1` | 数值对齐的步长，从 `min` 起算；`0` 可取任意值。 |
| `scale` | `.scale(..)` | `"linear" \| "logarithmic"` | `"linear"` | 数值沿轨道的分布：均匀，或按数量级（从 1 到 1000，三分之一处是 10）。对数刻度需要 `min` 大于 0；`min` 更小时为线性。 |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | 轨道的方向：`min` 在左边，或在底部。创建滑块时读取。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 指针、键盘和屏幕阅读器都不能修改；`disabled:` 类作用于滑块及其部件。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器为滑块（范围时为终点的滑块）读出的内容。 |
| `startAccessibilityLabel` | `.start_accessibility_label(..)` | `string` | `accessibilityLabel` | 屏幕阅读器为范围起点的滑块读出的内容。 |
| `trackClass`、`trackStyle` | `.track_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 轨道：接收按压和拖动的区域。 |
| `indicatorClass`、`indicatorStyle` | `.indicator_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 指示条：映射数值的滑轨。 |
| `rangeClass`、`rangeStyle` | `.range_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 范围：从 `min` 到滑块（范围时在两个滑块之间），由滑块放置。 |
| `thumbClass`、`thumbStyle` | `.thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个滑块，以它的值为中心。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 轨道之后的内容：标签、文字形式的数值。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 滑块本身：包住轨道和标签的列（或行）。 |

## 事件

| 事件 | Rust | 参数 | 何时 |
|---|---|---|---|
| `onChange` | `.on_change(\|value: &SliderValue\| ..)` | `number \| [number, number]` | 用户要一个新值：按压轨道、拖动的一步、按键、屏幕阅读器的增加或减少。 |
| `onChangeEnd` | `.on_change_end(\|value: &SliderValue\| ..)` | `number \| [number, number]` | 修改结束：指针抬起，一次按键或屏幕阅读器的步进完成。每次修改一次。 |

## 部件

| 部件 | 位于 | 样式 |
|---|---|---|
| 滑块控件 | | `class`、`style` |
| 轨道 | 滑块控件内，第一个 | `trackClass`、`trackStyle` |
| 指示条 | 轨道内 | `indicatorClass`、`indicatorStyle` |
| 范围 | 指示条内，按数值放置 | `rangeClass`、`rangeStyle` |
| 滑块（范围时两个） | 指示条内，以它的值为中心 | `thumbClass`、`thumbStyle` |
| 标签 | 滑块控件内，轨道之后 | 它自己的元素（`children`） |

轨道接收按压和拖动。指示条的长度就是数值范围，`min` 在它的起始边（垂直时在底部）；滑块把范围和滑块放在指示条上，无论大小，滑块都以它的值为中心。有两种布局：

- 轨道就是滑轨（上面的例子）：`h-2 px-2 rounded-full bg-muted`，指示条 `h-full`。内边距让滑块在两端都留在滑轨内，范围的 `-ml-2` 让填充从滑轨自己的边缘开始。
- 轨道是包住滑轨的一条带，更高，在触摸屏上手指才容易按到：`h-8 justify-center`，指示条 `h-2 rounded-full`（垂直滑块用 `w-8 items-center` 和 `w-2 h-full`）。

部件显示的状态：

- 滑块：指针悬停时 `hover:`，拖动时 `active:`，获得键盘焦点时 `focus:`，以及 `disabled:`。
- 轨道：按压轨道并拖动时 `active:`；它是一个 `group`，所以指示条、范围和滑块可以用 `group-hover:` 和 `group-active:`。
- 每个部件：滑块禁用时 `disabled:`。

滑块随数值移动，拖动时立即跟随。滑块各状态的动效由应用决定（例如 `transition` 让滑块在 `hover:` 和 `active:` 时变亮），
`motion-reduce:` 为要求减少动效的用户保持静止。键盘焦点在滑块上，滑块带有 `focus:` 类时会报告它：这时轨道上的 `focus-within:` 给整条滑轨加上焦点环，滑块的 `focus:outline-none` 取代平台自带的焦点轮廓。

## 键盘

在 macOS 和 Web 上，每个滑块都是键盘焦点（Tab）的一站，获得焦点的滑块响应 WAI-ARIA 的滑块按键：

| 按键 | 作用 |
|---|---|
| 右、上 | 增加一步（垂直滑块也是）。 |
| 左、下 | 减少一步。 |
| Page Up、Page Down | 增加或减少范围的十分之一（沿刻度），至少一步。 |
| Home、End | 滑块能到达的最低或最高处（范围的起点最高到终点）。 |

每次改变数值的按键都先报告 `onChange`，再报告 `onChangeEnd`。按住方向键和翻页键会重复。只有在没有文本输入框正在编辑时，按键才会到达滑块。

## 无障碍

- 每个滑块都是可调节元素（`"adjustable"`，在浏览器中是 slider），带有标签、数值和可取值的范围：范围的起点从 `min` 到终点，终点从起点到
  `max`，所以屏幕阅读器可以读出和设置两个滑块。数值按步长的小数位读出（`2.5`）。
- 屏幕阅读器的增加和减少操作（VoiceOver 的上下轻扫）像方向键一样让滑块走一步。
- 滑块是这个控件面向屏幕阅读器的元素，由 `accessibilityLabel` 命名（范围的起点由 `startAccessibilityLabel` 命名）；子元素中可见的标签在它所在的位置读出。
- `disabled` 时，屏幕阅读器报告滑块已变暗，滑块不接受操作。

标签、角色和操作的一般说明见[无障碍](../docs/accessibility.md)。

## 平台说明

- 每个平台都绘制应用设置的样式。按压和拖动由核心跟踪，鼠标、触控笔和手指都可以，从滑块开始的拖动不会被外层的滚动视图接管。
- 在 macOS 和 Web 上，Tab 在滑块之间移动键盘焦点，获得焦点的滑块响应滑块按键。
- 屏幕阅读器：VoiceOver（iOS、macOS）和 TalkBack 可以调节每个滑块；UI Automation（Windows）、GTK 的无障碍（Linux）和浏览器（`role="slider"`、`aria-valuenow`、`aria-valuetext`）获得它的范围和数值。
