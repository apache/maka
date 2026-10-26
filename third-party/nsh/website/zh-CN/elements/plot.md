---
title: Plot
description: "nsh/base/plot 的 Plot 组件及其图形 Line、Area 和 Grid：根据应用的数据行原生绘制图表，负责坐标轴的比例尺、指针下的数据行和动效，没有自己的外观。"
order: 20.9
group: base
demo: el-plot
---

# Plot

Plot 是图表的框架：它持有要显示的数据行、x 轴和 y 轴的比例尺、指针在它上面的位置以及动效。它的图形负责绘制这些内容：`Line` 是穿过一个系列的折线，`Area` 是系列与基线之间的区域，`Grid` 是横跨图表的网格线。每个图形都是一个铺满 plot 的画布，根据数据行原生绘制：应用设置数据行时只读取一次，之后在 Rust 中完成缩放、录制和绘制，所以一千个点的图表也不会为每个点运行 JS。指针同样在 Rust 中跟踪：悬停的十字线、圆点和提示框由平台的动画器移动和淡入淡出，应用只会在指针移到另一行时收到通知。外观由应用决定：图形使用 CSS 中 SVG 图形的绘制属性（`stroke-*`、`fill-*`），没有设置时使用 `currentColor`；area 可以在自己的形状内显示背景（渐变，`bg-linear-*`）；悬停部件（包括每个图形自己的圆点）和坐标轴标签都由应用设置样式和内容。

```rust tabs
use nsh_base::{
    plot::{area, grid, line, plot},
    theme,
};
use nsh_core::ui::{RowAccessor, Rows, prelude::*};

fn week(visitors: Vec<f64>, hovered: Signal<Option<u32>>) -> impl IntoElement {
    let rows = Rows::from_columns(visitors.len(), [("visitors".into(), visitors)]);
    plot()
        .data(rows)
        .y(RowAccessor::key("visitors"))
        .accessibility_label("每天的访客数")
        .h(px(160.0))
        .on_hover_change(move |index: &Option<u32>| hovered.set(*index))
        .child(grid().y(vec![0.0, 1500.0, 3000.0]).stroke_color(move || theme().border))
        .child(area().fill_color(move || theme().chart_1.opacity(0.2)))
        .child(line().stroke_color(move || theme().chart_1).stroke_width(px(2.0)))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";

const rows = [
  { day: "Mon", visitors: 1820 },
  { day: "Tue", visitors: 2140 },
  { day: "Wed", visitors: 1960 },
  { day: "Thu", visitors: 2480 },
  { day: "Fri", visitors: 2310 },
];

function App() {
  const hovered = signal<number | null>(null);
  return (
    <View class="gap-2 p-4">
      <Text class="text-sm text-muted-foreground tabular-nums">
        {hovered() == null ? "访客" : `${rows[hovered()!].day}: ${rows[hovered()!].visitors}`}
      </Text>
      <Plot
        data={rows}
        y="visitors"
        yScale={{ type: "linear", domain: [0, 3000] }}
        accessibilityLabel="每天的访客数，周四最多"
        onHoverChange={(index) => hovered.set(index)}
        crossLineClass="w-px h-full bg-border"
        dotClass="size-2.5 rounded-full border-2 border-background bg-chart-1"
        class="h-40"
      >
        <Grid y={[0, 1500, 3000]} class="stroke-border" />
        <Area class="fill-chart-1/20" />
        <Line class="stroke-chart-1 stroke-2" />
      </Plot>
    </View>
  );
}

mount(App);
```

`Plot`、`Line`、`Area` 和 `Grid` 来自 `nsh/base/plot`，这是 [`nsh/base`](../modules/nsh-base.md) 中单独的一个模块（Rust 中是 `nsh_base::plot`）。在 TypeScript 中，plot 的属性对数据行的类型是泛型的：字段名会按数据行做类型检查，行的函数会拿到行的类型。在 Rust 中，`plot()` 为每个属性提供一个 setter，数据行是 `Rows`（按键名存放的数字列），取值方式是 `RowAccessor`（键名，或以行序号为参数的函数），图形使用带类型的绘制方法（`.stroke_color(..)`、`.fill_color(..)`、`.stroke_width(..)`）。

