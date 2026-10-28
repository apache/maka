---
title: Plot
description: "The Plot component of nsh/base/plot, its marks Line, Area, Bar, Grid, Pie and Arc and its PlotAxis: charts drawn natively from the app's rows, with the scales of the axes and their labels, the row or slice under the pointer, motion and no look of their own."
order: 20.9
group: base
demo: el-plot
---

# Plot

A plot is the frame of a chart: the rows of data it shows, the scales of its x and y axes, the pointer over it and its
motion. Its marks draw what it holds: a `Line` through a series, an `Area` between a series and a baseline, a `Bar`
per row in the bands of a band scale, a `Grid` of lines across, a `Pie` of the rows' shares (a donut with a hole) and
an `Arc` between two angles; a `PlotAxis` labels an edge with the ticks of its scale. Each mark is one canvas filling the plot, drawn natively from the rows: the app's rows are read once when
it sets them, then scaled, recorded and drawn in Rust, so a chart of a thousand points runs no JS per point. The pointer
is followed in Rust too: the hover's cross line, dots and tooltip move and fade on the platform's animator, and the app
hears of a new row, nothing more. The look is the app's: marks paint with CSS's paint properties of SVG shapes
(`stroke-*`, `fill-*`), `currentColor` where none is set, an area or a bar shows a background (a gradient,
`bg-linear-*`) inside its shape, and the hover's parts (each mark's dot among them) and the axes' labels, tick marks and
lines are the app's to style and fill.

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
        .accessibility_label("Visitors per day")
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
        {hovered() == null ? "Visitors" : `${rows[hovered()!].day}: ${rows[hovered()!].visitors}`}
      </Text>
      <Plot
        data={rows}
        y="visitors"
        yScale={{ type: "linear", domain: [0, 3000] }}
        accessibilityLabel="Visitors per day, highest on Thursday"
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

