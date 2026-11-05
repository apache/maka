---
title: Plot
description: "nsh/base/plot 的 Plot 组件、它的图形 Line、Area、Bar、Rule、Dot、Cell、Grid、Pie、Arc、RadialLine、RadialGrid、Sankey 和 Treemap，以及 PlotAxis 和 PlotLabel：根据应用的数据行原生绘制图表，负责坐标轴的比例尺和标签、数据点上的文字、指针下的数据行、格子或扇区和动效，没有自己的外观。"
group: base
demo: el-plot
---

# Plot

Plot 是图表的框架：它持有要显示的数据行、x 轴和 y 轴的比例尺、指针在它上面的位置以及动效。它的图形负责绘制这些内容：`Line` 是穿过一个系列的折线，`Area` 是系列与基线之间的区域，`Bar` 是 band 比例尺条带里每行一根的柱子，`Rule` 是每行一条从起点到终点的线段（K 线的影线），`Dot` 是每行在两个数值交汇处的一个圆点（散点图的点、气泡图的气泡），`Cell` 是每行在两个类别的条带里的一个格子，按数值上色（热力图），`Grid` 是横跨图表的网格线，`Pie` 是各行所占份额的饼图（中间留空即为环形图），`Arc` 是两个角度之间的一段扇形，`RadialLine` 是围绕中心的一条线，背后是 `RadialGrid` 的圆环和辐条（雷达图），`Sankey` 是各行之间的流向图，`Treemap` 是嵌套矩形，每个叶子的面积就是它的值（市场热力图）；`PlotAxis` 用比例尺的刻度为一条边加上标签，`PlotLabel` 在比例尺的点上写文字。每个图形都是一个铺满 plot 的画布，根据数据行原生绘制：应用设置数据行时只读取一次，之后在 Rust 中完成缩放、录制和绘制，所以一千个点的图表也不会为每个点运行 JS。指针同样在 Rust 中跟踪：悬停的十字线、圆点和提示框由平台的动画器移动和淡入淡出，应用只会在指针移到另一行时收到通知。外观由应用决定：图形使用 CSS 中 SVG 图形的绘制属性（`stroke-*`、`fill-*`），没有设置时使用 `currentColor`；area 和柱子可以在自己的形状内显示背景（渐变，`bg-linear-*`）；悬停部件（包括每个图形自己的圆点）以及坐标轴的标签、刻度线和轴线都由应用设置样式和内容。

```rust tabs
use nsh_base::{
    plot::{area, grid, line, plot},
    theme,
};
use nsh_core::{element::{RowAccessor, Rows}, prelude::*};

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
        onHoverChange={({ index }) => hovered.set(index)}
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

`Plot`、`Line`、`Area`、`Bar`、`Rule`、`Dot`、`Cell`、`Grid`、`Pie`、`Arc`、`RadialLine`、`RadialGrid`、`Sankey`、`Treemap`、`PlotAxis` 和 `PlotLabel` 来自 `nsh/base/plot`，这是 [`nsh/base`](../modules/nsh-base.md) 中单独的一个模块（Rust 中是 `nsh_base::plot`）。在 TypeScript 中，plot 的属性对数据行的类型是泛型的：字段名会按数据行做类型检查，行的函数会拿到行的类型。在 Rust 中，`plot()` 为每个属性提供一个 setter，数据行是 `Rows`（按键名存放的数字列），取值方式是 `RowAccessor`（键名，或以行序号为参数的函数），图形使用带类型的绘制方法（`.stroke_color(..)`、`.fill_color(..)`、`.stroke_width(..)`）。

## Plot

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `data` | `.data(..)` | `T[]` | （必填） | 数据行，每个点一个对象。应用设置数据行时，图形读取一次它们的值；没有值的行（字段不是数字、为 `null`）会跳过。 |
| `x` | `.x(..)` | `keyof T \| (d: T, index: number) => number` | 行的序号 | 在 `linear` x 比例尺上决定一行沿 x 轴位置的取值。`point` 比例尺按顺序放置各行。 |
| `y` | `.y(..)` | `keyof T \| (d: T, index: number) => number` | 无 | 图形没有指定自己的取值时绘制的内容。 |
| `xScale` | `.x_scale(..)` | `Scale` | `{ type: "point" }` | x 轴如何放置各行：`point`（按顺序从左边缘到右边缘均匀分布；只有一行时放在中间）、带可选 `domain` 的 `linear`，或 `band`（每行一个条带，用于柱子，见 [Bar](#bar)；或每个类别一个条带，用于格子，见 [Cell](#cell)）。y 轴为 `band` 时默认为 `linear`，用于横向柱子。`reverse: true` 让它从右边缘开始（[反向比例尺](#反向比例尺)）。 |
| `yScale` | `.y_scale(..)` | `Scale` | `{ type: "linear" }` | y 轴如何放置数值：定义域的最小值在底边，最大值在顶边。没有 `domain` 时取各图形所绘制数值的范围。`band` 从顶边向下每行布置一个条带，用于横放的柱子。`reverse: true` 让它反过来：最小值在顶边，各行从底边向上排列（[反向比例尺](#反向比例尺)）。 |
| `y2Scale` | `.y2_scale(..)` | `LinearScale` | 无 | 第二个 y 比例尺 `{ type: "linear", domain?, reverse? }`，给声明 `scale="y2"` 的图形用：双轴图右侧的比例尺（[双轴](#双轴)）。没有 `domain` 时取放在它上面的值的范围。 |
| `alignTicks` | `.align_ticks(..)` | `boolean` | `true` | 两个 y 比例尺都没有指定定义域、且两边都有图形时，把两者扩展成同样多的整齐步长，让刻度落在同一组线上（[双轴](#双轴)）。为 `false` 时各自取数据的范围。 |
| `interactive` | `.interactive(..)` | `boolean` | `true` | plot 跟随指针和键盘：报告指针下的行并显示悬停部件；它也是 Tab 的一个停靠点，方向键移动悬停的行（[键盘](#键盘)）。为 `false` 时只绘制图形（例如列表中的迷你图），在它上面的点按交给周围的视图。plot 是否提供键盘操作，在创建时确定。 |
| `motion` | `.motion(..)` | `PlotMotion` | 无 | 出现动效、悬停淡入淡出的时间，以及按键移动悬停时所用的弹簧（见下文）。 |
| `appearGeneration` | `.appear_generation(..)` | `number \| string` | 无 | 启用出现动效：plot 第一次显示时图形逐渐绘出，此值每次变化时再播放一次（换一支股票、换一个周期）。在 [`PlotAppearScope`](#plotappearscope) 里，已经在其中播放完的 generation 立即完整显示。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对图表读出的内容：图表显示了什么，以及值得注意的地方。 |
| `accessibilityValue` | `.accessibility_value(..)` | `{ min?, max?, now?, text? }` | 无 | 屏幕阅读器读出的数值：应用对指针下那一行的描述。 |
| `crossLineClass`、`crossLineStyle` | `.cross_line_class(..)`、`.cross_line_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 十字线：与 plot 等高的视图，以指针下的行为中心。在 band 比例尺上它位于该行的条带里，与条带等宽（band 在 y 轴时横跨 plot）。 |
| `dotClass`、`dotStyle` | `.dot_class(..)`、`.dot_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 悬停圆点：每个 `Line`、`Area` 和 `RadialLine` 一个视图，以该图形在指针下那一行的点为中心；`Dot` 的则与指针下的圆点一样大。图形自己的 `hoverDotClass` / `hoverDotStyle` 会替换它们，用于该图形的圆点。 |
| `tooltipContent` | `.tooltip_content(..)` | `JSX.Element` | 无 | 应用的提示框，按 `tooltipPlacement` 放置，随十字线移动和淡入淡出。 |
| `tooltipPlacement` | `.tooltip_placement(..)` | `"top" \| "pointer"` | `"top"` | 提示框的位置：在 plot 顶部、以十字线为中心；或在指针旁边，位于十字线朝 plot 中间的一侧，指针在上半部时在它下方，在下半部时在它上方。在顶部时，提示框留在 plot 的左右边缘之间（与顶边的距离由应用决定：放在 plot 下方的标签取 plot 的高度再多一些）；在指针旁边时，提示框留在 plot 内。用键盘时，提示框在该行第一个折线或区域的点旁边（柱状图在柱带中间，饼图在扇区中间）。 |
| `tooltipOffset` | `.tooltip_offset(..)` | `number` | `0` | 提示框与定位依据之间的距离：`"top"` 时是顶边，`"pointer"` 时是十字线和指针。 |
| `colorScale` | `.color_scale(..)` | `ColorScale` | 无 | 图形的颜色：图形的 `color` 读出的类别所对应的颜色，同 d3 的 `scaleOrdinal`（`{ type: "ordinal", domain?, range, unknown? }`，见[按类别着色](#colors-by-category)）；或 `Cell` 的 `value` 读出的数值沿色阶对应的颜色，同 d3 的 `scaleSequential` 和 `scaleDiverging`（`{ type: "sequential" \| "diverging", … }`，见[按色阶着色](#colors-along-a-ramp)）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 图形，按顺序叠加绘制，以及应用放在它们上面的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | plot 的尺寸和外观；图形会像 CSS 那样继承它的绘制属性。`focus:` / `focus-visible:` 类和 `focusStyle` 绘制它的焦点环。 |

| 事件 | Rust | 参数 | 触发时机 |
|---|---|---|---|
| `onHoverChange` | `.on_hover_change(..)` | `{ index: number \| null }` | 指针移到另一行上：沿 x 轴（只有 y 轴有条带时沿 y 轴）离指针最近的那一行的序号，指针下[饼图](#pie-and-arc)扇区所在行的序号，圆心离指针最近的[圆点](#dot)所在行的序号，指针下[格子](#cell)所在行的序号（在两个格子之间的间隙里取较近的那个），或[径向线](#radialline-and-radialgrid)上角度离指针最近的那一行的序号；指针离开 plot（在饼图上为离开它的扇区，在径向线上为离开它的外半径）后为 `null`。 |

`Scale` 是 `{ type: "point"; reverse? } | { type: "linear"; domain?: [number, number]; reverse? } | { type: "band"; domain?: string[]; paddingInner?; paddingOuter?; maxBandWidth?; bandCount?; groupPadding?; reverse? }`。`linear` 比例尺的 `domain` 取两个值构成的范围，顺序不限；只有一个值的定义域会把它放在中间。`band` 比例尺的 `domain` 是各条带的类别，按顺序排列（见 [Cell](#cell)）；它的其他选项见 [Bar](#bar)。

行的函数（`y={(d) => d.high - d.low}`）在数据行或函数变化时，于下一轮对每行调用一次，绘制和跟随指针时从不调用：请保持它是纯函数（同一行得到同一个数）。字段名则完全不运行 JS。

### 反向比例尺

`reverse: true` 让比例尺从另一条边开始，就像 visx 的比例尺接受 `reverse`、d3 的比例尺接受反着写的值域。在 x 轴上，第一行或定义域的最小值位于右边缘；在 y 轴上，定义域的最小值位于顶边，各行从底边向上排列。放在比例尺上的一切都随之变化：图形、柱子的基线和生长方向、area 的基线、网格线、`PlotAxis` 的刻度、悬停找到的行、方向键（[键盘](#键盘)）以及向新定义域的移动。在反向的 `linear` y 比例尺上，柱子从顶边向下垂挂；在反向的 `linear` x 比例尺上，横放的柱子从右边缘向左生长：

```tsx
<Plot
  data={depths}
  y="depth"
  xScale={{ type: "band", paddingInner: 0.2 }}
  yScale={{ type: "linear", domain: [0, 40], reverse: true }}
  class="h-32"
>
  <Bar class="fill-chart-2" cornerRadii={{ bottomLeft: 3, bottomRight: 3 }} />
</Plot>
```

plot 出现时，折线和区域从 x 比例尺起始的那条边逐渐绘出，比例尺反向时就是右边缘。

### 双轴

<!-- demo: el-plot-dual -->

plot 有第二个 y 比例尺，用来放单位不同的值：价格旁的成交量、营收旁的利润率。所有沿 y 方向放值的部件都接受
`scale`：`"y"`（默认，plot 的 `yScale`）或 `"y2"`（它的 `y2Scale`）。右侧加一个 `scale="y2"` 的 `PlotAxis` 来标注它：

```tsx
<Plot data={days} xScale={{ type: "band", paddingInner: 0.3 }} class="mx-10 mb-6 h-44">
  <Grid class="stroke-border" />
  <Bar value="volume" class="fill-chart-2/50" />
  <Line y="close" scale="y2" class="stroke-chart-1 stroke-2" />
  <PlotAxis placement="left" format={(v) => `${v}M`} labelClass="pr-2 text-xs text-muted-foreground" />
  <PlotAxis placement="right" scale="y2" labelClass="pl-2 text-xs text-muted-foreground" />