## Plot

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `data` | `.data(..)` | `T[]` | （必填） | 数据行，每个点一个对象。应用设置数据行时，图形读取一次它们的值；没有值的行（字段不是数字、为 `null`）会跳过。 |
| `x` | `.x(..)` | `keyof T \| (d: T, index: number) => number` | 行的序号 | 在 `linear` x 比例尺上决定一行沿 x 轴位置的取值。`point` 比例尺按顺序放置各行。 |
| `y` | `.y(..)` | `keyof T \| (d: T, index: number) => number` | 无 | 图形没有指定自己的取值时绘制的内容。 |
| `xScale` | `.x_scale(..)` | `Scale` | `{ type: "point" }` | x 轴如何放置各行：`point`（按顺序从左边缘到右边缘均匀分布；只有一行时放在中间），或带可选 `domain` 的 `linear`。 |
| `yScale` | `.y_scale(..)` | `Scale` | `{ type: "linear" }` | y 轴如何放置数值：定义域的最小值在底边，最大值在顶边。没有 `domain` 时取各图形所绘制数值的范围。 |
| `interactive` | `.interactive(..)` | `boolean` | `true` | plot 跟随指针：报告指针下的行并显示悬停部件。为 `false` 时只绘制图形（例如列表中的迷你图）。 |
| `motion` | `.motion(..)` | `PlotMotion` | 无 | 出现动效、悬停淡入淡出的时间，以及悬停跟随指针所用的弹簧（见下文）。 |
| `appearGeneration` | `.appear_generation(..)` | `number` | 无 | 启用出现动效：plot 第一次显示时图形逐渐绘出，此值每次变化时再播放一次（换一支股票、换一个周期）。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对图表读出的内容：图表显示了什么，以及值得注意的地方。 |
| `accessibilityValue` | `.accessibility_value(..)` | `{ min?, max?, now?, text? }` | 无 | 屏幕阅读器读出的数值：应用对指针下那一行的描述。 |
| `crossLineClass`、`crossLineStyle` | `.cross_line_class(..)`、`.cross_line_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 十字线：与 plot 等高的视图，以指针下的行为中心。 |
| `dotClass`、`dotStyle` | `.dot_class(..)`、`.dot_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 悬停圆点：每个 `Line` 和 `Area` 一个视图，以该图形在指针下那一行的点为中心。图形自己的 `hoverDotClass` / `hoverDotStyle` 会替换它们，用于该图形的圆点。 |
| `tooltipContent` | `.tooltip_content(..)` | `JSX.Element` | 无 | 应用的提示框，按 `tooltipPlacement` 放置，随十字线移动和淡入淡出。 |
| `tooltipPlacement` | `.tooltip_placement(..)` | `"top" \| "pointer"` | `"top"` | 提示框的位置：在 plot 顶部、以十字线为中心；或在指针旁边，位于十字线朝 plot 中间的一侧，指针在上半部时在它下方，在下半部时在它上方。在顶部时，提示框留在 plot 的左右边缘之间（与顶边的距离由应用决定：放在 plot 下方的标签取 plot 的高度再多一些）；在指针旁边时，提示框留在 plot 内。 |
| `tooltipOffset` | `.tooltip_offset(..)` | `number` | `0` | 提示框与定位依据之间的距离：`"top"` 时是顶边，`"pointer"` 时是十字线和指针。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 图形，按顺序叠加绘制，以及应用放在它们上面的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | plot 的尺寸和外观；图形会像 CSS 那样继承它的绘制属性。 |

| 事件 | Rust | 参数 | 触发时机 |
|---|---|---|---|
| `onHoverChange` | `.on_hover_change(..)` | `index: number \| null` | 指针移到另一行上：沿 x 轴离指针最近的那一行的序号；指针离开 plot 后为 `null`。 |

`Scale` 是 `{ type: "point" } | { type: "linear"; domain?: [number, number] }`。`domain` 取两个值构成的范围，顺序不限；只有一个值的定义域会把它放在中间。

行的函数（`y={(d) => d.high - d.low}`）在数据行或函数变化时，于下一轮对每行调用一次，绘制和跟随指针时从不调用：请保持它是纯函数（同一行得到同一个数）。字段名则完全不运行 JS。

## Line、Area 和 Grid