`Plot`, `Line`, `Area`, `Bar`, `Grid`, `Pie`, `Arc` and `PlotAxis` come from `nsh/base/plot`, a module of [`nsh/base`](../modules/nsh-base.md) of their
own (in Rust, `nsh_base::plot`). In TypeScript a plot's props are generic over the type of its rows: field names are
checked against them, and a function of a row gets the row's type. In Rust, `plot()` makes one with a setter per prop,
the rows a `Rows` (columns of numbers by key), the values a `RowAccessor` (a key or a function of the row's index), and
the marks take the typed paint methods (`.stroke_color(..)`, `.fill_color(..)`, `.stroke_width(..)`).

## Plot

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `data` | `.data(..)` | `T[]` | (required) | The rows, one object per point. The marks read their values once, when the app sets the rows; a row without a value (a field that is not a number, `null`) is skipped. |
| `x` | `.x(..)` | `keyof T \| (d: T, index: number) => number` | the row's index | What places a row along the x axis on a `linear` x scale. A `point` scale places the rows in order. |
| `y` | `.y(..)` | `keyof T \| (d: T, index: number) => number` | none | What the marks draw unless they name their own. |
| `xScale` | `.x_scale(..)` | `Scale` | `{ type: "point" }` | How the x axis places rows: `point` (in order, evenly from the left edge to the right one; one row in the middle), `linear` with an optional `domain`, or `band` (a band per row, for bars; [Bar](#bar)). With a `band` y scale it defaults to `linear`, for bars across. `reverse: true` runs it from the right edge ([Reversed scales](#reversed-scales)). |
| `yScale` | `.y_scale(..)` | `Scale` | `{ type: "linear" }` | How the y axis places values: the domain's smallest value at the bottom edge, its largest at the top. Without a `domain`, the extent of what the marks draw. `band` lays a band per row from the top edge down, for bars across. `reverse: true` runs it the other way: the smallest value at the top edge, the rows from the bottom edge up ([Reversed scales](#reversed-scales)). |
| `interactive` | `.interactive(..)` | `boolean` | `true` | The plot follows the pointer and the keyboard: it reports the row under it and shows the hover's parts, and it is a stop of Tab whose arrow keys move the hover ([Keyboard](#keyboard)). `false` draws the marks only (a sparkline in a list), and presses on it go to the views around it. Whether the plot offers the keyboard at all is set when it is made. |
| `motion` | `.motion(..)` | `PlotMotion` | none | The timing of the appear, the hover's fade in and out, and the spring the hover follows the pointer with (below). |
| `appearGeneration` | `.appear_generation(..)` | `number` | none | Opts in to the appear: the marks draw in when the plot is first shown, and again whenever this changes (another symbol, another period). |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say of the chart: what it shows and what stands out. |
| `accessibilityValue` | `.accessibility_value(..)` | `{ min?, max?, now?, text? }` | none | What screen readers hear as its value: the app's words for the row under the pointer. |
| `crossLineClass`, `crossLineStyle` | `.cross_line_class(..)`, `.cross_line_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The cross line: a view as tall as the plot, centered on the row under the pointer. On a band scale it sits in the row's band, as wide as the band (across the plot on a band y scale). |
| `dotClass`, `dotStyle` | `.dot_class(..)`, `.dot_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The hover's dots: a view per `Line` and `Area`, centered on its point at the row under the pointer. A mark's `hoverDotClass` / `hoverDotStyle` replace them for its own dot. |
| `tooltipContent` | `.tooltip_content(..)` | `JSX.Element` | none | The app's tooltip, placed by `tooltipPlacement` and moved and faded with the cross line. |
| `tooltipPlacement` | `.tooltip_placement(..)` | `"top" \| "pointer"` | `"top"` | Where the tooltip goes: at the top of the plot, centered on the cross line; or beside the pointer, on the side of the cross line toward the plot's middle and below the pointer in the upper half, above it in the lower one. At the top it stays between the plot's left and right edges (its offset from the top edge is the app's: a tag under the plot takes the plot's height and more); beside the pointer it stays inside the plot. With the keyboard, it goes beside the first line's or area's point at the row (the middle of a bar's band, the middle of a pie's slice). |
| `tooltipOffset` | `.tooltip_offset(..)` | `number` | `0` | The distance between the tooltip and what places it: the top edge for `"top"`, the cross line and the pointer for `"pointer"`. |
| `children` | `.child(..)` | `JSX.Element` | none | The marks, drawn in order over each other, and whatever the app lays over them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The plot's size and look; the marks inherit its paint properties, as CSS inherits them. `focus:` / `focus-visible:` classes and `focusStyle` draw its focus ring. |

| Event | Rust | Payload | When |
|---|---|---|---|
| `onHoverChange` | `.on_hover_change(..)` | `{ index: number \| null }` | The pointer came over another row: the index of the row nearest to it along the x axis (along the y axis when only it has bands), or of the [pie](#pie-and-arc)'s slice under it; `null` once it leaves the plot (over a pie, its slices). |

`Scale` is `{ type: "point"; reverse? } | { type: "linear"; domain?: [number, number]; reverse? } | { type: "band";
paddingInner?; paddingOuter?; maxBandWidth?; bandCount?; groupPadding?; reverse? }`. A `domain` is the extent of its
two values, in either order; a domain of one value puts it in the middle. A `band` scale's options are in [Bar](#bar).

A function of a row (`y={(d) => d.high - d.low}`) is called once per row when the rows or the function change, in the
next turn, never while the plot draws or follows the pointer: keep it pure (the same row, the same number). A field
name is read with no JS at all.

### Reversed scales

`reverse: true` runs a scale from its other edge, as visx's scales take `reverse` and d3's take a range written
backwards. On the x axis the first row, or the domain's smallest value, is at the right edge; on the y axis the
domain's smallest value is at the top edge and the rows run from the bottom edge up. Everything placed on the scale
follows it: the marks, the bars' base and the way they grow, an area's baseline, the grid lines, the `PlotAxis` ticks,
the row the hover finds, the arrow keys ([Keyboard](#keyboard)) and the moves to a new domain. Bars hang from the top
edge on a reversed `linear` y scale, and bars across grow leftward from the right edge on a reversed `linear` x
scale:

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

With the plot's appear, lines and areas draw in from the edge the x scale starts at, the right one when it is
reversed.

## Line, Area and Grid

| Mark | Prop | Type | Default | Description |
|---|---|---|---|---|
| `Line` | `y` | `string \| (d, index) => number` | the plot's `y` | What it draws: one point per row with a value, the rows without one skipped. |
| `Line`, `Area` | `data`, `x` | `T[]`, `string \| (d, index) => number` | the plot's rows | Rows of a series of its own (other x values), placed on the plot's scales by its own `x` (a row's index without). |
| `Line`, `Area` | `curve` | `"natural" \| "linear" \| "stepAfter"` | `"natural"` | How it connects its points: a smooth curve, straight segments, or steps that hold each value until the next row. An area's bottom edge follows the same curve. |
| `Line` | `dot`, `dotClass`, `dotStyle` | `boolean`, `string`, `StyleProp<ViewStyle>` | `false` | A dot on every point: a view centered on it, its size, background and border the app's. |
| `Line`, `Area` | `hoverDotClass`, `hoverDotStyle` | `string`, `StyleProp<ViewStyle>` | the plot's `dotClass`, `dotStyle` | Its hover dot, on its point at the row under the pointer: each series' dot in its own color. Each replaces the plot's for this mark (a mark's color over the plot's size and ring); `hidden` shows none. |
| `Area` | `backgroundClass`, `backgroundStyle` | `string`, `StyleProp<ViewStyle>` | none | Its background: a box around its shape (from its first point to its last, from its highest point to its baseline, or to its bottom edge's lowest point on a band) whose background (`bg-*`, `bg-linear-to-b from-… to-…`, `backgroundImage`) shows only inside the shape, under its `fill`. With one, `fill` is `none` where none is set. |
| `Area` | `y1` | `string \| (d, index) => number` | the plot's `y` | What makes its top edge. |
| `Area` | `y0` | `number \| string \| (d, index) => number` | the y scale's low edge | Its bottom edge: a number is a baseline on the y scale; a field or a function gives each row its own bottom value, which makes the area a band (a day's low to its high, a forecast's range). Without one, the area closes to the edge where the y scale's smallest values are: the bottom edge, the top one on a reversed scale (an area hanging from the top). A row without a value at either edge is skipped. |
| `Grid` | `x` | `number[]` | none | Where its vertical lines go, as values of the x scale (row indices on a `point` scale). |
| `Grid` | `y` | `number[]` | none | Where its horizontal lines go, as values of the y scale. |

Each mark fills the plot and paints with its [SVG paint properties](../modules/style-reference.md#svg-paint), its own
over those of the plot, as CSS inherits them:

| Mark | Paints with | Where none is set |
|---|---|---|
| `Line` | `stroke`, `strokeWidth`, `strokeDasharray` | `currentColor`, 1 wide, solid |
| `Area` | `fill` (over its `background` part); its top edge `stroke`, `strokeWidth`, `strokeDasharray` | `fill` `currentColor` (`none` beside a background); no stroke |
| `Grid` | `stroke`, `strokeWidth`, `strokeDasharray` | `currentColor`, 1 wide, solid; each line on whole device pixels, so a thin one stays sharp |

The values a `Line` or an `Area` draws, an area's `y0` too (its baseline, or each row's bottom value), make the y
scale's domain when the plot has none; a grid's do not. A mark draws again only when what it draws changes (its rows,
values, curve, the plot's size or scales, its paint); the pointer moves the hover's parts and never draws a mark again.

A band is an `Area` whose `y0` reads the rows: its top edge runs through `y1`, its bottom edge back through `y0`, both
with the area's `curve`, and the appear draws both in from the leading edge. Its hover dot sits on the top edge; a
`Line` over it marks the middle value:

```tsx
<Plot data={days} y="close">
  <Area y1="high" y0="low" class="fill-chart-1/15" hoverDotClass="hidden" />
  <Line class="stroke-chart-1 stroke-2" />
</Plot>
```

`fill` is CSS's, as in a browser: a color. A gradient under a line is an area's background, the way a page shows a
gradient in a shape (a box's `background-image` under `clip-path`): `backgroundClass="bg-linear-to-b from-chart-1/20
to-transparent"` fades from the area's highest point to its baseline, in the theme's tokens and the appearance's
colors like any view's background.

## Bar

A `Bar` draws a bar per row in the row's band of a `band` scale: upright on a band x scale, across on a band y scale
(the x scale then `linear`). Each bar runs from `base` to the row's value on the other scale, so a negative value
grows the other way, and a row without a value has no bar. On a reversed value scale the bars grow down from the top
edge or leftward from the right one, and a reversed band scale puts the first row's band at the right or the bottom
([Reversed scales](#reversed-scales)).

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

Bars outside a stack stand side by side in each band, in the order of the marks; bars with the same `stack` pile up,
each row's bar starting where the one before it in the stack ends:

```tsx
<Bar value="online" stack="sales" class="fill-chart-1" />
<Bar value="store" stack="sales" class="fill-chart-2" cornerRadii={{ topLeft: 4, topRight: 4 }} label={(d) => `${d.online + d.store}`} />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `string \| (d, index) => number` | the plot's `y` | What each bar shows. |
| `base` | `number` | `0` | The value its bars grow from, on the value scale. It counts in the domain. A stack grows from its first bar's. |
| `stack` | `string` | none | The stack it joins: the bars with the same `stack` pile up in order (a row without a value adds nothing). |
| `cornerRadii` | `number \| { topLeft?, topRight?, bottomRight?, bottomLeft? }` | `0` | The radius of each corner of its bars; `{ topLeft: 4, topRight: 4 }` rounds the tips of upright bars. A radius larger than half a bar fits it. |
| `stagger` | `number` | `0` | With the plot's appear, the bars start one after another, row by row, over this share of it (0 to 0.95), each growing for the rest; 0 grows them together. |
| `inactiveOpacity` | `number` | none | The opacity of its bars away from the row under the pointer while the pointer is over the plot, so that row stands out: it fades in and out with the hover and passes from bar to bar as the hover glides. |
| `label` | `string \| (d, index) => string` | none | The text at each bar's value end: a field (its number) or a function returning the text the app formats. |
| `labelClass`, `labelStyle` | `string`, `StyleProp<TextStyle>` | none | The `label` part: a text centered on the bar, above an upright bar's end (below one growing down), after a bar across (before one growing back). Its padding is its distance from the bar. |
| `backgroundClass`, `backgroundStyle` | `string`, `StyleProp<ViewStyle>` | none | Its background: each bar's box, whose background (`bg-linear-to-t from-… to-…`, from the bottom of the bar to its top) shows only inside the bar, under its `fill`. With one, `fill` is `none` where none is set. |

The band scale lays out a band per row of the plot, in order, as d3's `scaleBand` does:

| Option | Default | Description |
|---|---|---|
| `paddingInner` | `0` | The gap between neighbouring bands, a share of each band's step (0 to 1). |
| `paddingOuter` | `0` | The gap before the first band and after the last, a share of a step. Half of `paddingInner` puts the bands' middles at equal steps across the plot. |
| `maxBandWidth` | none | The widest a band may be, in points: a few bands across a wide plot stay narrow, each in the middle of its place. |
| `bandCount` | the rows | The bands the axis is laid out for when more than the rows: the rows take the leading ones and keep their width and place as rows come. |
| `groupPadding` | `0` | The gap between the bars side by side in a band, a share of each bar's place. |
| `reverse` | `false` | The bands run from the other edge: the first row's at the right of the x axis, at the bottom of the y axis; the bars side by side in a band keep their order. |

A bar paints with its `fill` (`fill-*`; inherited from the plot as CSS inherits it), `currentColor` where none is set,
and shows no hover dot. On a band scale, the hover finds the band under the pointer, and the plot's cross line sits in
that band, as wide as it: `crossLineClass="w-full h-full bg-foreground/5"` tints the band, `w-px` keeps a line in its
middle. The bars' values and base make the value scale's domain when the plot has none. With the plot's appear, each
bar grows out of its stack's base; the motion, the fading and the gliding run on the platform's animator, and the
pointer draws no bar again.

## Pie and Arc

A `Pie` splits a turn into a slice per row, each its share of the rows' values, clockwise from 12 o'clock in the rows'
order, around the plot's center. An `innerRadius` makes it a donut. Each slice is a canvas of its own, the `slice`
part, so each paints with its own classes: `sliceClass` is the same classes on every slice, or a function of the
slice's row that gives each its own. Over a pie, the plot reports the row of the slice under the pointer (none in the
hole or outside the ring), its tooltip follows the pointer, and that slice grows by `hoverLift` while the others fade
by `hoverDim`, on the platform's animator with the plot's `motion`. An `Arc` draws one sector between two angles: a
gauge's track and its value, or a ring behind a pie.

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
        accessibilityLabel={`Seats by plan, ${total()} in all`}
        accessibilityValue={{ text: shown() && `${shown()!.name}, ${shown()!.seats} seats, ${share(shown()!.seats)}` }}
        appearGeneration={1}
        motion={{ appear: { duration: 900, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 400, damping: 32 } }}
        onHoverChange={({ index }) => hovered.set(index)}
        class="size-44"
      >
        {/* A donut with 2-point gaps (0.025 of a turn at its 80-point rim). */}
        <Pie
          value="seats"
          innerRadius="62%"
          padAngle={0.025}
          sliceClass={(_, i) => FILLS[i % FILLS.length]}
          hoverLift={6}
          hoverDim={0.64}
        />
        {/* The hovered plan, or the total, in the hole. */}
        <View class="absolute inset-0 items-center justify-center gap-1">
          <Text class="text-xs text-muted-foreground">{shown()?.name ?? "Total"}</Text>
          <Text class="text-2xl font-semibold tabular-nums text-foreground">{shown()?.seats ?? total()}</Text>
        </View>
      </Plot>
      {/* The legend: a key in each slice's color, the value and the share at the end. */}
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
        .accessibility_label("Seats by plan")
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

| Mark | Prop | Rust | Type | Default | Description |
|---|---|---|---|---|---|
| `Pie` | `value` | `.value(..)` | `keyof T \| (d: T, index: number) => number` | the plot's `y` | What each row is worth. A row worth nothing, less, or no number has no slice. |
| `Pie`, `Arc` | `startAngle`, `endAngle` | `.start_angle(..)`, `.end_angle(..)` | `number` (radians) | `0`, `2 * Math.PI` | Where the first slice starts and the last one ends (an arc's ends): radians from 12 o'clock, clockwise. An `endAngle` below `startAngle` lays a pie's slices out the other way. |
| `Pie` | `padAngle` | `.pad_angle(..)` | `number` (radians) | `0` | The angle between neighbouring slices at the rim. Each gap keeps that width (about `padAngle * outerRadius` points) at every radius, its edges parallel, so it is as wide at the center or the hole as at the rim; a slice too narrow to reach the center ends where its edges meet. A pie of one slice has none. |
| `Pie`, `Arc` | `innerRadius`, `outerRadius` | `.inner_radius(..)`, `.outer_radius(..)` | ``number \| `${number}%` `` | `0`, `"100%"` | The radii of the hole and of the rim: points, or a percentage of the largest circle the plot holds (half its smaller side). |
| `Pie`, `Arc` | `cornerRadius` | `.corner_radius(..)` | `number` | `0` | The radius of each slice's corners (an arc's), in points, as d3's `arc.cornerRadius`: each corner a circle touching the edge and the rim or the hole, the gaps' parallel edges included. It is at most half the ring's thickness, which gives an arc round caps, and on a slice too narrow for two whole corners they meet on its middle. A whole ring keeps its round edges only. |
| `Pie` | `sliceClass` | `.slice_class(..)` | `string \| (d: T, index: number) => string` | none | The classes of each slice (`fill-*`, `stroke-*`): the same on every slice, or a function of the slice's row and its index, called once per row when the rows or the function change. |
| `Pie` | `sliceStyle` | `.slice_style(..)` | `StyleProp<ViewStyle>` | none | The style of every slice, over its classes (`fill`, `stroke`, `strokeWidth`). |
| `Pie` | `hoverLift` | `.hover_lift(..)` | `number` | `0` | How far the slice under the pointer grows past the others, in points: on the plot's `pointer` spring, faded in and out with the hover. |
| `Pie` | `hoverDim` | `.hover_dim(..)` | `number` (0 to 1) | `0` | How much the other slices fade while one is under the pointer, as a share of their opacity, with the hover's fade. |
| `Pie` | `label` | `.label(..)` | `string \| (d: T, index: number) => string` | none | The text beside each slice: a field (its number) or a function returning the text the app formats. A row whose text is empty, or a slice narrower than half a degree, has none. |
| `Pie` | `labelClass`, `labelStyle` | `.label_class(..)`, `.label_style(..)` | `string`, `StyleProp<TextStyle>` | none | The `label` part: a text outside the ring at the end of its leader line, centered on it, after it on the right half of the pie and before it on the left. Its padding is its distance from the line's end. |
| `Pie` | `labelGap` | `.label_gap(..)` | `number` | `15` | How far past the rim the labels sit, in points. |
| `Pie` | `labelLineClass`, `labelLineStyle` | `.label_line_class(..)`, `.label_line_style(..)` | `string \| (d: T, index: number) => string`, `StyleProp<ViewStyle>` | none | The `labelLine` part: each label's leader line, from the rim at the slice's middle out to the label's radius, then across to the text. Its `stroke` (`currentColor` where none is set), `strokeWidth` and `strokeDasharray`, the same on every line or a function of the slice's row; shown once styled. |

A slice and an arc fill with `fill` (`currentColor` where none is set) and stroke their edges with `stroke` (none where
none is set), their own over the pie's and the plot's as CSS inherits them: a stroke in the surface's color
(`stroke-card stroke-2`) cuts gaps between the slices too. Their values take no part in the plot's scales. A pie's
slices are drawn again only when the rows, their values, the angles, the radii or the plot's size change; the pointer
moves the lift and the fade on the animator.

Plots with a pie usually place the tooltip by the pointer (`tooltipPlacement="pointer"`), since a pie's rows have no
place along an axis: the cross line and the tooltip follow the pointer over it, and it shows no hover dots. A donut's
center is the app's own element laid over the plot (the hovered slice's value, or the total), and so is its legend,
with each key in its slice's color.

A pie's labels name its slices outside the ring: each text sits `labelGap` past the rim toward its slice's middle (the
slice's centroid at that radius), then across to that radius on the slice's side of the pie, and a styled leader line
joins it to the rim. The labels sweep in with their slices on the plot's appear and fade in over its end, move with
them on `motion.update`, and lift with the hovered slice; all of it runs on the platform's animator. Give the plot
room for them: an `outerRadius` below `"100%"`, or space around the plot. Content of the app's own at a slice is an
element laid over the plot, as a donut's center is.

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

## PlotAxis

A `PlotAxis` labels an edge of the plot with the ticks of the scale that edge carries: the bottom and top edges the x
scale's, the left and right ones the y scale's, as d3's `axisBottom`, `axisTop`, `axisLeft` and `axisRight`. Its ticks
come from the scale: round values on a `linear` one (1, 2 or 5 times a power of ten, inside the domain), rows on a
`point` or `band` one. Its labels are texts the plot's layout places, so the app says what they read and how they
look, and the layout puts them in place: each label is centered on its tick along the edge, and the first and last
move inward just as far as they need to stay within the plot's ends.

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
  {/* 0, 1,000, 2,000 and 3,000 left of the plot; a day under each row. */}
  <PlotAxis placement="left" ticks={3} labelClass="pr-2 text-xs tabular-nums text-muted-foreground" />
  <PlotAxis
    format={(i) => rows[i].day}
    labelClass="pt-2 text-xs text-muted-foreground"
    tickClass="h-1 w-px bg-border"
    lineClass="h-px bg-border"
  />
</Plot>
```

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `placement` | `.placement(..)` | `"bottom" \| "top" \| "left" \| "right"` | `"bottom"` | The edge it runs along: the bottom and top edges carry the x scale's ticks, the left and right ones the y scale's. |
| `labelPlacement` | `.label_placement(..)` | `"outside" \| "inside"` | `"outside"` | Where its labels sit: past the edge, in the room the app leaves around the plot, where they stay clear of the marks; or over the plot along the edge, so the plot keeps its whole size (beside a left or right edge, each label sits on its grid line's upper side). |
| `ticks` | `.ticks(..)` | `number` | `10` on a `linear` scale, every row on the others | About how many ticks it takes: on a `linear` scale, round values inside the domain, about this many; on a `point` or `band` scale, this many rows spread evenly from the first to the last. |
| `tickValues` | `.tick_values(..)` | `number[]` | none | The values of its ticks, in place of `ticks`: values of the scale, row indices on a `point` or `band` scale (`[0, 3, 6]` labels every third row). The values inside the domain each get a tick. |
| `format` | `.format(..)` | `(value: number, index: number) => string` | the value, with the decimals the step between ticks needs, thousands grouped | The text of each tick: the app's function of its value (a row's index on a `point` or `band` scale) and its index among the axis' ticks. |
| `labelClass`, `labelStyle` | `.label_class(..)`, `.label_style(..)` | `string`, `StyleProp<TextStyle>` | none | The `label` part: a text per tick, its font, color and padding the app's; its padding toward the plot is its distance from the edge (`pt-2` under a bottom axis). |
| `tickClass`, `tickStyle` | `.tick_class(..)`, `.tick_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The `tick` part: a view per tick on the edge, centered on its tick and reaching toward the labels (`h-1 w-px bg-border` under a bottom axis); shown once styled. |
| `lineClass`, `lineStyle` | `.line_class(..)`, `.line_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The `line` part: a view along the whole edge, on the labels' side (`h-px bg-border` under a bottom axis); shown once styled. |

Outside, the labels sit in the plot's margin, as d3's axes sit in a chart's margins: the plot keeps the size the app
gives it, and the app gives it a margin on the axis' side as deep as the labels (`mb-6` for `pt-2 text-xs` labels
under it), or its parent padding there. Two axes on one edge each label their own values, in their own style: the
ends of a range faint and its middle firmer.

`format` is called once per tick when the ticks or the function change, in the next turn, never while the plot draws
or follows the pointer: keep it pure (the same value, the same text). Without it, a tick reads as d3 writes it:
`1,500`, `0.25`, `−2`. In Rust, `plot_axis()` makes an axis, its `format` a `TickFormat::from_fn(|value, index| ..)`.
An axis takes no pointer, and screen readers hear the plot rather than its labels.

## Motion

Motion is the app's, and none by default: everything shows at once. `motion` takes the timings of
[`nsh`](../modules/nsh.md#animation) (`{ duration, easing, delay }` and `{ stiffness, damping, mass }`):

| Key | Type | What moves |
|---|---|---|
| `appear` | timing | The marks draw in, with an `appearGeneration`: lines and areas from the leading edge, bars growing out of their base (one after another with a bar's `stagger`); a pie's and an arc's ring sweeps in clockwise from its start. |
| `update` | timing | Marks move to the new shape when the app changes it: a pie's and an arc's radii, so a donut's hole opens and closes, and their angles, so a gauge or a slice sweeps round to its new value (d3's `arcTween`: the angles move, not the outline; a new slice opens from where the one before it ends; a change while one moves goes on from where it is drawn); and a linear scale's domain, the app's `domain` or the extent of the marks' values as rows come, which glides from the old one to the new one, the marks, the grid lines and the `PlotAxis`es with it. |
| `enter` | timing | The hover's parts fade in when the pointer comes over the plot. |
| `exit` | timing | They fade out after it leaves. |
| `pointer` | spring | They glide from one row to the next while the pointer moves over the plot; a pie's slice lifts on it. |

The motion runs on the platform's animator, with no JS per frame, and is complete at once for people who ask for
reduced motion. A plot that a list makes again for a row that comes back draws in again; give it the row's key as its
`appearGeneration`.

A domain moves as d3 transitions a scale's domain: the scale in between places every value, so the marks keep their
shapes, the grid lines and the hover's parts move with them, bars keep their corners, and a row that comes in with the
new domain moves with the rest. A live chart that fits its y scale to its rows now and then (with some room, so the
grid holds still between fits) glides to each new fit with an `update` timing. When the plot's size changes, the marks
take the new size at once.

It is the plot's own motion, the timings of what a chart moves: its marks' clip and its hover's parts. A view's
entrances, exits and attention seekers are [`createMotion`](../modules/nsh.md#createmotion)'s presets and
keyframes, which an app can still play on the plot's view or on the elements around it.

## Keyboard

An interactive plot is a stop of Tab (macOS, the web), and while it has the keyboard focus its keys move the same hover
the pointer does: the cross line, the dots and the tooltip glide on the `pointer` spring, a pie's slice lifts,
`onHoverChange` reports the row, and screen readers read the `accessibilityValue` the app gives for it. Its focus ring
is the app's: a `focus-visible:` class or a `focusStyle` (`focus-visible:outline-2 focus-visible:outline-ring`).

| Keys | What they do |
|---|---|
| Right, Left | Move to the row on that side: the next or the previous row, the other way round on a reversed x scale, whose first row is at the right (over a pie, its slices in the rows' order); with no row hovered, Right starts at the row at the left end and Left at the one at the right end (over a pie, the first and the last slice). |
| Home, End | Move to the first or the last row. |
| Escape | Clears the hover. |

The plot answers its keys while it has the focus, and Escape while a row is hovered; the rest of the time they go to
the app and the views around it. Moving the focus away clears a hover the keys made. The plot takes no presses, so a
plot inside a pressable card leaves the card its presses. Screen readers step through the rows too: VoiceOver's
swipe up and down, TalkBack's scroll forward and back, and every screen reader that offers an element's `increment` and
`decrement` actions move to the next and the previous row, in the rows' order on a reversed scale as well.

## Building charts

A chart is a plot, its marks, its axes and the app's own elements around them. Give the y scale a `domain` and its axis
the grid's values (`tickValues`): each label then sits at its grid line. The hover's cross line, dots and tooltip are
the plot's parts, styled and filled by the app; the row's values go where the app shows them.

Grids read best as solid hairlines with a firmer baseline, which leaves a dashed line free to mean a reference value
(the opening price below). An area reads lighter as a wash that fades out toward its baseline than as a flat fill.
Each series' hover dot takes its series' color, and the color of the surface the chart sits on as its ring, so it
cuts out of its line, and the tooltip sits at the top of the plot, inside its edges at the first and last rows: a
`domain` with room above the highest value keeps it off the line.

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
      {/* The value of the row under the pointer, or the last one. */}
      <View class="flex-row items-baseline">
        <Text class="flex-1 text-sm text-muted-foreground">{shown().time}</Text>
        <Text class="text-right text-xl font-semibold tabular-nums text-foreground">{shown().price.toFixed(2)}</Text>
      </View>
      <Plot
        data={props.rows}
        y="price"
        yScale={{ type: "linear", domain: [props.low, props.high] }}
        accessibilityLabel={`Price, from ${props.rows[0].price} to ${props.rows[props.rows.length - 1].price}`}
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
        {/* A wash that fades out toward the baseline. */}
        <Area backgroundClass="bg-linear-to-b from-chart-1/20 to-transparent" />
        <Grid y={[props.low]} class="stroke-muted-foreground/40" />
        <Grid y={[props.rows[0].price]} class="stroke-muted-foreground" style={{ strokeDasharray: "3 3" }} />
        <Line class="stroke-chart-1 stroke-2" hoverDotClass="size-2.5 rounded-full border-2 border-card bg-chart-1" />
        {/* The grid's values right of the plot, and the first and last times under it. */}
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

A bar chart reads best with the tips of its bars rounded and their bases square (`cornerRadii={{ topLeft: 4,
topRight: 4 }}`; in a stack only on its top bar), a hair of room between the bars of a band (`groupPadding`), the
bars of the other rows muted while one is hovered (`inactiveOpacity`) and its band tinted (`crossLineClass`), and
the values in small tabular figures over the bars, with the total over a stack. With `paddingOuter` half of
`paddingInner`, the bands' middles fall at equal steps, and a `PlotAxis` centers each month under its band; a
`maxBandWidth` keeps a few bars narrow in a wide card.

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
        accessibilityLabel="Sales per month, online and in store"
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
        {/* A month centered under each band. */}
        <PlotAxis format={(i) => props.rows[i].month} labelClass="pt-2 text-xs text-muted-foreground" />
      </Plot>
    </View>
  );
}
```

A sparkline in a list row is a plot with `interactive={false}`: it draws its marks and follows no pointer.

## Accessibility

- A plot is one element for screen readers, with the image role and the app's `accessibilityLabel`; its marks, its
  axes' labels and the hover's parts are parts of it and say nothing themselves. Say in the label what the chart shows and what stands out
  (the range, the highest value), and give `accessibilityValue` the words for the row under the pointer, so a screen
  reader says the value as it changes.
- The row under the pointer is reported with `onHoverChange` on platforms with a pointer (desktops, the web, an iPad
  with a trackpad). Touch screens report no hover: show the values a touch user needs in the app's own elements, or
  offer the rows as text or a list where the numbers matter.
- Over a pie the row reported is the slice's under the pointer: give `accessibilityValue` its name, value and share
  (`"Team, 340 seats, 34.0%"`), and say the total and the largest share in the label.
- An interactive plot is a stop of the keyboard focus whose arrow keys move the hover ([Keyboard](#keyboard)), and it
  offers screen readers `increment` and `decrement` to step through the rows (VoiceOver reads it as adjustable); a plot
  with `interactive={false}` is neither, and it takes no presses either way.

See [Accessibility](../docs/accessibility.md) for labels and roles in general.

## Platform notes

- Every platform draws the marks the same way, from one drawing per mark recorded in Rust; a change of the rows draws
  the marks that read them again in one batch, and a change of a paint class (the appearance, `dark:`) sends the
  drawing again without recording it.
- The appear clips lines and areas, and grows bars, with values the platform's animator moves; a bar's fading away
  from the hovered row is an opacity the animator computes from the hover's place; the hover's parts are views the
  animator moves and fades, and it keeps the tooltip inside the plot from the plot's size and the tooltip's.
- An area's background is drawn in its own canvas, clipped to the area's shape, with the same gradient the platform
  draws for a view's `bg-linear-*`; a change of its classes (the appearance, `dark:`) sends the drawing again without
  recording it.
- A pie draws each slice in its own canvas; the slice under the pointer is found in Rust from the slices' angles and
  radii, its lift is a radius and the others' fade an opacity the animator moves, and the appear's sweep moves the
  slices' angles the same way, so neither records a drawing again.
- An axis' labels, tick marks and line are the platform's own texts and views, placed by the layout in Rust from the
  plot's size and scales: they move with the marks when the plot's size changes, and a new domain writes the labels
  again.