</Plot>
```

每个比例尺有自己的定义域：app 给的 `domain`，或放在它上面的值的范围；有 `motion.update` 时各自移动到新的定义域。两个比例尺
都没有指定定义域时，plot 把两者排成同样多的整齐步长（1、2 或 5 乘以 10 的幂，大约每 32 点高度一步）：两边都包含 0 时，0
落在同一条线上；否则从 0 开始的比例尺（成交量）向上补步长，其他的（价格）上下各补一半。坐标轴的刻度就是这些步长，既不写 `x`
也不写 `y` 的 `Grid` 也画在这些位置，于是一套网格同时服务两条轴。`alignTicks={false}` 关闭对齐；app 指定了 `domain` 时两个比例尺都保持原样。

悬停仍找一行；每个图形的悬停点在它自己的比例尺上，读数由 app 根据 `onHoverChange` 报告的那一行读出两个值。两个比例尺上的柱子
在每个条带里并排，`stack` 只堆叠同一比例尺上的柱子。`y2Scale` 只能是线性的：y 轴有条带的 plot 没有第二个 y 比例尺。

## Line、Area 和 Grid

| 图形 | 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `Line` | `y` | `string \| (d, index) => number` | plot 的 `y` | 要绘制的内容：每个有值的行对应一个点，没有值的行跳过。 |
| `Line`、`Area` | `data`、`x` | `T[]`、`string \| (d, index) => number` | plot 的数据行 | 自己的一组数据行（x 值不同的系列），用自己的 `x` 放在 plot 的比例尺上（没有时用行的序号）。 |
| `Line`、`Area` | `curve` | `"natural" \| "linear" \| "stepAfter"` | `"natural"` | 点与点之间如何连接：平滑曲线、直线段，或保持每个值直到下一行的阶梯。area 的底边使用同一条曲线。 |
| `Line` | `dot`、`dotClass`、`dotStyle` | `boolean`、`string`、`StyleProp<ViewStyle>` | `false` | 在每个点上显示圆点：以点为中心的视图，尺寸、背景和边框由应用决定。 |
| `Line`、`Area` | `hoverDotClass`、`hoverDotStyle` | `string`、`StyleProp<ViewStyle>` | plot 的 `dotClass`、`dotStyle` | 它的悬停圆点，位于它在指针下那一行的点上：每个系列的圆点用自己的颜色。两者分别替换 plot 上对应的值，只作用于这个图形（图形的颜色配合 plot 的尺寸和描边）；`hidden` 表示不显示。 |
| `Area` | `backgroundClass`、`backgroundStyle` | `string`、`StyleProp<ViewStyle>` | 无 | 它的背景：包围其形状的盒子（从第一个点到最后一个点，从最高点到基线，带则到底边的最低点），盒子的背景（`bg-*`、`bg-linear-to-b from-… to-…`、`backgroundImage`）只在形状内显示，位于 `fill` 之下。设置背景后，`fill` 没有设置时为 `none`。 |
| `Area` | `y1` | `string \| (d, index) => number` | plot 的 `y` | 顶边使用的取值。 |
| `Area` | `y0` | `number \| string \| (d, index) => number` | y 比例尺低端所在的边 | 它的底边：数字是 y 比例尺上的一条基线；字段名或函数为每一行给出自己的底值，area 由此成为一条带（一天的最低价到最高价、预测的区间）。没有它时，area 闭合到 y 比例尺最小值所在的边：通常是底边，反向比例尺上是顶边（从顶部垂下的区域）。任一边没有值的行会跳过。 |
| `Line`、`Area`、`Grid` | `scale` | `"y" \| "y2"` | `"y"` | 它的值沿哪个 y 比例尺放：plot 的 `yScale`，或第二个 `y2Scale`（[双轴](#双轴)）。 |
| `Grid` | `x` | `number[]` | 无 | 竖线的位置，取 x 比例尺上的值（`point` 比例尺上是行的序号）。 |
| `Grid` | `y` | `number[]` | 无 | 横线的位置，取 y 比例尺上的值。`x` 和 `y` 都不写时，横线跟随它的比例尺的刻度，即不写 `ticks` 的 `PlotAxis` 放刻度的位置（横放的柱子沿 x）。 |
| `Grid` | `ticks` | `number` | 坐标轴的默认值 | `x` 和 `y` 都不写时大约画多少条线，同 `PlotAxis` 的 `ticks`。 |
| `Line`、`Area` | `color` | `string \| (d, index) => string` | 无 | 它的数据行的类别，颜色来自 plot 的 `colorScale`：第一个有类别的行决定 line 的 `stroke`（area 的 `fill`），在没有任何设置时使用（见[按类别着色](#colors-by-category)）。 |

每个图形都铺满 plot，使用自己的 [SVG 绘制属性](../modules/style-reference.md#svg-绘制) 绘制；像 CSS 的继承一样，自己设置的值优先于 plot 上的值：

| 图形 | 使用的属性 | 没有设置时 |
|---|---|---|
| `Line` | `stroke`、`strokeWidth`、`strokeDasharray` | `currentColor`，宽 1，实线 |
| `Area` | `fill`（位于 `background` 部件之上）；顶边使用 `stroke`、`strokeWidth`、`strokeDasharray` | `fill` 为 `currentColor`（有背景时为 `none`）；没有描边 |
| `Grid` | `stroke`、`strokeWidth`、`strokeDasharray` | `currentColor`，宽 1，实线；每条线都落在整数设备像素上，细线也保持清晰 |

plot 没有设置定义域时，`Line` 和 `Area` 绘制的数值（包括 area 的 `y0`：基线，或每一行的底值）构成 y 比例尺的定义域；grid 的数值不计入。图形只在要画的内容变化时重绘（数据行、取值、曲线、plot 的尺寸或比例尺、绘制属性）；指针只移动悬停部件，从不让图形重绘。

带是 `y0` 读取数据行的 `Area`：顶边经过 `y1`，底边再经过 `y0` 回到起点，两条边都使用 area 的 `curve`，出现动画从起始边缘同时画出两条边。它的悬停圆点位于顶边；叠加一条 `Line` 标出中间的值：

```tsx
<Plot data={days} y="close">
  <Area y1="high" y0="low" class="fill-chart-1/15" hoverDotClass="hidden" />
  <Line class="stroke-chart-1 stroke-2" />
</Plot>
```

`fill` 与浏览器中一样是 CSS 的 `fill`：一个颜色。折线下方的渐变是 area 的背景，就像网页在形状里显示渐变那样（盒子的 `background-image` 加上 `clip-path`）：`backgroundClass="bg-linear-to-b from-chart-1/20 to-transparent"` 从 area 的最高点渐隐到基线，与任何视图的背景一样使用主题令牌和当前外观的颜色。

## Bar

`Bar` 在 `band` 比例尺上为每一行在该行的条带里画一根柱子：x 比例尺是 band 时柱子竖立，y 比例尺是 band 时柱子横放（此时 x 比例尺是 `linear`）。每根柱子从 `base` 延伸到该行在另一个比例尺上的值，所以负值朝反方向生长；没有值的行没有柱子。在反向的数值比例尺上，柱子从顶边向下或从右边缘向左生长；反向的 band 比例尺把第一行的条带放在右侧或底部（[反向比例尺](#反向比例尺)）。

```tsx
import { Bar, Grid, Plot } from "nsh/base/plot";

const sales = [
  { month: "Jan", online: 42, store: 31 },
  { month: "Feb", online: 51, store: 28 },
  { month: "Mar", online: 48, store: 36 },
];

<Plot
  data={sales}
  xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.15, groupPadding: 0.1 }}
  yScale={{ type: "linear", domain: [0, 60] }}
  class="h-40"
>
  <Grid y={[20, 40, 60]} class="stroke-border" />
  <Bar value="online" class="fill-chart-1" cornerRadii={{ topLeft: 4, topRight: 4 }} />
  <Bar value="store" class="fill-chart-2" cornerRadii={{ topLeft: 4, topRight: 4 }} />
</Plot>
```

不在堆叠里的柱子按图形的顺序在每个条带里并排；`stack` 相同的柱子堆叠起来，每一行的柱子从堆叠中前一根柱子的末端开始：

```tsx
<Bar value="online" stack="sales" class="fill-chart-1" />
<Bar value="store" stack="sales" class="fill-chart-2" cornerRadii={{ topLeft: 4, topRight: 4 }} label={(d) => `${d.online + d.store}`} />
```

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `value` | `string \| (d, index) => number` | plot 的 `y` | 每根柱子显示的值。 |
| `base` | `number \| string \| (d, index) => number` | `0` | 柱子在数值比例尺上生长的起点：所有行共用一个值，或用字段、函数给每一行各自的起点，这时每根柱子从该行的起点延伸到它的值（没有起点的行没有柱子）。计入定义域。堆叠逐行从它的第一根柱子的 `base` 开始。 |
| `stack` | `string` | 无 | 加入的堆叠：`stack` 相同的柱子按顺序堆叠（没有值的行不增加高度）。 |
| `scale` | `"y" \| "y2"` | `"y"` | 竖立柱子的值沿哪个 y 比例尺放（[双轴](#双轴)）；两个比例尺上的柱子并排，堆叠只包含同一比例尺上的柱子。 |
| `cornerRadii` | `number \| { topLeft?, topRight?, bottomRight?, bottomLeft? }` | `0` | 柱子每个角的半径；`{ topLeft: 4, topRight: 4 }` 让竖立的柱子顶端变圆。超过柱子一半的半径会缩小以适应柱子。 |
| `stagger` | `number` | `0` | plot 出现时，柱子按行依次开始生长，开始时间分布在出现动效的这一比例内（0 到 0.95），每根柱子用剩下的时间长完；为 0 时一起生长。 |
| `inactiveOpacity` | `number` | 无 | 指针在 plot 上时，指针下那一行以外的柱子的不透明度，让那一行突出：随悬停淡入淡出，并随悬停从一根柱子交给下一根。 |
| `label` | `string \| (d, index) => string` | 无 | 每根柱子数值末端的文字：字段（它的文字或数字），或返回应用格式化后文字的函数。 |
| `labelClass`、`labelStyle` | `string`、`StyleProp<TextStyle>` | 无 | `label` 部件：以柱子为中心的文字，位于竖立柱子末端的上方（向下生长时在下方），横放柱子末端之后（向回生长时在之前）。它的内边距就是与柱子的距离。 |
| `backgroundClass`、`backgroundStyle` | `string`、`StyleProp<ViewStyle>` | 无 | 它的背景：每根柱子的盒子，盒子的背景（`bg-linear-to-t from-… to-…`，从柱子底部到顶部）只在柱子内显示，位于 `fill` 之下。设置背景后，`fill` 没有设置时为 `none`。 |
| `color` | `string \| (d, index) => string` | 无 | 每根柱子的类别，颜色来自 plot 的 `colorScale`：在没有任何设置时作为柱子的 `fill`（见[按类别着色](#colors-by-category)）。 |

band 比例尺像 d3 的 `scaleBand` 一样，按顺序为 plot 的每一行布置一个条带，或为 `domain` 的每个类别布置一个条带：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `domain` | 无 | 各条带的类别，按顺序排列（同 d3 的 `scaleBand().domain()`）：[`Cell`](#cell) 放进它所在行的类别的条带，`PlotAxis` 为每个条带写上它的类别；重复出现的类别保留第一次的位置。没有设置时，条带就是各行；有格子时，是格子沿这条轴读出的类别，按数据行带来它们的顺序排列。 |
| `paddingInner` | `0` | 相邻条带之间的间隙，占每个条带步长的比例（0 到 1）。 |
| `paddingOuter` | `0` | 第一个条带之前和最后一个条带之后的间隙，占一个步长的比例。取 `paddingInner` 的一半时，各条带的中线在 plot 上等距分布。 |
| `maxBandWidth` | 无 | 条带的最大宽度（点）：宽 plot 上只有几个条带时保持窄，每个条带位于自己位置的中间。 |
| `bandCount` | 行数 | 条带多于行数时布置的条带数：各行占据前面的条带，数据行增加时保持宽度和位置。 |
| `groupPadding` | `0` | 同一条带里并排的柱子之间的间隙，占每根柱子位置的比例。 |
| `reverse` | `false` | 条带从另一条边开始排列：x 轴上第一行的条带在右侧，y 轴上在底部；同一条带里并排的柱子保持原来的顺序。 |

柱子使用自己的 `fill` 着色（`fill-*`；像 CSS 那样从 plot 继承），没有设置时为 `currentColor`（设置 `color` 时为它的类别的颜色），没有悬停圆点。在 band 比例尺上，悬停会找到指针下的条带，plot 的十字线位于这个条带里、与条带等宽：`crossLineClass="w-full h-full bg-foreground/5"` 给条带上色，`w-px` 则在条带中间保留一条线。plot 没有设置定义域时，柱子的数值和 `base` 构成数值比例尺的定义域。plot 出现时，每根柱子从它所在堆叠的 `base` 长出；动效、变淡和滑动都在平台的动画器上运行，指针从不让柱子重绘。

<a id="ranges"></a>

### 区间

`base` 是字段或函数时，每根柱子跨越它所在行的两个值：瀑布图的一级从它之前的累计值到之后的累计值，K 线的实体从开盘价到收盘价，一项任务从开始到结束。出现时柱子从自己的起点长出，标签位于数值末端：上升的柱子在上方，下降的柱子在下方。

<!-- demo: el-plot-ranges -->

```tsx
const bridge = [
  { step: "Revenue", from: 0, to: 120, kind: "total" },
  { step: "Costs", from: 120, to: 72, kind: "down" },
  { step: "Other", from: 72, to: 81, kind: "up" },
  { step: "Profit", from: 0, to: 81, kind: "total" },
];

<Plot
  data={bridge}
  xScale={{ type: "band", paddingInner: 0.3 }}
  colorScale={{ type: "ordinal", domain: ["total", "up", "down"], range: ["#64748b", "#16a34a", "#dc2626"] }}
  class="h-40"
>
  <Bar value="to" base="from" color="kind" label={(d) => `${d.to - d.from}`} labelClass="text-xs pb-1" />
</Plot>
```

漏斗图就是居中的横放柱子：在 band y 比例尺上用 `base={(d) => -d.users / 2}` 和 `value={(d) => d.users / 2}`。

<a id="rule"></a>

## Rule

`Rule` 沿数值轴为每一行画一条直线，从 `base` 到该行的值：在 band 比例尺上位于该行条带的中间（band y 比例尺上横跨 plot），在 point 或 linear 比例尺上位于该行在 x 轴上的位置。K 线的影线、箱线图的须、误差线和棒棒糖图的杆都是 rule；K 线图就是 `Bar` 叠在 `Rule` 上：

```tsx
import { Bar, Plot, Rule } from "nsh/base/plot";

<Plot
  data={days}
  xScale={{ type: "band", paddingInner: 0.4 }}
  colorScale={{ type: "ordinal", domain: ["up", "down"], range: ["#16a34a", "#dc2626"] }}
  class="h-48"
>
  <Rule value="high" base="low" color={(d) => (d.close >= d.open ? "up" : "down")} />
  <Bar value="close" base="open" color={(d) => (d.close >= d.open ? "up" : "down")} />