| 图形 | 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `Line` | `y` | `string \| (d, index) => number` | plot 的 `y` | 要绘制的内容：每个有值的行对应一个点，没有值的行跳过。 |
| `Line`、`Area` | `data`、`x` | `T[]`、`string \| (d, index) => number` | plot 的数据行 | 自己的一组数据行（x 值不同的系列），用自己的 `x` 放在 plot 的比例尺上（没有时用行的序号）。 |
| `Line`、`Area` | `curve` | `"natural" \| "linear" \| "stepAfter"` | `"natural"` | 点与点之间如何连接：平滑曲线、直线段，或保持每个值直到下一行的阶梯。 |
| `Line` | `dot`、`dotClass`、`dotStyle` | `boolean`、`string`、`StyleProp<ViewStyle>` | `false` | 在每个点上显示圆点：以点为中心的视图，尺寸、背景和边框由应用决定。 |
| `Line`、`Area` | `hoverDotClass`、`hoverDotStyle` | `string`、`StyleProp<ViewStyle>` | plot 的 `dotClass`、`dotStyle` | 它的悬停圆点，位于它在指针下那一行的点上：每个系列的圆点用自己的颜色。两者分别替换 plot 上对应的值，只作用于这个图形（图形的颜色配合 plot 的尺寸和描边）；`hidden` 表示不显示。 |
| `Area` | `backgroundClass`、`backgroundStyle` | `string`、`StyleProp<ViewStyle>` | 无 | 它的背景：包围其形状的盒子（从第一个点到最后一个点，从最高点到基线），盒子的背景（`bg-*`、`bg-linear-to-b from-… to-…`、`backgroundImage`）只在形状内显示，位于 `fill` 之下。设置背景后，`fill` 没有设置时为 `none`。 |
| `Area` | `y1` | `string \| (d, index) => number` | plot 的 `y` | 顶边使用的取值。 |
| `Area` | `y0` | `number` | 底边 | 基线在 y 比例尺上的值。 |
| `Grid` | `x` | `number[]` | 无 | 竖线的位置，取 x 比例尺上的值（`point` 比例尺上是行的序号）。 |
| `Grid` | `y` | `number[]` | 无 | 横线的位置，取 y 比例尺上的值。 |