</Plot>
```

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `value` | `string \| (d, index) => number` | plot 的 `y` | 每条线的终点。没有值的行没有线。 |
| `base` | `number \| string \| (d, index) => number` | `0` | 每条线的起点：所有行共用一个值（棒棒糖图从零线开始的杆），或用字段、函数给每一行各自的起点（K 线的最低价）。计入定义域。 |
| `scale` | `"y" \| "y2"` | `"y"` | 它的值沿哪个 y 比例尺放（[双轴](#双轴)）。 |
| `stagger` | `number` | `0` | plot 出现时，线按行依次开始生长，开始时间分布在出现动效的这一比例内（0 到 0.95），每条线用剩下的时间从起点长完。 |
| `inactiveOpacity` | `number` | 无 | 指针在 plot 上时，指针下那一行以外的线的不透明度，与 `Bar` 的相同。 |
| `color` | `string \| (d, index) => string` | 无 | 每条线的类别，颜色来自 plot 的 `colorScale`：在没有任何设置时作为线的 `stroke`。 |

rule 使用自己的 `stroke` 描边（`stroke-*`、`strokeWidth`、`strokeDasharray`；像 CSS 那样从 plot 继承），没有设置时为 `currentColor`，没有悬停圆点。plot 没有设置定义域时，它的数值和 `base` 构成数值比例尺的定义域；plot 出现时它从起点长出，并随比例尺定义域的变化移动，都在平台的动画器上运行。

## Dot

<!-- demo: el-plot-dots -->

`Dot` 在每一行的两个数值交汇处画一个圆点：行的 `x` 落在 `linear` x 比例尺上、`value` 落在 y 轴上，就是散点图；在 band x 比例尺上，每个圆点位于所在行条带的中间；横跨 band y 比例尺时（x 比例尺为 `linear`），数值沿 x 轴排布、行的条带沿 plot 向下排列，就是点图。半径 `r` 可以是所有圆点共用的一个数，也可以是每一行的一个数值，由 `rScale` 换算成半径，就是气泡图。没有值的行没有圆点。

```tsx
import { Dot, Grid, Plot } from "nsh/base/plot";
import { token } from "nsh";

const sessions = [
  { minutes: 12, trades: 5, platform: "iOS" },
  { minutes: 8, trades: 3, platform: "Android" },
  { minutes: 26, trades: 11, platform: "Web" },
  { minutes: 17, trades: 8, platform: "iOS" },
];

<Plot
  data={sessions}
  x="minutes"
  xScale={{ type: "linear", domain: [0, 40] }}
  yScale={{ type: "linear", domain: [0, 20] }}
  colorScale={{ type: "ordinal", domain: ["iOS", "Android", "Web"], range: [token("chart-1"), token("chart-2"), token("chart-3")] }}
  class="h-48"
>
  <Grid x={[10, 20, 30]} y={[5, 10, 15]} class="stroke-border" />
  <Dot
    value="trades"
    r={4}
    color="platform"
    inactiveOpacity={0.3}
    class="stroke-card stroke-2"
    hoverDotClass="rounded-full outline-2 outline-offset-1 outline-foreground"
  />
</Plot>
```

`r` 是字段或函数时，每一行的数值决定自己圆点的大小。`rScale={{ type: "sqrt", range: [min, max] }}` 把数值的平方根映射到以点为单位的半径上，同 d3 的 `scaleSqrt`，所以值域从 0 开始时，气泡的面积与数值成正比；值域从大于 0 开始时，最小的气泡也清晰可见。比例尺没有给出定义域时，定义域是 0 到最大的数值。较大的圆点先画，较小的圆点留在它们上面清晰可见：

```tsx
<Plot
  data={countries}
  x="gdp"
  xScale={{ type: "linear", domain: [-10, 95] }}
  yScale={{ type: "linear", domain: [48, 90] }}
  colorScale={{ type: "ordinal", range: [token("chart-1"), token("chart-2"), token("chart-3"), token("chart-4")] }}
  class="h-56"
>
  <Dot value="life" r="population" rScale={{ type: "sqrt", range: [3, 24] }} color="region" class="stroke-card" />
</Plot>
```

plot 没有设置定义域时，圆点的数值构成数值比例尺的定义域，且不会延伸到 0，所以散点图的坐标轴贴合它的点。圆点较大时，给 plot 设置在数值四周留有余量的 `domain`：位于定义域边缘的气泡会画过 plot 的边缘。

同一组条带里的两个图形组合起来，就是比较一行中两个数值的图表：棒棒糖图是从 0 开始的 `Rule` 加上位于数值处的 `Dot`；哑铃图是从一个数值到另一个数值的 `Rule`，两端各有一个 `Dot`，横跨 band y 比例尺：

```tsx
<Plot data={stocks} yScale={{ type: "band", paddingInner: 0.3 }} xScale={{ type: "linear", domain: [-50, 80] }} class="h-48">
  <Rule value="high" base="low" class="stroke-border stroke-2" />
  <Dot value="before" r={3.5} class="fill-card stroke-muted-foreground" hoverDotClass="hidden" />
  <Dot value="now" r={5} class="fill-chart-1 stroke-card stroke-2" hitRadius={24} />
</Plot>
```

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `value` | `string \| (d, index) => number` | plot 的 `y` | 每个圆点沿数值轴的位置：沿 y 轴向上，横跨 band y 比例尺时沿 x 轴。没有值的行没有圆点。 |
| `r` | `number \| string \| (d, index) => number` | `3` | 圆点的半径（点），或用字段、函数给每一行一个数值，由 `rScale` 换算成半径（没有 `rScale` 时数值就是半径）。缺少数值的行没有圆点。 |
| `rScale` | `{ type: "sqrt"; domain?: [number, number]; range: [number, number] }` | 无 | `r` 的数值如何变成半径：数值的平方根在 `domain`（没有设置时为 0 到最大的数值）上映射到半径的 `range`，所以值域从 0 开始时，每个圆点的面积与数值成正比。定义域之外的数值取值域的两端。 |
| `stagger` | `number` | `0` | plot 出现时，圆点按行依次开始长出，开始时间分布在出现动效的这一比例内（0 到 0.95）；为 0 时一起长出。 |
| `inactiveOpacity` | `number` | 无 | 指针或按键停在一个圆点上时，其他圆点的不透明度：随悬停淡入淡出。 |
| `color` | `string \| (d, index) => string` | 无 | 每个圆点的类别，颜色来自 plot 的 `colorScale`：在没有任何设置时作为圆点的 `fill`（[按类别着色](#colors-by-category)）。 |
| `hitRadius` | `number` | `8` | 指针在圆点边缘之外多远仍能找到它：在这个距离之内的圆点中，取圆心离指针最近的那个（Voronoi 单元），所以叠在大气泡上的小气泡在它自己的圆心附近就能找到。点图把它设得和一行一样大，指针在一行的任何位置都能找到这一行。 |
| `scale` | `"y" \| "y2"` | `"y"` | 它的值沿哪个 y 比例尺放（[双轴](#双轴)）；在 band y 比例尺上横向排列的圆点把值放在 x 上。 |
| `hoverDotClass`、`hoverDotStyle` | `string`、`StyleProp<ViewStyle>` | plot 的 `dotClass`、`dotStyle` | `hoverDot` 部件：与指针下圆点同宽同高、以它为中心的视图。`rounded-full outline-2 outline-offset-1` 给它加一圈描边；`hidden` 表示这个图形不显示。 |

圆点使用自己的 `fill` 填充（`fill-*`；像 CSS 那样从 plot 继承），没有设置时为 `currentColor`（设置 `color` 时为类别的颜色）；设置了 `stroke` 时用它描边（`stroke-*`、`strokeWidth`）：一圈卡片颜色的描边能让重叠的圆点彼此分开。在有圆点的 plot 上，plot 报告圆心离指针最近的圆点所在的行（远离所有圆点时为 `null`），按键按行的顺序切换（按 x 给行排序，按键就从左到右依次经过圆点），`hoverDot` 部件标出这个圆点。plot 出现时，圆点从无到有长出；有 `motion.update` 时，圆点过渡到新的数值和大小，新行的圆点长出，已移除的行的圆点缩小消失；都在平台的动画器上运行，不需要重新绘制图形。

## Cell

<!-- demo: el-plot-cells -->

`Cell` 为每一行同时在两个条带里画一个矩形：它的 `x` 类别在 `band` x 比例尺上的条带，和它的 `y` 类别在 `band` y 比例尺上的条带，于是各行组成一张网格，即热力图。相关系数矩阵、月度收益日历和一周里每小时的成交量都是格子。每个格子铺满它的两个条带，所以两个比例尺的 `paddingInner` 和 `paddingOuter` 就是格子之间和四周的间隙。它的颜色是它的 `value` 在 plot 的 `colorScale` 色阶上对应的颜色（见[按色阶着色](#colors-along-a-ramp)），或它的 `color` 类别在序数比例尺上对应的颜色。格子放在 plot 的 x 和 y 比例尺上。

```tsx
import { Cell, Plot, PlotAxis } from "nsh/base/plot";
import { token } from "nsh";

const months = [
  { year: "2025", month: "Jan", ret: 2.7 },
  { year: "2025", month: "Feb", ret: -1.4 },
  { year: "2025", month: "Mar", ret: -5.8 },
  { year: "2026", month: "Jan", ret: 1.9 },
  { year: "2026", month: "Feb", ret: 3.2 },
];

<Plot
  data={months}
  xScale={{ type: "band", domain: ["Jan", "Feb", "Mar"], paddingInner: 0.08 }}
  yScale={{ type: "band", paddingInner: 0.08 }}
  colorScale={{ type: "diverging", range: [token("destructive"), token("muted"), token("chart-1")] }}
  class="ml-10 mt-6 h-24"
>
  <Cell
    x="month"
    y="year"
    value="ret"
    cornerRadii={3}
    inactiveOpacity={0.4}
    label={(d) => d.ret.toFixed(1)}
    labelClass="text-xs tabular-nums text-black/70 data-dark:text-white"
    hoverCellClass="rounded-sm outline-2 outline-offset-1 outline-foreground"
  />
  <PlotAxis placement="top" labelClass="pb-1.5 text-xs text-muted-foreground" />
  <PlotAxis placement="left" labelClass="w-10 pr-2 text-right text-xs text-muted-foreground" />
</Plot>
```

band 比例尺的 `domain` 按顺序给出各条带的类别，同 d3 的 `scaleBand().domain()`：日历的月份从一月到十二月，每个月份都有自己的条带，无论它的数据行是否已经到来，所以上例中 2026 年 3 月是网格里的一个空位。没有 `domain` 时，条带就是格子沿这条轴读出的类别，按数据行带来它们的顺序排列（2025 在 2026 上方）。沿有类别的 band 比例尺放置的 `PlotAxis` 不需要 `format`，就会为每个条带写上它的类别。

相关系数矩阵的两条轴是同一组持仓，`domain` 取系数的完整范围，所以无论是哪些持仓，系数 0 都取色阶的中间色：

```tsx
const tickers = ["NVDA", "AMD", "MSFT", "GLD"];

<Plot
  data={pairs}
  xScale={{ type: "band", domain: tickers, paddingInner: 0.06 }}
  yScale={{ type: "band", domain: tickers, paddingInner: 0.06 }}
  colorScale={{ type: "diverging", domain: [-1, 1], range: [token("chart-2"), token("muted"), token("chart-1")] }}
  class="aspect-square"
>
  <Cell x="b" y="a" value="r" label={(d) => d.r.toFixed(2)} labelClass="text-xs text-black/70 data-dark:text-white" />
</Plot>
```

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `x` | `string \| (d, index) => string` | 无 | 每一行所在的列：字段（它的文字或数字），或返回类别的函数。这一行的格子放进 x 比例尺上这个类别的条带；没有类别的行没有格子。 |
| `y` | `string \| (d, index) => string` | 无 | 每一行所在的行，与 `x` 相同，沿 y 比例尺。 |
| `value` | `string \| (d, index) => number` | 无 | 每个格子的数值，由 `sequential` 或 `diverging` 的 `colorScale` 换算成它的颜色。没有数值的行取比例尺的 `unknown` 颜色，没有 `unknown` 时没有格子。 |
| `color` | `string \| (d, index) => string` | 无 | 每个格子的类别，颜色来自 `ordinal` 的 `colorScale`（见[按类别着色](#colors-by-category)）。 |
| `cornerRadii` | `number \| { topLeft?, topRight?, bottomRight?, bottomLeft? }` | `0` | 格子每个角的半径。 |
| `stagger` | `number` | `0` | plot 出现时，格子按行依次开始长出，开始时间分布在出现动效的这一比例内（0 到 0.95），每个格子用剩下的时间从中心长完；为 0 时一起长出。 |
| `inactiveOpacity` | `number` | 无 | 指针或按键停在一个格子上时，其他格子及其标签的不透明度：随悬停淡入淡出。 |
| `label` | `string \| (d, index) => string` | 无 | `label` 部件：每个格子中央的文字，可以是字段（它的文字或数字），或返回应用格式化好的文字的函数。每个标签在排版后的大小放得进格子时显示，所以窄的 plot 只显示颜色。 |
| `labelClass`、`labelStyle` | `string`、`StyleProp<TextStyle>` | 无 | 标签的字体、字号和颜色。格子在 `colorScale` 上的颜色偏暗时（浅色文字在上面更清楚），它的标签带有 `data-dark` 属性，所以 `data-dark:text-white` 在那里把文字变浅。 |
| `hoverCellClass`、`hoverCellStyle` | `string`、`StyleProp<ViewStyle>` | 无 | `hoverCell` 部件：与指针或按键所在的格子一样大、盖在它上面的视图；`rounded-sm outline-2 outline-foreground` 给它加一圈描边。它在同一帧里跟随指针，按键移动它时按 `pointer` 弹簧滑过去。 |

在应用没有设置 `fill` 时（`fill-*` 类和样式优先，像 CSS 那样从 plot 继承），格子用它在 plot 的 `colorScale` 上的颜色填充，什么都没有设置时为 `currentColor`；设置了 `stroke` 时用它描边。在有格子的 plot 上，plot 报告指针下的格子所在的行，在两个格子之间的间隙里取较近的那个；方向键按屏幕上的网格移动（[键盘](#键盘)），屏幕阅读器按行的顺序浏览。plot 出现时，格子从中心长出；有 `motion.update` 时，格子的颜色过渡到新颜色，新行的格子长出，已移除的行的格子缩小消失，格子移动到新的条带；都在平台的动画器上运行，不需要重新绘制图形。

<a id="pie-and-arc"></a>

## Pie 和 Arc

`Pie` 把一整圈按行分成扇区，每个扇区占各行数值中的份额，从 12 点钟方向开始按行的顺序顺时针排列，围绕 plot 的中心。设置 `innerRadius` 即为环形图。每个扇区都是一个独立的画布，也就是 `slice` 部件，所以每个扇区可以用自己的类着色：`sliceClass` 可以是所有扇区共用的类，也可以是扇区所在行的函数，为每个扇区给出各自的类。在饼图上，plot 报告指针下扇区所在的行（在中间的空洞里或圆环外则没有），提示框跟随指针；该扇区按 `hoverLift` 变大，其他扇区按 `hoverDim` 变淡，由平台的动画器按 plot 的 `motion` 推动。`Arc` 绘制两个角度之间的一段扇形：仪表的轨道和数值，或饼图后面的圆环。

<!-- demo: el-plot-pie -->

```tsx
import { signal, Text, View } from "nsh";
import { Pie, Plot } from "nsh/base/plot";

type Plan = { name: string; seats: number };

const FILLS = ["fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-chart-4"];
const KEYS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4"];

export function Seats(props: { plans: Plan[] }) {
  const hovered = signal<number | null>(null);
  const total = () => props.plans.reduce((sum, p) => sum + p.seats, 0);
  const shown = () => (hovered() == null ? undefined : props.plans[hovered()!]);
  const share = (n: number) => `${((n / total()) * 100).toFixed(1)}%`;
  return (
    <View class="flex-row items-center gap-6 rounded-xl border border-border bg-card p-4">
      <Plot
        data={props.plans}
        accessibilityLabel={`按套餐划分的席位，共 ${total()} 个`}
        accessibilityValue={{ text: shown() && `${shown()!.name}，${shown()!.seats} 个席位，${share(shown()!.seats)}` }}
        appearGeneration={1}
        motion={{ appear: { duration: 900, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 400, damping: 32 } }}
        onHoverChange={({ index }) => hovered.set(index)}
        class="size-44"
      >
        {/* 扇区之间留 2 点的间隙（外缘 80 点处为一圈的 0.025）。 */}
        <Pie
          value="seats"
          innerRadius="62%"
          padAngle={0.025}
          sliceClass={(_, i) => FILLS[i % FILLS.length]}
          hoverLift={6}
          hoverDim={0.64}
        />
        {/* 空洞里显示悬停的套餐，或总数。 */}
        <View class="absolute inset-0 items-center justify-center gap-1">
          <Text class="text-xs text-muted-foreground">{shown()?.name ?? "总计"}</Text>
          <Text class="text-2xl font-semibold tabular-nums text-foreground">{shown()?.seats ?? total()}</Text>
        </View>
      </Plot>
      {/* 图例：每个色块使用对应扇区的颜色，数值和占比靠右。 */}
      <View class="flex-1 gap-1">
        {props.plans.map((plan, i) => (
          <View class="flex-row items-center gap-3 rounded-md px-2 py-1.5" style={{ opacity: hovered() == null || hovered() === i ? 1 : 0.45 }}>
            <View class={`size-2 rounded-sm ${KEYS[i % KEYS.length]}`} />
            <Text class="flex-1 text-sm text-foreground">{plan.name}</Text>
            <Text class="text-right text-sm tabular-nums text-foreground">{plan.seats}</Text>
            <Text class="w-14 text-right text-sm tabular-nums text-muted-foreground">{share(plan.seats)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
```

```rust
use nsh_base::plot::{SliceClass, pie, plot};
use nsh_core::{element::{RowAccessor, Rows}, prelude::*};

fn seats(seats: Vec<f64>) -> impl IntoElement {
    let rows = Rows::from_columns(seats.len(), [("seats".into(), seats)]);
    plot()
        .data(rows)
        .accessibility_label("按套餐划分的席位")
        .w(px(176.0))
        .h(px(176.0))
        .child(
            pie()
                .value(RowAccessor::key("seats"))
                .inner_radius(relative(0.62))
                .slice_class(SliceClass::from_fn(|i| format!("fill-chart-{}", i % 4 + 1).into())),
        )
}
```

| 图形 | 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `Pie` | `value` | `.value(..)` | `keyof T \| (d: T, index: number) => number` | plot 的 `y` | 每一行的数值。数值为零、为负或不是数字的行没有扇区。 |
| `Pie`、`Arc` | `startAngle`、`endAngle` | `.start_angle(..)`、`.end_angle(..)` | `number`（弧度） | `0`、`2 * Math.PI` | 第一个扇区开始和最后一个扇区结束的位置（arc 的两端）：从 12 点钟方向顺时针的弧度。`endAngle` 小于 `startAngle` 时，饼图的扇区反向排列。 |
| `Pie` | `padAngle` | `.pad_angle(..)` | `number`（弧度） | `0` | 相邻扇区在外缘处的间隔角度。每条间隙在各个半径上都保持这个宽度（约 `padAngle * outerRadius` 点），两边平行，所以在圆心或空洞处与外缘处一样宽；太窄而到不了圆心的扇区在两边相交处收尾。只有一个扇区的饼图没有间隙。 |
| `Pie`、`Arc` | `innerRadius`、`outerRadius` | `.inner_radius(..)`、`.outer_radius(..)` | ``number \| `${number}%` `` | `0`、`"100%"` | 空洞和外缘的半径：点数，或 plot 能容纳的最大圆（其较短边的一半）的百分比。 |
| `Pie`、`Arc` | `cornerRadius` | `.corner_radius(..)` | `number` | `0` | 每个扇区（arc）圆角的半径，单位为点，同 d3 的 `arc.cornerRadius`：每个圆角都是一个与边和外缘或空洞边缘相切的圆，间隙的平行边也一样。它最大为圆环厚度的一半，此时 arc 两端是圆头；扇区太窄、放不下两个完整圆角时，两个圆角在扇区中线相接。完整的圆环只保留它的圆形边缘。 |
| `Pie` | `sliceClass` | `.slice_class(..)` | `string \| (d: T, index: number) => string` | 无 | 每个扇区的类（`fill-*`、`stroke-*`）：所有扇区相同，或扇区所在行及其序号的函数；数据行或函数变化时，每行调用一次。 |
| `Pie` | `sliceStyle` | `.slice_style(..)` | `StyleProp<ViewStyle>` | 无 | 所有扇区的样式，优先于它们的类（`fill`、`stroke`、`strokeWidth`）。 |
| `Pie` | `hoverLift` | `.hover_lift(..)` | `number` | `0` | 指针下的扇区比其他扇区大出的距离，单位为点：按 plot 的 `pointer` 弹簧变化，随悬停淡入淡出。 |
| `Pie` | `hoverDim` | `.hover_dim(..)` | `number`（0 到 1） | `0` | 有扇区位于指针下时，其他扇区变淡的程度，即不透明度降低的比例，随悬停淡入淡出。 |
| `Pie` | `color` | `.color(..)` | `keyof T \| (d: T, index: number) => string` | 无 | 每个扇区的类别，颜色来自 plot 的 `colorScale`：在没有任何设置时作为扇区的 `fill`（见[按类别着色](#colors-by-category)）。 |
| `Pie` | `label` | `.label(..)` | `string \| (d: T, index: number) => string` | 无 | 每个扇区旁边的文字：一个字段（取其数值），或返回应用格式化文字的函数。文字为空的行、窄于半度的扇区没有标签。 |
| `Pie` | `labelClass`、`labelStyle` | `.label_class(..)`、`.label_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | `label` 部件：圆环外、引导线末端处的文字，在末端处垂直居中；在饼图右半边时位于末端之后，左半边时位于末端之前。它的内边距就是与引导线末端的距离。 |
| `Pie` | `labelGap` | `.label_gap(..)` | `number` | `15` | 标签在外缘之外的距离，单位为点。 |
| `Pie` | `labelLineClass`、`labelLineStyle` | `.label_line_class(..)`、`.label_line_style(..)` | `string \| (d: T, index: number) => string`、`StyleProp<ViewStyle>` | 无 | `labelLine` 部件：每个标签的引导线，从扇区中线处的外缘向外到标签所在的半径，再横向连到文字。它的 `stroke`（没有设置时为 `currentColor`）、`strokeWidth` 和 `strokeDasharray`，所有引导线相同，或扇区所在行的函数；设置样式后才显示。 |

扇区和 arc 用 `fill` 填充（没有设置时为 `currentColor`，设置 `color` 的扇区为它的类别的颜色），用 `stroke` 描边（没有设置时不描边）；像 CSS 的继承一样，自己设置的值优先于饼图和 plot 上的值：使用界面背景色的描边（`stroke-card stroke-2`）同样可以在扇区之间切出间隙。它们的数值不计入 plot 的比例尺。饼图的扇区只在数据行、数值、角度、半径或 plot 的尺寸变化时重绘；指针只通过动画器推动抬起和变淡。

饼图的数据行在坐标轴上没有位置，所以带饼图的 plot 通常把提示框放在指针旁边（`tooltipPlacement="pointer"`）：十字线和提示框跟随指针，没有悬停圆点。环形图中间的内容是应用自己叠放在 plot 上的元素（悬停扇区的数值或总数），图例也是，每个色块使用对应扇区的颜色。

饼图的标签在圆环外标出各个扇区：每段文字位于扇区中线方向、外缘之外 `labelGap` 处（即该半径上的扇区质心），再横向移到扇区所在一侧的同一半径处；设置样式的引导线把它和外缘连起来。标签随扇区在 plot 出现时扫入、在出现的末段淡入，随 `motion.update` 跟着扇区移动，并随悬停的扇区一起抬起；这些都在平台的动画器上运行。请为标签留出空间：`outerRadius` 小于 `"100%"`，或在 plot 周围留白。应用自己要放在扇区处的内容，是叠放在 plot 上的元素，就像环形图中间的内容一样。

```tsx
<Pie
  value="seats"
  outerRadius="64%"
  sliceClass={(_, i) => FILLS[i % FILLS.length]}
  label={(d) => share(d.seats)}
  labelGap={12}
  labelClass="px-1 text-xs tabular-nums text-muted-foreground"
  labelLineClass="stroke-border"
/>
```

<a id="colors-by-category"></a>

## 按类别着色

plot 的 `colorScale` 为类别分配颜色，同 d3 的 `scaleOrdinal`；图形的 `color` 给出每一行的类别：字段（它的文字或数字），或行的函数。`domain` 中的类别按顺序取 `range` 中的颜色；定义域比值域长时，值域从第一个颜色重新开始。定义域之外的类别取 `unknown`；没有设置时，它在第一次被图形遇到时加入定义域（图形按顺序，每个图形的行按顺序），取下一个颜色，所以完全没有 `domain` 时，各类别按数据行带来它们的顺序取色。颜色由应用决定：CSS 颜色，包括主题的 token。

```tsx
import { Pie, Plot } from "nsh/base/plot";
import { token } from "nsh";

const regions = [
  { name: "北美", revenue: 482 },
  { name: "欧洲、中东和非洲", revenue: 312 },
  { name: "亚太", revenue: 268 },
];

<Plot data={regions} colorScale={{ type: "ordinal", range: [token("chart-1"), token("chart-2"), token("chart-3")] }} class="size-44">
  <Pie value="revenue" color="name" innerRadius="62%" />
</Plot>
```

扇区、柱子和圆点取自己所在行的颜色；`Line` 和 `Area` 各是一个系列，取第一行的颜色，所以使用自己数据行（`data`）的折线就是这些行的类别的颜色，同一个比例尺让一个类别在饼图、柱子和折线上保持同一种颜色。这个颜色在没有任何设置时作为图形的 `fill`（折线的 `stroke`），取代 `currentColor`：应用的类和样式优先，包括部件的（`sliceClass`、`sliceStyle`）、图形自己的以及它从 plot 继承的，所以 `sliceClass={(d) => (d.name === "其他" ? "fill-muted" : "")}` 能让一个扇区与众不同，其余扇区仍由比例尺着色。有 `background` 部件时，柱子和区域的 `fill` 保持为 `none`。

| `OrdinalScale` | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `type` | `"ordinal"` | （必填） | 比例尺的种类。 |
| `domain` | `string[]` | 无 | 类别，按顺序排列。重复出现的类别保留第一次的位置。 |
| `range` | `string[]` | （必填） | 颜色，按顺序排列（CSS 颜色）；第 `i` 个类别取第 `i % range.length` 个颜色。 |
| `unknown` | `string` | 无 | 定义域之外每个类别的颜色；没有设置时，每个类别取下一个颜色。 |

<a id="colors-along-a-ramp"></a>

### 按色阶着色

`type: "sequential"` 或 `"diverging"` 的 `colorScale` 沿色阶为数值分配颜色，同 d3 的 `scaleSequential` 和 `scaleDiverging`，用于 [`Cell`](#cell) 的 `value`。它的 `range` 是两个或更多颜色，从色阶的低端到高端均匀分布，相邻颜色之间在 OKLab 中混合：每一级看起来变化均匀，两种色相经由它们自己的混合色相接。超出 `domain` 的数值取色阶的端点，没有数值的行取 `unknown`。

`sequential` 把 `domain` 铺满整条色阶，应用没有给出定义域时取格子数值的范围：数量、成交量、活跃度。`diverging` 把 `pivot`（默认为 0）放在色阶的中间色上，低于它的数值沿前半段排布，高于它的沿后半段：亏损一种色相，盈利另一种，持平是中性的中间色。应用没有给出定义域时，它取数值的范围并在 pivot 两侧取成对称（Observable Plot 的 `symmetric`），所以同样大小的亏损和盈利颜色一样深；相关系数矩阵写 `domain: [-1, 1]`。

```tsx
colorScale={{ type: "sequential", range: [token("muted"), token("chart-1")] }}
colorScale={{ type: "diverging", pivot: 0, range: [token("destructive"), token("muted"), token("chart-1")] }}
```

| `SequentialScale`、`DivergingScale` | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `type` | `"sequential" \| "diverging"` | （必填） | 色阶的种类。 |
| `domain` | `[number, number]` | 数值的范围（`diverging` 在 pivot 两侧取成对称） | 色阶两端的数值。 |
| `pivot` | `number` | `0` | 仅 `diverging`：色阶中间色对应的数值。 |
| `range` | `string[]` | （必填） | 沿色阶从低端到高端的颜色（CSS 颜色），相邻颜色之间在 OKLab 中混合。 |
| `unknown` | `string` | 无 | 没有数值的行的颜色；没有设置时，这一行没有格子。 |

<a id="radialline-and-radialgrid"></a>

## RadialLine 和 RadialGrid

`RadialLine` 围绕 plot 的中心绘制一个系列：雷达图的多边形，或沿表盘的一条线。每个有值的行是一个点，位于该行的角度上，离中心的距离由 plot 的 y 比例尺根据它的值决定，从 `innerRadius`（定义域的最小值）到 `outerRadius`（定义域的最大值）。没有 `angle` 时，各行按顺序从 12 点钟方向顺时针均匀地绕一圈排列，所以六行就是一个六边形；`closed` 把最后一个点连回第一个点。它描出各点之间的线，并把区域填充到 `innerRadius`（默认是中心），所以一个图形就是雷达图的轮廓和它的淡色填充。`RadialGrid` 在它后面绘制雷达图的网格：`rings` 是 y 比例尺上各个值处的圆环（穿过各行角度的多边形，或 `circular` 的圆），`spokes` 是通向每一行的辐条。在径向线上，plot 报告角度离指针最近、且在该线外半径以内的那一行，每条线的悬停圆点位于它在这一行的点上。

```tsx
import { signal, Text, View } from "nsh";
import { Plot, RadialGrid, RadialLine } from "nsh/base/plot";

type Metric = { name: string; ours: number; theirs: number };

export function Compare(props: { metrics: Metric[] }) {
  const hovered = signal<number | null>(null);
  const shown = () => (hovered() == null ? undefined : props.metrics[hovered()!]);
  return (
    <View class="items-center gap-3 rounded-xl border border-border bg-card p-4">
      <Text class="text-sm tabular-nums text-muted-foreground">
        {shown() ? `${shown()!.name}：我们 ${shown()!.ours}，对手 ${shown()!.theirs}` : "我们与对手"}
      </Text>
      <Plot
        data={props.metrics}
        yScale={{ type: "linear", domain: [0, 100] }}
        accessibilityLabel="我们与对手在六项指标上的对比"
        accessibilityValue={{ text: shown() && `${shown()!.name}：我们 ${shown()!.ours}，对手 ${shown()!.theirs}` }}
        appearGeneration={1}
        motion={{ appear: { duration: 700, easing: "easeOut" }, update: { duration: 400, easing: "easeInOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 380, damping: 34 } }}
        onHoverChange={({ index }) => hovered.set(index)}
        class="size-56"
      >
        <RadialGrid rings={[25, 50, 75, 100]} spokes outerRadius="80%" class="stroke-border" />
        <RadialLine radius="theirs" closed outerRadius="80%" class="fill-chart-2/15 stroke-chart-2" hoverDotClass="size-2 rounded-full border-2 border-card bg-chart-2" />
        <RadialLine radius="ours" closed outerRadius="80%" class="fill-chart-1/25 stroke-chart-1 stroke-2" hoverDotClass="size-2.5 rounded-full border-2 border-card bg-chart-1" />
        {/* 每项指标的名称放在外缘之外、该行的角度上，朝远离中心的方向展开。 */}
        {props.metrics.map((m, i) => {
          const angle = (2 * Math.PI * i) / props.metrics.length;
          const away = (v: number) => (v > 0.01 ? "flex-start" : v < -0.01 ? "flex-end" : "center");
          const align = (v: number) => (v > 0.01 ? "left" : v < -0.01 ? "right" : "center");
          return (
            <View
              class="absolute size-0"
              style={{
                left: `${50 + 44 * Math.sin(angle)}%`,
                top: `${50 - 44 * Math.cos(angle)}%`,
                alignItems: away(Math.sin(angle)),
                justifyContent: away(-Math.cos(angle)),
                pointerEvents: "none",
              }}
            >
              <Text class="w-24 text-xs text-muted-foreground" style={{ textAlign: align(Math.sin(angle)) }}>{m.name}</Text>
            </View>
          );
        })}
      </Plot>
    </View>
  );
}
```

| 图形 | 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `RadialLine` | `radius` | `.radius(..)` | `keyof T \| (d: T, index: number) => number` | plot 的 `y` | 决定每一行离中心多远的取值：y 比例尺上的值，定义域最小值在 `innerRadius`，最大值在 `outerRadius`。没有值的行跳过。 |
| `RadialLine` | `angle` | `.angle(..)` | `keyof T \| (d: T, index: number) => number` | 各行均匀绕一圈 | 每一行在中心周围的位置：从 12 点钟方向顺时针的弧度。 |
| `RadialLine`、`RadialGrid` | `startAngle`、`endAngle` | `.start_angle(..)`、`.end_angle(..)` | `number`（弧度） | `0`、`2 * Math.PI` | 没有 `angle` 时各行的位置：从 `startAngle` 开始均匀排列。绕一整圈时相邻两行相隔一圈的 `1 / 行数`，最后一行在第一行之前一步；只占一圈的一部分时，第一行在 `startAngle`，最后一行在 `endAngle`。 |
| `RadialLine`、`RadialGrid` | `innerRadius`、`outerRadius` | `.inner_radius(..)`、`.outer_radius(..)` | ``number \| `${number}%` `` | `0`、`"100%"` | y 定义域最小值和最大值所在的半径：点数，或 plot 能容纳的最大圆（其较短边的一半）的百分比，与饼图的半径相同。线的区域填充到 `innerRadius`；网格的辐条在两者之间。 |
| `RadialLine` | `curve` | `.curve(..)` | `"linear" \| "natural" \| "stepAfter"` | `"linear"` | 点与点之间如何连接：直线段、平滑曲线（闭合时是平滑的环），或阶梯。 |
| `RadialLine` | `closed` | `.closed(..)` | `boolean` | `false` | 从最后一个点继续连回第一个点：雷达图的多边形。不闭合时，它的区域收拢到中心（或沿内缘回到起点）。 |
| `RadialLine` | `dot`、`dotClass`、`dotStyle` | `.dot(..)`、`.dot_class(..)`、`.dot_style(..)` | `boolean`、`string`、`StyleProp<ViewStyle>` | `false` | 在每个点上显示圆点：以点为中心的视图，尺寸、背景和边框由应用决定。圆点随线一起长出和移动。 |
| `RadialLine` | `backgroundClass`、`backgroundStyle` | `.background_class(..)`、`.background_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 它的背景：包围外圆的盒子，盒子的背景（`bg-*`、渐变）只在它的区域内显示，位于 `fill` 之下，与 area 的背景相同。 |
| `RadialLine` | `hoverDotClass`、`hoverDotStyle` | `.hover_dot_class(..)`、`.hover_dot_style(..)` | `string`、`StyleProp<ViewStyle>` | plot 的 `dotClass`、`dotStyle` | 它的悬停圆点，位于它在指针下那一行的点上，与指针在同一帧移动；按键切换行时按 plot 的 `pointer` 弹簧滑到下一行；`hidden` 表示不显示。 |
| `RadialGrid` | `rings` | `.rings(..)` | `number[]` | 无 | 圆环的位置，取 y 比例尺上的值：每个圆环离中心的距离与径向线对这个值的距离相同。 |
| `RadialGrid` | `spokes` | `.spokes(..)` | `boolean` | `false` | 在每一行的角度上，从 `innerRadius` 到 `outerRadius` 画一条线。 |
| `RadialGrid` | `circular` | `.circular(..)` | `boolean` | `false` | 圆环画成圆（只占一圈的一部分时是圆弧）。默认是穿过各行角度的多边形，plot 少于三行时是圆。 |

径向线用 `stroke`、`strokeWidth` 和 `strokeDasharray` 描边（没有设置时为 `currentColor`，宽 1，实线），用 `fill` 填充区域（没有设置时不填充）；径向网格的描边与网格相同。它们的绘制属性从 plot 继承。plot 没有设置定义域时，线的数值连同 0 构成 y 比例尺的定义域，所以全为正值的雷达图从中心长出；网格的圆环不计入。数值变化时希望圆环和雷达图的刻度保持不动，就为 plot 指定 y `domain`。

雷达图周围的标签是应用自己叠放在 plot 上的元素，就像环形图中间的内容一样。没有 `angle` 时，`n` 行中的第 `i` 行位于从 12 点钟方向起的 `a = 2π·i / n`，所以在正方形的 plot 里，放在 `left: 50% + r·sin(a)`、`top: 50% − r·cos(a)` 的无尺寸盒子（`r` 是 plot 边长的百分比，比外半径所占比例的一半稍大）标出外缘之外的位置，名称从这里朝远离中心的方向展开：右半边向右，左半边向左，顶部向上，底部向下，如上例。

```rust
use nsh_base::plot::{plot, radial_grid, radial_line};
use nsh_core::{element::{RowAccessor, Rows}, prelude::*};

fn compare(ours: Vec<f64>, theirs: Vec<f64>) -> impl IntoElement {
    let rows = Rows::from_columns(ours.len(), [("ours".into(), ours), ("theirs".into(), theirs)]);
    plot()
        .data(rows)
        .accessibility_label("我们与对手")
        .w(px(224.0))
        .h(px(224.0))
        .child(radial_grid().rings(vec![25.0, 50.0, 75.0, 100.0]).spokes(true))
        .child(radial_line().radius(RowAccessor::key("theirs")).closed(true))
        .child(radial_line().radius(RowAccessor::key("ours")).closed(true))
}
```

## Sankey

`Sankey` 绘制 plot 各行之间的流向：每一行是一个节点，`links` 列出它们之间的流，`{ source, target, value }`，前两项是两行在 plot 的 `data` 中的序号。它按 d3-sankey 的方式在 plot 的尺寸内布局：节点按列排列（`nodeAlign`），每个节点的高度取流入和流出中较大的一方，同一列的节点相隔 `nodePadding`，再经过 `iterations` 轮松弛向各自的流靠拢；每条 link 是一条流带，从源节点的右边缘连到目标节点的左边缘，两端的宽度各是它在那一侧所占的份额，所以即使节点的流入和流出不相等，它的两侧也都被流带铺满。每一列在 plot 中垂直居中；连续几列都只有一个等高节点时，这些列会交错错开一点，让它们之间的流带弯曲起来。`valueScale="sqrt"` 按数值的平方根决定尺寸，避免一条特别大的流把小的流压得看不见。

每个节点和每条流带都是一个独立的画布，即 `node` 和 `link` 部件，所以各自可以用自己的类着色：`nodeClass` 可以是所有节点共用的类，也可以是节点所在行的函数；`linkClass` 可以是所有流带共用的类，也可以是 link 的函数。`linkBackground` 部件在每条流带内显示背景，背景框从源节点延伸到目标节点：用 link 的函数可以让每条流带显示从源节点颜色到目标节点颜色的渐变。流带画在节点下面，两者都随 plot 的出场动画从起始边缘画入。

在 sankey 上，plot 报告指针下的节点（`onHoverChange` 报告节点所在的行；在流带上则没有），提示框跟随指针，不与该节点相连的流带按 `hoverDim` 变淡，由平台的动画器按 plot 的 `motion` 推动。方向键按行的顺序在节点之间移动，提示框位于节点中点旁边。`nodeLabel` 为每个节点标上名称，`valueLabel` 给出它的数值，两者都设置时数值在上、名称在下：第一列的节点标在左边，最后一列的标在右边，中间各列的居中标在节点上方，与 `gpui-component` 的图表一致；节点旁边的标签保持在 plot 的上下边缘之内，超出 plot 边缘的标签位于应用在它周围留出的空间（外边距）里。`nodeLabel` 部件的内边距就是它与节点的间距，它的类决定文字样式（`max-w-20 truncate` 截断过长的名称）；标签随出场动画淡入。应用改变流时，每个节点和流带都按 plot 的 `motion.update` 从旧位置移动到新位置，标签随之移动：新出现的节点从中点长出，新出现的 link 从最小宽度展开，消失的立即移除；过渡途中再次改变时，从当前绘制的位置继续。link 按源节点和目标节点区分，所以调整 `links` 的顺序不会产生移动。

```tsx
import { signal } from "nsh";
import { Plot, Sankey } from "nsh/base/plot";

type Step = { name: string };

const steps: Step[] = [{ name: "Visits" }, { name: "Sign-ups" }, { name: "Bounced" }, { name: "Trials" }, { name: "Paid" }, { name: "Churned" }];
const flows = [
  { source: 0, target: 1, value: 4200 },
  { source: 0, target: 2, value: 5800 },
  { source: 1, target: 3, value: 2600 },
  { source: 3, target: 4, value: 1100 },
  { source: 3, target: 5, value: 1500 },
];
// 每一步的颜色：节点的填充色，以及从它出发、到它为止的流带渐变两端。
const FILLS = ["fill-chart-1", "fill-chart-2", "fill-muted", "fill-chart-3", "fill-chart-4", "fill-muted"];
const FROM = ["from-chart-1/40", "from-chart-2/40", "from-muted/40", "from-chart-3/40", "from-chart-4/40", "from-muted/40"];
const TO = ["to-chart-1/40", "to-chart-2/40", "to-muted/40", "to-chart-3/40", "to-chart-4/40", "to-muted/40"];

export function Funnel() {
  const hovered = signal<number | null>(null);
  return (
    <Plot
      data={steps}
      accessibilityLabel="Visits to paid: 10,000 visits, 1,100 paid"
      accessibilityValue={{ text: hovered() == null ? undefined : steps[hovered()!].name }}
      onHoverChange={({ index }) => hovered.set(index)}
      appearGeneration={1}
      motion={{ appear: { duration: 900, easing: "easeOut" }, update: { duration: 500 }, enter: { duration: 120 }, exit: { duration: 160 } }}
      class="mx-20 h-64"
    >
      <Sankey
        links={flows}
        nodeWidth={8}
        nodePadding={16}
        nodeCornerRadius={2}
        nodeClass={(_, i) => FILLS[i]}
        linkBackgroundClass={(link) => `bg-linear-to-r ${FROM[link.source]} ${TO[link.target]}`}
        hoverDim={0.7}
        nodeLabel={(d: Step) => d.name}
        valueLabel={(_: Step, value: number) => value.toLocaleString("en-US")}
        nodeLabelClass="px-2 py-1 text-xs text-muted-foreground"
        valueLabelClass="font-medium text-foreground"
      />
    </Plot>
  );
}
```

```rust
use nsh_base::plot::{RowClass, SankeyLinkClass, SankeyLinks, plot, sankey};
use nsh_core::{element::Rows, prelude::*};

fn funnel() -> impl IntoElement {
    plot()
        .data(Rows::from_columns(4, []))
        .accessibility_label("Visits to paid")
        .h(px(256.0))
        .child(
            sankey()
                .links(SankeyLinks::new([(0, 1, 4200.0), (1, 2, 2600.0), (2, 3, 1100.0)]))
                .node_width(px(8.0))
                .node_class(RowClass::from_fn(|i| format!("fill-chart-{}", i + 1).into()))
                .link_class(SankeyLinkClass::from("fill-foreground/10")),
        )
}
```

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `links` | `.links(..)` | `SankeyLink[]`（`{ source: number; target: number; value: number }`） | 必填 | 各条流：从 `source` 行流向 `target` 行（它们在 plot 的 `data` 中的序号），`value` 是流量。数值不是数字或小于零的 link 不承载流量，也不画流带。 |
| `nodeWidth` | `.node_width(..)` | `number` | `24` | 每个节点的宽度，单位为点。 |
| `nodePadding` | `.node_padding(..)` | `number` | `8` | 同一列节点之间的间距，单位为点；列太挤时会变小。 |
| `nodeAlign` | `.node_align(..)` | `"justify" \| "left" \| "right" \| "center"` | `"justify"` | 每个节点放在哪一列，同 d3-sankey：按它离第一列的深度（`"left"`），按它的流所允许的最右位置（`"right"`），按深度但只发出流的节点紧挨它的目标（`"center"`），或按深度但只接收流的节点放在最后一列（`"justify"`）。 |
| `iterations` | `.iterations(..)` | `number` | `6` | 让节点向各自的流靠拢的松弛轮数。 |
| `valueScale` | `.value_scale(..)` | `"linear" \| "sqrt"` | `"linear"` | 高度和宽度与数值成正比，或与数值的平方根成正比。 |
| `minLinkWidth` | `.min_link_width(..)` | `number` | `1` | 流带的最小宽度，单位为点，让很小的流也看得见。 |
| `nodeCornerRadius` | `.node_corner_radius(..)` | `number` | `0` | 每个节点圆角的半径，单位为点。 |
| `nodeClass` | `.node_class(..)` | `string \| (d: T, index: number) => string` | 无 | 每个节点的类（`fill-*`、`stroke-*`）：所有节点相同，或节点所在行及其序号的函数；数据行或函数变化时，每行调用一次。 |
| `nodeStyle` | `.node_style(..)` | `StyleProp<ViewStyle>` | 无 | 所有节点的样式，优先于它们的类。 |
| `linkClass` | `.link_class(..)` | `string \| (link: SankeyLink, index: number) => string` | 无 | 每条流带的类：所有流带相同，或 link 及其在 `links` 中序号的函数。 |
| `linkStyle` | `.link_style(..)` | `StyleProp<ViewStyle>` | 无 | 所有流带的样式，优先于它们的类。 |
| `linkBackgroundClass` | `.link_background_class(..)` | `string \| (link: SankeyLink, index: number) => string` | 无 | 每条流带背景的类（`bg-*`，渐变：`bg-linear-to-r from-… to-…`），显示在流带内，背景框从源节点延伸到目标节点，位于流带的 `fill` 之下。设置了背景时，流带的 `fill` 在没有设置时为 `none`。 |
| `linkBackgroundStyle` | `.link_background_style(..)` | `StyleProp<ViewStyle>` | 无 | 所有流带背景的样式，优先于它们的类。 |
| `hoverDim` | `.hover_dim(..)` | `number`（0 到 1） | `0` | 有节点位于指针下时，不与它相连的流带变淡的程度，即不透明度降低的比例，按 plot 的 `pointer` 弹簧变化，随悬停淡入淡出。 |
| `nodeLabel` | `.node_label(..)` | `keyof T \| (d: T, index: number) => string` | 无 | 每个节点旁的名称：字段名，或节点所在行及其序号的函数。 |
| `valueLabel` | `.value_label(..)` | `(d: T, value: number, index: number) => string` | 无 | 每个节点旁、名称上方的数值：节点所在行和流入、流出中较大一方（按 links 的原始数值，与 `valueScale` 无关）的函数。 |
| `nodeLabelClass` | `.node_label_class(..)` | `string` | 无 | 每个标签的类，即 `nodeLabel` 部件：内边距是它与节点的间距，文字样式作用于两行文字。 |
| `nodeLabelStyle` | `.node_label_style(..)` | `StyleProp<TextStyle>` | 无 | 每个标签的样式，优先于它的类。 |
| `valueLabelClass` | `.value_label_class(..)` | `string` | 无 | 数值那一行的类，即 `valueLabel` 部件，优先于标签的类。 |
| `valueLabelStyle` | `.value_label_style(..)` | `StyleProp<TextStyle>` | 无 | 数值那一行的样式，优先于它的类。 |

节点和流带用 `fill` 填充（没有设置时为 `currentColor`），用 `stroke` 描边（没有设置时不描边）；像 CSS 的继承一样，自己设置的值优先于 sankey 和 plot 上的值。没有任何流经过的节点高 1 点。只有 links、选项或 plot 的尺寸变化时才会重新布局，指针和出场动画都不会触发布局；plot 的尺寸变化不会产生移动。构成环的 links，或指向 plot 中不存在的行的 links，什么也不画，并记录一条警告。它的数值不计入 plot 的比例尺。


## Treemap

`Treemap` 把 plot 的数据行画成嵌套矩形组成的层级：每一行是一个节点，它的 `id` 和它指向的 `parent` 组成一棵树（d3 的 `stratify`），每个叶子的面积与它的 `value` 成正比，每个组是它下面所有节点的外框，组的值是其叶子之和（不管组自己那一行写了什么）。没有 `parent` 的行，或 `parent` 指向不存在的行，是顶层节点；不给 `id` 时，行的 id 就是它的序号，所以 `parent` 也可以用序号指向父行。gpt-vis 写的嵌套形式（`{ name, value, children }`）由应用用几行代码拍平成数据行即可；层数没有上限。

矩形按 squarify 方式铺排（同 d3 的 `treemapSquarify`）：每一层的节点按值从大到小、从左上角开始（`sort="value"`），长宽比接近 `ratio`（黄金比）；`sort="data"` 保持数据行的顺序，值变化时节点的位置更稳定。`paddingInner` 是兄弟节点之间的缝，父节点的外缘不留；`paddingOuter` 是组内围绕子节点的留白；`paddingTop` 是每个组顶部的标题带，`groupLabel` 写在里面。三者都可以给一个数（所有层相同），或从顶层往下每层一个（`[3, 1]`：顶层节点之间 3，下面各层 1）。同一个父节点的兄弟组，标题带要么都留要么都不留，有一个组放不下时都不留，这样同一层的组看起来一致。

值为 0、负数或不是数字的叶子不占面积：不画、没有标签、指针找不到它；叶子全是这种情况的组也一样。treemap 的面积是整体中的份额，被省略的部分由应用自己说明（地图下方的一行注释）。负数可以用来上色：市场热力图的当日涨跌。

节点的颜色来自 plot 的 `colorScale`：`colorValue` 是沿色带取色的数值（`sequential`、`diverging`：跌为红、涨为绿、持平为中性色；没有 `domain` 时取数值的范围），`color` 是类别（`ordinal`：`"parent"` 让同组的叶子同色）。叶子是 `leaf` 部件（`leafClass`、`leafStyle`），组是 `group` 部件（`groupClass`、`groupStyle`），只有设置了类或样式才画：组是位于子节点下面的矩形，露在缝里、留白里和标题带里。每个部件可以对所有节点相同，也可以是节点所在行的函数。`cornerRadii` 给所有矩形加圆角。

`label` 在每个叶子里写名字，`valueLabel` 在名字下面写数值，它是行和值的函数（组的值是其叶子之和）：放在左上角（`labelPlacement="start"`）或居中（`"center"`）。`label` 部件是一个和叶子一样大的框：它的内边距是离叶子边缘的距离，文字样式作用于各行。叶子比名字窄时名字用省略号截断，只在放得下时显示；数值要么完整显示，要么不显示。叶子颜色较深时标签带有 `data-dark` 属性，所以 `data-dark:text-white` 能让它在深红色上依然清晰。

在 treemap 上，plot 报告指针下的节点（`onHoverChange`，节点所在的行）：叶子，或位于标题带、留白中的组；在兄弟节点之间的缝里取其中一个，所以悬停不会闪烁。其他节点淡到 `inactiveOpacity`（叶子保留它所在的组，组保留它下面的节点），和节点一样大的 `hover` 部件给它描边。方向键移动到屏幕上旁边的叶子，Home 和 End 移动到第一个和最后一个。plot 出场时顶层节点从中心长出，`stagger` 让它们依次出现；数据行变化时，每个节点按 `id` 对应，以 `motion.update` 移动到新的位置和颜色：新出现的节点从中心长出，消失的节点缩回自己的中心。plot 的 x 和 y 比例尺不使用。

<!-- demo: el-plot-treemap -->

```tsx
import { signal } from "nsh";
import { Plot, Treemap } from "nsh/base/plot";

type Row = { id: string; parent?: string; name: string; cap?: number; chg?: number };

const rows: Row[] = [
  { id: "tech", name: "Technology" },
  { id: "fin", name: "Financials" },
  { id: "NVDA", parent: "tech", name: "NVIDIA", cap: 4300, chg: 2.4 },
  { id: "MSFT", parent: "tech", name: "Microsoft", cap: 3700, chg: -0.6 },
  { id: "AVGO", parent: "tech", name: "Broadcom", cap: 1600, chg: 3.1 },
  { id: "JPM", parent: "fin", name: "JPMorgan", cap: 830, chg: 1.3 },
  { id: "V", parent: "fin", name: "Visa", cap: 670, chg: -0.3 },
];

export function MarketMap() {
  const hovered = signal<number | null>(null);
  return (
    <Plot
      data={rows}
      colorScale={{ type: "diverging", domain: [-3, 3], range: ["#dc2626", "#e5e5e5", "#16a34a"] }}
      accessibilityLabel="Market map of 5 stocks in 2 sectors"
      accessibilityValue={{ text: hovered() == null ? undefined : rows[hovered()!].name }}
      onHoverChange={({ index }) => hovered.set(index)}
      appearGeneration={1}
      motion={{ appear: { duration: 800 }, update: { duration: 500 }, enter: { duration: 120 }, exit: { duration: 160 } }}
      class="h-72"
    >
      <Treemap
        id="id"
        parent="parent"
        value="cap"
        colorValue="chg"
        paddingInner={[3, 1]}
        paddingTop={18}
        cornerRadii={2}
        inactiveOpacity={0.35}
        label="id"
        valueLabel={(d: Row) => `${d.chg! > 0 ? "+" : ""}${d.chg}%`}
        labelPlacement="center"
        labelClass="p-1 text-xs font-semibold text-foreground data-dark:text-white"
        groupLabel="name"
        groupLabelClass="px-1 text-xs text-muted-foreground"
        hoverClass="rounded-xs outline-2 outline-foreground"
      />
    </Plot>
  );
}
```

```rust
use nsh_base::plot::{ColorScale, DivergingScale, TreemapPadding, plot, treemap};
use nsh_core::{element::{RowAccessor, RowText, Rows}, prelude::*};

const IDS: [&str; 5] = ["tech", "fin", "NVDA", "MSFT", "JPM"];
const PARENTS: [&str; 5] = ["", "", "tech", "tech", "fin"];

fn market_map() -> impl IntoElement {
    let rows = Rows::from_columns(
        5,
        [
            ("cap".into(), vec![0.0, 0.0, 4300.0, 3700.0, 830.0]),
            ("chg".into(), vec![0.0, 0.0, 2.4, -0.6, 1.3]),
        ],
    );
    plot()
        .data(rows)
        .color_scale(ColorScale::from(
            DivergingScale::new([rgb(0xdc2626), rgb(0xe5e5e5), rgb(0x16a34a)]).domain([-3.0, 3.0]),
        ))
        .accessibility_label("Market map")
        .h(px(288.0))
        .child(
            treemap()
                .id(RowText::from_fn(|i| IDS[i].into()))
                .parent(RowText::from_fn(|i| PARENTS[i].into()))
                .value(RowAccessor::key("cap"))
                .color_value(RowAccessor::key("chg"))
                .padding_inner(TreemapPadding::from([px(3.0), px(1.0)]))
                .padding_top(TreemapPadding::from(px(18.0)))
                .label(RowText::from_fn(|i| IDS[i].into())),
        )
}
```

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `.id(..)` | `keyof T \| (d: T, index: number) => string` | 行的序号 | 每行节点的 id：`parent` 指向的就是它，数据行变化时也靠它认出同一个节点。 |
| `parent` | `.parent(..)` | `keyof T \| (d: T, index: number) => string` | 无：每行都是顶层节点 | 每行父节点的 id；为空或不是任何行的 id 时是顶层节点。 |
| `value` | `.value(..)` | `keyof T \| (d: T, index: number) => number` | 必填 | 每个叶子的大小；组的值是其子节点之和。值为 0、负数或不是数字的叶子不占面积。 |
| `sort` | `.sort(..)` | `"value" \| "data"` | `"value"` | 兄弟节点按值从大到小从左上角开始，或保持数据行的顺序。 |
| `ratio` | `.ratio(..)` | `number` | 黄金比 | 矩形追求的长宽比，至少为 1。 |
| `paddingInner` | `.padding_inner(..)` | `number \| number[]` | `0` | 兄弟节点之间的缝，单位为点，从顶层往下每层一个（更深的层用最后一个）。 |
| `paddingOuter` | `.padding_outer(..)` | `number \| number[]` | `0` | 每个组内围绕子节点的留白，按层给。 |
| `paddingTop` | `.padding_top(..)` | `number \| number[]` | `0` | 每个组顶部的标题带，放 `groupLabel`，按层给；同一父节点的兄弟要么都留要么都不留。 |
| `cornerRadii` | `.corner_radii(..)` | `number \| { topLeft?, topRight?, bottomRight?, bottomLeft? }` | 直角 | 矩形每个角的半径。 |
| `color` | `.color(..)` | `keyof T \| (d: T, index: number) => string` | 无 | 每个节点的类别，`ordinal` 的 `colorScale` 为它取色。 |
| `colorValue` | `.color_value(..)` | `keyof T \| (d: T, index: number) => number` | 无 | 每个节点的数值，`sequential` 或 `diverging` 的 `colorScale` 把它变成颜色。 |
| `leafClass` | `.leaf_class(..)` | `string \| (d: T, index: number) => string` | 无 | 每个叶子的类（`fill-*`、`stroke-*`），所有叶子相同或是叶子所在行的函数。 |
| `leafStyle` | `.leaf_style(..)` | `StyleProp<ViewStyle>` | 无 | 所有叶子的样式，优先于它们的类。 |
| `groupClass` | `.group_class(..)` | `string \| (d: T, index: number) => string` | 无 | 每个组的类，即子节点下面的矩形；只有设置了类或样式才画组。 |
| `groupStyle` | `.group_style(..)` | `StyleProp<ViewStyle>` | 无 | 所有组的样式，优先于它们的类。 |
| `inactiveOpacity` | `.inactive_opacity(..)` | `number`（0 到 1） | 无 | 有节点悬停时，其他节点及其标签的不透明度，随悬停淡入淡出。 |
| `label` | `.label(..)` | `keyof T \| (d: T, index: number) => string` | 无 | 每个叶子里的名字，单行，放不下时用省略号截断。 |
| `valueLabel` | `.value_label(..)` | `(d: T, value: number, index: number) => string` | 无 | 每个叶子里名字下面的数值，只有完整放得下时才显示。 |
| `labelPlacement` | `.label_placement(..)` | `"start" \| "center"` | `"start"` | 标签放在叶子的左上角或居中。 |
| `labelClass` | `.label_class(..)` | `string` | 无 | 叶子标签的类，标签是和叶子一样大的框：内边距和文字样式；深色叶子上带 `data-dark:`。 |
| `labelStyle` | `.label_style(..)` | `StyleProp<TextStyle>` | 无 | 叶子标签的样式，优先于它的类。 |
| `valueLabelClass` | `.value_label_class(..)` | `string` | 无 | 数值那一行的类，优先于标签的类。 |
| `valueLabelStyle` | `.value_label_style(..)` | `StyleProp<TextStyle>` | 无 | 数值那一行的样式，优先于它的类。 |
| `groupLabel` | `.group_label(..)` | `keyof T \| (d: T, index: number) => string` | 无 | 每个组的名字，写在标题带里，放不下时用省略号截断。 |
| `groupLabelClass` | `.group_label_class(..)` | `string` | 无 | 组标签的类，标签是和标题带一样大的框。 |
| `groupLabelStyle` | `.group_label_style(..)` | `StyleProp<TextStyle>` | 无 | 组标签的样式，优先于它的类。 |
| `stagger` | `.stagger(..)` | `number`（0 到 0.95） | `0` | 顶层节点依次出现：它们的开始时间分布在出场动画的这个比例里。 |
| `hoverClass` | `.hover_class(..)` | `string` | 无 | `hover` 部件的类，一个和悬停节点一样大、盖在它上面的视图（`rounded-xs outline-2 outline-foreground`）。 |
| `hoverStyle` | `.hover_style(..)` | `StyleProp<ViewStyle>` | 无 | hover 部件的样式，优先于它的类。 |

矩形用 `fill` 填充（没有设置时用 `colorScale` 的颜色，再没有时为 `currentColor`），用 `stroke` 描边（没有设置时不描边）；像 CSS 的继承一样，自己设置的值优先于 treemap 和 plot 上的值。只有数据行、选项或 plot 的尺寸变化时才会重新布局，指针和出场动画都不会触发布局；plot 的尺寸变化不会产生移动。重复的 `id`、指向不存在的行的 `parent`，以及自己是自己祖先的行，都会记录一次警告：第一行保留这个 id，孤立的行作为顶层节点，成环的行不画。

## PlotAxis

`PlotAxis` 用某条边所对应比例尺的刻度为这条边加上标签：底边和顶边用 x 比例尺的刻度，左边和右边用 y 比例尺的刻度，就像 d3 的 `axisBottom`、`axisTop`、`axisLeft` 和 `axisRight`。刻度来自比例尺：`linear` 比例尺上是定义域内的整齐数值（1、2 或 5 乘以 10 的幂），`point` 或 `band` 比例尺上是数据行。标签是由 plot 的布局摆放的文字：应用决定它写什么、长什么样，布局负责把它放到位置上。每个标签沿边居中对齐自己的刻度。在底边和顶边上，第一个和最后一个只向内移动必要的距离，从而留在 plot 的两端之内；在左边和右边上，每个标签都对在自己的刻度上，读起来就是那条网格线的值；靠近两端的标签如果会超出 plot 的顶边或底边，plot 的线性 y 比例尺就从那条边向内缩进超出的距离（刻度在端点上时是标签高度的一半），所以每个标签都留在 plot 之内，对在自己的网格线上。

```tsx
import { Area, Grid, Line, Plot, PlotAxis } from "nsh/base/plot";

const rows = [
  { day: "Mon", visitors: 1820 },
  { day: "Tue", visitors: 2140 },
  { day: "Wed", visitors: 1960 },
  { day: "Thu", visitors: 2480 },
  { day: "Fri", visitors: 2310 },
];

<Plot data={rows} y="visitors" yScale={{ type: "linear", domain: [0, 3000] }} class="mb-6 ml-10 h-40">
  <Grid y={[0, 1000, 2000, 3000]} class="stroke-border" />
  <Area class="fill-chart-1/20" />
  <Line class="stroke-chart-1 stroke-2" />
  {/* plot 左侧是 0、1,000、2,000 和 3,000，下方每行一个星期几。 */}
  <PlotAxis placement="left" ticks={3} labelClass="pr-2 text-xs tabular-nums text-muted-foreground" />
  <PlotAxis
    format={(i) => rows[i].day}
    labelClass="pt-2 text-xs text-muted-foreground"
    tickClass="h-1 w-px bg-border"
    lineClass="h-px bg-border"
  />
</Plot>
```

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `placement` | `.placement(..)` | `"bottom" \| "top" \| "left" \| "right"` | `"bottom"` | 坐标轴所在的边：底边和顶边对应 x 比例尺的刻度，左边和右边对应 y 比例尺的刻度。 |
| `scale` | `.scale(..)` | `"y" \| "y2"` | `"y"` | 左侧或右侧坐标轴标注哪个 y 比例尺：plot 的 `yScale`，或第二个 `y2Scale`（[双轴](#双轴)）。 |
| `labelPlacement` | `.label_placement(..)` | `"outside" \| "inside"` | `"outside"` | 标签的位置：在边的外侧、应用在 plot 周围留出的空间里，与图形互不遮挡；或在 plot 上沿边内侧排列，plot 保持完整的尺寸（在左边或右边时，每个标签位于自己网格线的上方）。 |
| `ticks` | `.ticks(..)` | `number` | `linear` 比例尺上为 `10`（对齐的比例尺上为每一步），其他比例尺上为每一行 | 大约取多少个刻度：`linear` 比例尺上是定义域内的整齐数值，大约这么多个；`point` 或 `band` 比例尺上是从第一行到最后一行均匀分布的这么多行。 |
| `tickValues` | `.tick_values(..)` | `number[]` | 无 | 刻度的数值，代替 `ticks`：比例尺上的值，`point` 或 `band` 比例尺上是行的序号（`[0, 3, 6]` 每三行标一次）。定义域内的每个值各有一个刻度。 |
| `format` | `.format(..)` | `(value: number, index: number) => string` | 在有类别的 band 比例尺上是条带的类别，其余为数值本身，带上刻度间距所需的小数位，千位分组 | 每个刻度的文字：应用以刻度的数值（`point` 或 `band` 比例尺上是行的序号）和它在坐标轴刻度中的序号为参数的函数。 |
| `labelClass`、`labelStyle` | `.label_class(..)`、`.label_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | `label` 部件：每个刻度一段文字，字体、颜色和内边距由应用决定；朝向 plot 一侧的内边距就是它与边的距离（底部坐标轴用 `pt-2`）。 |
| `tickClass`、`tickStyle` | `.tick_class(..)`、`.tick_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | `tick` 部件：每个刻度在边上一个视图，以刻度为中心，朝标签一侧延伸（底部坐标轴用 `h-1 w-px bg-border`）；设置样式后显示。 |
| `lineClass`、`lineStyle` | `.line_class(..)`、`.line_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | `line` 部件：沿整条边、位于标签一侧的视图（底部坐标轴用 `h-px bg-border`）；设置样式后显示。 |

标签在外侧时位于 plot 的外边距里，就像 d3 的坐标轴位于图表的边距里：plot 保持应用给它的尺寸，应用在坐标轴那一侧给它留出与标签一样深的外边距（下方是 `pt-2 text-xs` 的标签时用 `mb-6`），或者给它的父元素在那一侧加内边距。同一条边上的两个坐标轴各自标注自己的数值、使用自己的样式：比如区间两端的价格较淡，中间的较深。

`format` 在刻度或函数变化时，于下一轮对每个刻度调用一次，绘制和跟随指针时从不调用：请保持它是纯函数（同一个数值得到同一段文字）。没有它时，刻度按 d3 的写法显示：`1,500`、`0.25`、`−2`。在 Rust 中，`plot_axis()` 创建坐标轴，`format` 是 `TickFormat::from_fn(|value, index| ..)`。坐标轴不接收指针，屏幕阅读器读出的是 plot 而不是它的标签。

## PlotLabel

`PlotLabel` 在 plot 的若干点上写文字：峰值上方的说明、折线最后一个点旁的价格标签、网格线末端的注释。它的每个 `texts` 都用 plot 比例尺上的值指定自己的点，与图形相同：`point` 或 `band` 比例尺上是行的序号（band 比例尺上是该行条带的中点），`linear` 比例尺上是数值。文字的上边缘位于这个点上，`align` 让文字从这个点开始、以它为中心或在它这里结束。文字由 plot 的布局摆放，所以会跟随 plot 的尺寸；它们随比例尺的 domain 一起平滑过渡（`motion.update`），并随 appear 淡入。

```tsx
import { Area, Line, Plot, PlotLabel } from "nsh/base/plot";

const rows = [
  { day: "Mon", visitors: 1820 },
  { day: "Tue", visitors: 2140 },
  { day: "Wed", visitors: 1960 },
  { day: "Thu", visitors: 2480 },
  { day: "Fri", visitors: 2310 },
];
const [peak, last] = [3, rows.length - 1];

<Plot data={rows} y="visitors" yScale={{ type: "linear", domain: [0, 3000] }} class="mr-12 h-40">
  <Area class="fill-chart-1/20" />
  <Line class="stroke-chart-1 stroke-2" />
  {/* 峰值上方写出它的数值，最后一个点右侧放一个垂直居中的标签。 */}
  <PlotLabel
    class="text-xs tabular-nums text-muted-foreground"
    texts={[
      { text: `High ${rows[peak].visitors}`, x: peak, y: rows[peak].visitors, align: "center", class: "-translate-y-full pb-1" },
      { text: `${rows[last].visitors}`, x: last, y: rows[last].visitors, class: "-translate-y-1/2 ml-2 rounded bg-chart-1 px-1.5 text-white" },
    ]}
  />
</Plot>
```

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `texts` | `.texts(..)` | `PlotText[]` | `[]` | 要写的文字，每段位于自己的点上。 |
| `scale` | `.scale(..)` | `"y" \| "y2"` | `"y"` | 文字的 `y` 取哪个 y 比例尺上的值（[双轴](#双轴)）。 |

每段文字是一个 `PlotText`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `text` | `string` | | 文字内容。 |
| `x` | `number` | | 沿 x 轴的位置：x 比例尺上的值，`point` 或 `band` 比例尺上是行的序号（`0.5` 位于前两行正中间）。 |
| `y` | `number` | | 上边缘沿 y 轴的位置：y 比例尺上的值。 |
| `align` | `"left" \| "center" \| "right"` | `"left"` | 文字沿 x 方向相对于点的位置：从点开始、以点为中心，或在点处结束。 |
| `class`、`style` | `string`、`StyleProp<TextStyle>` | 无 | 这段文字自己的类名和样式，叠加在它从 label 继承的样式之上：它的盒子（标签的背景和内边距）以及它与点的距离。 |

外观由应用决定：label 的 `class` 给所有文字提供它们继承的文字样式（字体、字号、颜色），每段文字自己的 `class` 和 `style` 只作用于它自己。用 `-translate-y-full` 把文字放到点的上方，它的内边距就是它与点的间距（`pb-1`）；折线最后一个点旁的标签位于应用在那一侧留出的外边距里（`mr-12`），与坐标轴的标签相同。在 Rust 中，`plot_label()` 创建 label，每段文字是 `PlotText::new(text, x, y)`，配合 `.align(PlotTextAlign::Center)`、`.class(..)` 和 `.style(..)`。指针穿过这些文字作用到 plot 上，屏幕阅读器读出的是 plot，由它的 `accessibilityLabel` 说明这些文字标出的内容。

## 动效

动效由应用决定，默认没有：一切立即显示。`motion` 使用 [`nsh`](../modules/nsh.md#animation) 的时间参数（`{ duration, easing, delay }` 和 `{ stiffness, damping, mass }`）：

| 键 | 类型 | 作用 |
|---|---|---|
| `appear` | timing | 有 `appearGeneration` 时图形逐渐绘出：折线和区域从起始边缘绘出，柱子从 `base` 长出（柱子设置 `stagger` 时依次长出）；圆点从无到有长出（圆点设置 `stagger` 时依次长出）；格子从中心长出（格子设置 `stagger` 时依次长出）；饼图和 arc 的圆环从起点顺时针扫出；径向线从内半径长出，圆点随之一起；sankey 的节点和流带从起始边缘画入，标签随之淡入。 |
| `update` | timing | 应用改变图形时，图形过渡到新形状：圆点过渡到新的数值和大小，新行的圆点长出，已移除的行的圆点缩小消失；格子过渡到新的颜色（在 OKLab 中混合）和条带，新行的格子长出，已移除的行的格子缩小消失；饼图和 arc 的半径，比如 donut 的空洞张开和合拢；它们的角度，比如仪表或扇区扫到新的数值（同 d3 的 `arcTween`：过渡的是角度而不是轮廓；新出现的扇区从前一个扇区的结束处展开；过渡途中再次改变时，从当前绘制的位置继续）；径向线的点过渡到新的数值、角度和半径（新出现的行从内半径长出），径向网格的圆环随之移动；以及线性比例尺的 domain（应用给的 `domain`，或随数据行到来而变化的图形数值范围），从旧 domain 平滑过渡到新 domain，图形、网格线、`PlotAxis` 和 `PlotLabel` 一起移动；以及 sankey 的节点、流带和标签，从旧的流的布局移动到新的布局，过渡途中再次改变时从当前绘制的位置继续。 |
| `enter` | timing | 指针移到 plot 上时，悬停部件淡入。 |
| `exit` | timing | 指针离开后，悬停部件淡出。 |
| `pointer` | spring | 按键或屏幕阅读器切换悬停的行时，悬停部件从一行滑到下一行；饼图的扇区也按它抬起。 |

悬停部件与指针在同一帧移动：指针移动时，十字线、圆点和提示框立即落在指针下的那一行，紧跟手的移动，它们的淡入淡出（`enter`、`exit`）仍然带有动画。

动效在平台的动画器上运行，不需要每帧运行 JS；对偏好减少动态效果的用户立即完成。列表为回到视野的行重新创建 plot 时，图形会再绘出一次，除非包住列表的 [`PlotAppearScope`](#plotappearscope) 已经见过它的出现动效播放完。

domain 的过渡与 d3 过渡比例尺 domain 的方式相同：每个数值都由过渡中的比例尺定位，所以图形保持各自的形状，网格线和悬停部件随之移动，柱子保持圆角，和新 domain 一起到来的数据行也随其他部分一起移动。实时图表不时按数据行重新拟合 y 比例尺（留出一些余量，两次拟合之间网格保持不动），设置 `update` 时间参数后，每次重新拟合都会平滑过渡。plot 尺寸变化时，图形立即采用新尺寸。

这是 plot 自己的动效，用来设置图表里动的部分（图形的裁剪区域和悬停部件）的时间参数。视图的入场、离场和强调效果使用 [`createMotion`](../modules/nsh.md#createmotion) 的预设和关键帧，应用仍然可以把它们用在 plot 的视图或周围的元素上。

## PlotAppearScope

列表在行每次回到视野时都会重新创建该行的 plot，所以带出现动效的迷你图在列表滚回来时会再绘出一次。用 `PlotAppearScope` 包住列表，它会记住在其中已经播放完的出现动效：在它里面重新创建的 plot，如果它的 `appearGeneration` 已经在这里播放完，就立即完整显示图形。plot 按它的 generation 记住，所以每一行的 plot 要有自己的 generation：行的键名，加上应当让它重播的内容（`` `${symbol} ${period}` ``）。

```tsx
import { List } from "nsh";
import { Line, Plot, PlotAppearScope } from "nsh/base/plot";

<PlotAppearScope id={watchlist().id} class="flex-1">
  <List each={watchlist().rows} keyExtractor={(row) => row.symbol} estimatedItemSize={48} class="flex-1">
    {(row) => (
      <Plot
        data={row().closes}
        y="close"
        interactive={false}
        appearGeneration={`${row().symbol} ${period()}`}
        motion={{ appear: { duration: 400, easing: "easeOut" } }}
        class="h-8 w-24"
      >
        <Line class="stroke-chart-1 stroke-[1.5]" />
      </Plot>
    )}
  </List>
</PlotAppearScope>
```

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `.id(..)` | `number \| string` | 无 | scope 为什么内容记忆：它变化时，scope 忘掉记住的内容，其中的 plot 在原处重新绘出。按内容命名，比如一个自选列表或一段对话；没有它时，scope 在显示期间一直记住。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 它包含的内容：列表，或任何随显示和移除重新创建其中 plot 的内容。 |

新的 generation 仍然会让 plot 绘出；出现动效还没播放完就被移除的 plot，也会从头再绘出一次。plot 播放完一个新的 generation 后，scope 会忘掉它之前的那个，所以切回之前的周期时 plot 会再绘出一次。记忆随 scope 一起消失：不再显示的 scope，或者 `id` 变化的 scope，其中的 plot 都会重新绘出；plot 在包住它的最内层 scope 中记忆。scope 的外观由应用决定：`class` 和 `style` 像对任何视图一样为它布局（包住铺满屏幕的列表时用 `flex-1`）。在 Rust 中，用 `plot_appear_scope()` 创建。

## 键盘

可交互的 plot 是 Tab 的一个停靠点（macOS、Web）；获得键盘焦点时，按键移动的就是指针驱动的同一个悬停：十字线、圆点和提示框按 `pointer` 弹簧滑动，饼图的扇区抬起，`onHoverChange` 报告这一行，屏幕阅读器读出应用为它给出的 `accessibilityValue`。焦点环由应用决定：`focus-visible:` 类或 `focusStyle`（`focus-visible:outline-2 focus-visible:outline-ring`）。

| 按键 | 作用 |
|---|---|
| 右方向键、左方向键 | 移动到屏幕上那一侧的行：下一行或上一行，在第一行位于右侧的反向 x 比例尺上则反过来（饼图按行的顺序移动到各扇区，sankey 移动到各节点，treemap 和上下方向键一样移动到屏幕上旁边的叶子）；没有悬停的行时，右方向键从最左端的行开始，左方向键从最右端的行开始（饼图上是第一个和最后一个扇区）。 |
| Home、End | 移动到第一行或最后一行。 |
| 上方向键、下方向键 | 在格子上：移动到同一列中上方或下方的格子。在格子上，按键按屏幕上的网格移动（WAI-ARIA 的数据网格）：右方向键和左方向键移动到同一行中旁边的格子，Home 和 End 移动到这一行的第一个和最后一个格子；没有悬停的格子时，第一次按键从左上角的格子开始（左方向键、上方向键和 End 从右下角开始）。到达边缘时悬停保持不动。 |
| Escape | 清除悬停。 |

plot 获得焦点时响应这些按键，有悬停的行时响应 Escape；其余时候按键交给应用和周围的视图。焦点移走时，按键产生的悬停随之清除。plot 不接收点按，所以放在可点按卡片里的 plot 会把点按留给卡片。屏幕阅读器也能逐行浏览：VoiceOver 的上下轻扫、TalkBack 的向前滚动和向后滚动，以及提供元素 `increment` / `decrement` 操作的屏幕阅读器，都会移动到下一行和上一行，在反向比例尺上同样按行的顺序。

## 构建图表

一个图表由 plot、它的图形、它的坐标轴以及应用自己放在周围的元素组成。为 y 比例尺指定 `domain`，并把网格线的数值交给它的坐标轴（`tickValues`），每个标签就正好对齐自己的网格线。悬停的十字线、圆点和提示框是 plot 的部件，由应用设置样式和内容；该行的数值显示在应用想放的地方。

网格线用实线细线、底部基线稍深时最清楚，虚线就可以专门表示参考值（下例中的开盘价）。area 用朝基线渐隐的淡色比平涂更轻盈。每个系列的悬停圆点用该系列的颜色，描边用图表所在表面的颜色，从折线上“挖”出来；提示框位于 plot 顶部，在第一行和最后一行时也留在边缘以内，`domain` 在最高值之上留出空间，提示框就不会盖住折线。

```tsx
import { signal, Text, View } from "nsh";
import { Area, Grid, Line, Plot, PlotAxis } from "nsh/base/plot";

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
        onHoverChange={({ index }) => hovered.set(index)}
        class="mr-10 mb-6 h-48"
      >
        <Grid y={[middle(), props.high]} class="stroke-border" />
        {/* 朝基线渐隐的淡色。 */}
        <Area backgroundClass="bg-linear-to-b from-chart-1/20 to-transparent" />
        <Grid y={[props.low]} class="stroke-muted-foreground/40" />
        <Grid y={[props.rows[0].price]} class="stroke-muted-foreground" style={{ strokeDasharray: "3 3" }} />
        <Line class="stroke-chart-1 stroke-2" hoverDotClass="size-2.5 rounded-full border-2 border-card bg-chart-1" />
        {/* plot 右侧是网格线的数值，下方是第一行和最后一行的时间。 */}
        <PlotAxis
          placement="right"
          tickValues={[props.low, middle(), props.high]}
          format={(v) => v.toFixed(0)}
          labelClass="pl-2 text-xs tabular-nums text-muted-foreground"
        />
        <PlotAxis
          tickValues={[0, props.rows.length - 1]}
          format={(i) => props.rows[i].time}
          labelClass="pt-2 text-xs text-muted-foreground"
        />
      </Plot>
    </View>
  );
}
```

柱状图在柱子顶端圆角、底部方角时最清楚（`cornerRadii={{ topLeft: 4, topRight: 4 }}`；堆叠时只给最上面的柱子），同一条带里的柱子之间留一点空隙（`groupPadding`），悬停某一行时其他行的柱子变淡（`inactiveOpacity`）、它的条带上色（`crossLineClass`），数值用小号等宽数字放在柱子上方，堆叠时显示总数。`paddingOuter` 取 `paddingInner` 的一半时，条带的中线等距分布，`PlotAxis` 把每个月份居中放在它的条带下方；`maxBandWidth` 让宽卡片里的少量柱子保持窄。

```tsx
import { signal, Text, View } from "nsh";
import { Bar, Grid, Plot, PlotAxis } from "nsh/base/plot";

type Sale = { month: string; online: number; store: number };

export function SalesChart(props: { rows: Sale[]; stacked: boolean }) {
  const hovered = signal<number | null>(null);
  const shown = () => props.rows[hovered() ?? props.rows.length - 1];
  const tip = { topLeft: 4, topRight: 4 };
  return (
    <View class="gap-3 rounded-xl border border-border bg-card p-4">
      <View class="flex-row items-baseline">
        <Text class="flex-1 text-sm text-muted-foreground">{shown().month}</Text>
        <Text class="text-right text-sm tabular-nums text-foreground">{`${shown().online + shown().store}k`}</Text>
      </View>
      <Plot
        data={props.rows}
        xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.15, maxBandWidth: 56, groupPadding: 0.1 }}
        yScale={{ type: "linear", domain: [0, 130] }}
        accessibilityLabel="每月销售额，线上和门店"
        appearGeneration={props.stacked ? 1 : 0}
        motion={{ appear: { duration: 600, easing: "easeOut" }, enter: { duration: 150 }, exit: { duration: 150 }, pointer: { stiffness: 320, damping: 32 } }}
        crossLineClass="w-full h-full bg-foreground/5"
        onHoverChange={({ index }) => hovered.set(index)}
        class="mb-6 h-44"
      >
        <Grid y={[40, 80, 120]} class="stroke-border" />
        <Bar
          value="online"
          stack={props.stacked ? "sales" : undefined}
          cornerRadii={props.stacked ? 0 : tip}
          stagger={0.4}
          inactiveOpacity={0.45}
          label={props.stacked ? undefined : "online"}
          labelClass="pb-1 text-[11px] tabular-nums text-muted-foreground"
          class="fill-chart-1"
        />
        <Bar
          value="store"
          stack={props.stacked ? "sales" : undefined}
          cornerRadii={tip}
          stagger={0.4}
          inactiveOpacity={0.45}
          label={props.stacked ? (d) => String(d.online + d.store) : "store"}
          labelClass="pb-1 text-[11px] tabular-nums text-muted-foreground"
          class="fill-chart-2"
        />
        {/* 每个条带下方居中一个月份。 */}
        <PlotAxis format={(i) => props.rows[i].month} labelClass="pt-2 text-xs text-muted-foreground" />
      </Plot>
    </View>
  );
}
```

列表行中的迷你图是一个 `interactive={false}` 的 plot：只绘制图形，不跟随指针。

## 无障碍

- plot 对屏幕阅读器是一个元素，角色为图像，读出应用的 `accessibilityLabel`；图形、坐标轴的标签、`PlotLabel` 和悬停部件是它的组成部分，自己不读出任何内容。在标签中说明图表显示了什么以及值得注意的地方（范围、最高值），并用 `accessibilityValue` 给出指针下那一行的描述，屏幕阅读器就会随之读出数值。
- 在有指针的平台上（桌面、网页、配触控板的 iPad），指针下的行通过 `onHoverChange` 报告。触摸屏没有悬停：触摸用户需要的数值请用应用自己的元素显示；数字很重要时，再用文字或列表提供数据行。
- 在饼图上，报告的行是指针下扇区所在的行：用 `accessibilityValue` 给出它的名称、数值和占比（`"团队版，340 个席位，34.0%"`），并在标签中说明总数和最大的份额。在雷达图上，报告的是离指针最近的那一项指标：给出指标的名称和每个系列在这一项的数值。
- 可交互的 plot 是键盘焦点的一个停靠点，方向键移动悬停的行（[键盘](#键盘)）；它还向屏幕阅读器提供 `increment` 和 `decrement`，用于逐行浏览（VoiceOver 把它读作可调节）。`interactive={false}` 的 plot 两者都没有；无论哪种，plot 都不接收点按。

关于标签和角色的一般说明，见 [无障碍](../docs/accessibility.md)。

## 平台说明

- 所有平台以相同的方式绘制图形：每个图形一份在 Rust 中录制的绘图。数据行变化时，读取它们的图形在一个批次中重绘；绘制类名的变化（外观、`dark:`）只会重新发送绘图，不需要重新录制。
- 出现动效用平台动画器推动的值裁剪折线和区域、让柱子长出；柱子在悬停行以外变淡，是动画器根据悬停位置算出的不透明度；悬停部件是由动画器移动和淡入淡出的视图，动画器还根据 plot 和提示框的尺寸把提示框留在 plot 内。
- area 的背景画在它自己的画布里，裁剪到 area 的形状，使用的渐变与平台为视图的 `bg-linear-*` 绘制的相同；它的类名变化（外观、`dark:`）只会重新发送绘图，不需要重新录制。
- 饼图的每个扇区画在自己的画布里；指针下的扇区在 Rust 中根据扇区的角度和半径找出，它的抬起是一个半径、其他扇区的变淡是一个不透明度，都由动画器推动；出现动效的扫出也以同样方式推动扇区的角度，所以两者都不需要重新录制绘图。
- 径向线指针下的行在 Rust 中根据各点的角度找出；它的悬停圆点是由动画器摆放在指针下那一行的视图（按键切换时按 `pointer` 弹簧滑动）；出现或过渡到新数值时，各点是由动画器从原来位置推动的数，所以每次变化只录制一次。
- 圆点图形画在一个画布里；指针下的圆点在 Rust 中根据各圆点的中心和半径找出，它的悬停圆点是由动画器摆放在它上面、与它一样大的视图；出现时的长出、变化时的移动和悬停时的变淡都是由动画器推动的值，所以每次变化只录制一次绘图。
- 格子图形画在一个画布里；指针下的格子在 Rust 中根据各格子的范围找出，它的悬停格子是由动画器摆放在它上面的视图；长出、变化时的颜色和移动以及悬停时的变淡都是由动画器推动的值，所以每次变化只录制一次绘图。每个标签都是平台自己的文字，在排版后的大小放得进格子时显示。
- 坐标轴的标签、刻度线和轴线是平台自己的文字和视图，由 Rust 中的布局根据 plot 的尺寸和比例尺摆放：plot 尺寸变化时它们随图形一起移动，定义域变化时标签会重新写出。