每个图形都铺满 plot，使用自己的 [SVG 绘制属性](../modules/style-reference.md#svg-绘制) 绘制；像 CSS 的继承一样，自己设置的值优先于 plot 上的值：

| 图形 | 使用的属性 | 没有设置时 |
|---|---|---|
| `Line` | `stroke`、`strokeWidth`、`strokeDasharray` | `currentColor`，宽 1，实线 |
| `Area` | `fill`（位于 `background` 部件之上）；顶边使用 `stroke`、`strokeWidth`、`strokeDasharray` | `fill` 为 `currentColor`（有背景时为 `none`）；没有描边 |
| `Grid` | `stroke`、`strokeWidth`、`strokeDasharray` | `currentColor`，宽 1，实线；每条线都落在整数设备像素上，细线也保持清晰 |

plot 没有设置定义域时，`Line` 和 `Area` 绘制的数值（包括 area 的 `y0`）构成 y 比例尺的定义域；grid 的数值不计入。图形只在要画的内容变化时重绘（数据行、取值、曲线、plot 的尺寸或比例尺、绘制属性）；指针只移动悬停部件，从不让图形重绘。

`fill` 与浏览器中一样是 CSS 的 `fill`：一个颜色。折线下方的渐变是 area 的背景，就像网页在形状里显示渐变那样（盒子的 `background-image` 加上 `clip-path`）：`backgroundClass="bg-linear-to-b from-chart-1/20 to-transparent"` 从 area 的最高点渐隐到基线，与任何视图的背景一样使用主题令牌和当前外观的颜色。

## 动效

动效由应用决定，默认没有：一切立即显示。`motion` 使用 [`nsh/animated`](../modules/nsh-animated.md) 的时间参数（`{ duration, easing, delay }` 和 `{ stiffness, damping, mass }`）：

| 键 | 类型 | 作用 |
|---|---|---|
| `appear` | timing | 有 `appearGeneration` 时，图形从起始边缘逐渐绘出。 |
| `enter` | timing | 指针移到 plot 上时，悬停部件淡入。 |
| `exit` | timing | 指针离开后，悬停部件淡出。 |
| `pointer` | spring | 指针在 plot 上移动时，悬停部件从一行滑到下一行。 |

动效在平台的动画器上运行，不需要每帧运行 JS；对偏好减少动态效果的用户立即完成。列表为回到视野的行重新创建 plot 时，图形会再绘出一次；可以把行的键名作为它的 `appearGeneration`。

这是 plot 自己的动效，用来设置图表里动的部分（图形的裁剪区域和悬停部件）的时间参数。视图的入场、离场和强调效果使用 [`createMotion`](../modules/nsh-animated.md#createmotion) 的预设和关键帧，应用仍然可以把它们用在 plot 的视图或周围的元素上。

## 构建图表

一个图表由 plot、它的图形以及应用自己放在周围的元素组成。应用要给 y 轴加标签时，为 y 比例尺指定 `domain`，标签就能对齐网格线的数值。悬停的十字线、圆点和提示框是 plot 的部件，由应用设置样式和内容；该行的数值显示在应用想放的地方。

网格线用实线细线、底部基线稍深时最清楚，虚线就可以专门表示参考值（下例中的开盘价）。area 用朝基线渐隐的淡色比平涂更轻盈。每个系列的悬停圆点用该系列的颜色，描边用图表所在表面的颜色，从折线上“挖”出来；提示框位于 plot 顶部，在第一行和最后一行时也留在边缘以内，`domain` 在最高值之上留出空间，提示框就不会盖住折线。

```tsx
import { signal, Text, View } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";

type Row = { time: string; price: number };

export function PriceChart(props: { rows: Row[]; low: number; high: number }) {
  const hovered = signal<number | null>(null);
  const shown = () => props.rows[hovered() ?? props.rows.length - 1];
  const middle = () => (props.low + props.high) / 2;
  return (
    <View class="gap-3 rounded-xl border border-border bg-card p-4">
      {/* 指针下那一行的数值，没有时取最后一行。 */}
      <View class="flex-row items-baseline">
        <Text class="flex-1 text-sm text-muted-foreground">{shown().time}</Text>
        <Text class="text-right text-xl font-semibold tabular-nums text-foreground">{shown().price.toFixed(2)}</Text>
      </View>
      <View class="flex-row gap-2">
        <Plot
          data={props.rows}
          y="price"
          yScale={{ type: "linear", domain: [props.low, props.high] }}
          accessibilityLabel={`价格，从 ${props.rows[0].price} 到 ${props.rows[props.rows.length - 1].price}`}
          accessibilityValue={{ text: `${shown().time}, ${shown().price.toFixed(2)}` }}
          appearGeneration={props.rows.length}
          motion={{ appear: { duration: 600, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 300, damping: 30 } }}
          crossLineClass="w-px h-full bg-muted-foreground/50"
          tooltipOffset={4}
          tooltipContent={
            <View class="flex-row items-center gap-1.5 rounded-lg border border-border bg-popover px-2 py-1 shadow-md">
              <View class="h-0.5 w-2.5 rounded-full bg-chart-1" />
              <Text class="text-xs tabular-nums text-popover-foreground">{shown().price.toFixed(2)}</Text>
            </View>
          }
          onHoverChange={(index) => hovered.set(index)}
          class="h-48 flex-1"
        >
          <Grid y={[middle(), props.high]} class="stroke-border" />
          {/* 朝基线渐隐的淡色。 */}
          <Area backgroundClass="bg-linear-to-b from-chart-1/20 to-transparent" />
          <Grid y={[props.low]} class="stroke-muted-foreground/40" />
          <Grid y={[props.rows[0].price]} class="stroke-muted-foreground" style={{ strokeDasharray: "3 3" }} />
          <Line class="stroke-chart-1 stroke-2" hoverDotClass="size-2.5 rounded-full border-2 border-card bg-chart-1" />
        </Plot>
        {/* y 轴标签，放在网格线的数值处（坐标轴图形推出之前先用 Text）。 */}
        <View class="-my-2 w-8 justify-between">
          {[props.high, middle(), props.low].map((v) => (
            <Text class="text-right text-xs tabular-nums text-muted-foreground">{v.toFixed(0)}</Text>
          ))}
        </View>
      </View>
      <View class="mr-10 flex-row justify-between">
        <Text class="text-xs text-muted-foreground">{props.rows[0].time}</Text>
        <Text class="text-xs text-muted-foreground">{props.rows[props.rows.length - 1].time}</Text>
      </View>
    </View>
  );
}
```

列表行中的迷你图是一个 `interactive={false}` 的 plot：只绘制图形，不跟随指针。

## 无障碍

- plot 对屏幕阅读器是一个元素，角色为图像，读出应用的 `accessibilityLabel`；图形和悬停部件是它的组成部分，自己不读出任何内容。在标签中说明图表显示了什么以及值得注意的地方（范围、最高值），并用 `accessibilityValue` 给出指针下那一行的描述，屏幕阅读器就会随之读出数值。
- 在有指针的平台上（桌面、网页、配触控板的 iPad），指针下的行通过 `onHoverChange` 报告。触摸屏没有悬停：触摸用户需要的数值请用应用自己的元素显示；数字很重要时，再用文字或列表提供数据行。
- plot 不接收点按，也不获得键盘焦点。

关于标签和角色的一般说明，见 [无障碍](../docs/accessibility.md)。

## 平台说明

- 所有平台以相同的方式绘制图形：每个图形一份在 Rust 中录制的绘图。数据行变化时，读取它们的图形在一个批次中重绘；绘制类名的变化（外观、`dark:`）只会重新发送绘图，不需要重新录制。
- 出现动效用平台动画器推动的值裁剪图形；悬停部件是由动画器移动和淡入淡出的视图，动画器还根据 plot 和提示框的尺寸把提示框留在 plot 内。
- area 的背景画在它自己的画布里，裁剪到 area 的形状，使用的渐变与平台为视图的 `bg-linear-*` 绘制的相同；它的类名变化（外观、`dark:`）只会重新发送绘图，不需要重新录制。
