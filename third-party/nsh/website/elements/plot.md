---
title: Plot
description: "The Plot component of nsh/base/plot and its marks Line, Area and Grid: charts drawn natively from the app's rows, with the scales of the axes, the row under the pointer, motion and no look of their own."
order: 20.9
group: base
demo: el-plot
---

# Plot

A plot is the frame of a chart: the rows of data it shows, the scales of its x and y axes, the pointer over it and its
motion. Its marks draw what it holds: a `Line` through a series, an `Area` between a series and a baseline, a `Grid` of
lines across. Each mark is one canvas filling the plot, drawn natively from the rows: the app's rows are read once when
it sets them, then scaled, recorded and drawn in Rust, so a chart of a thousand points runs no JS per point. The pointer
is followed in Rust too: the hover's cross line, dots and tooltip move and fade on the platform's animator, and the app
hears of a new row, nothing more. The look is the app's: marks paint with CSS's paint properties of SVG shapes
(`stroke-*`, `fill-*`), `currentColor` where none is set, an area shows a background (a gradient, `bg-linear-*`)
inside its shape, and the hover's parts (each mark's dot among them) and the axis labels are the app's to style and
fill.

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

`Plot`, `Line`, `Area` and `Grid` come from `nsh/base/plot`, a module of [`nsh/base`](../modules/nsh-base.md) of their
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
| `xScale` | `.x_scale(..)` | `Scale` | `{ type: "point" }` | How the x axis places rows: `point` (in order, evenly from the left edge to the right one; one row in the middle) or `linear` with an optional `domain`. |
| `yScale` | `.y_scale(..)` | `Scale` | `{ type: "linear" }` | How the y axis places values: the domain's smallest value at the bottom edge, its largest at the top. Without a `domain`, the extent of what the marks draw. |
| `interactive` | `.interactive(..)` | `boolean` | `true` | The plot follows the pointer: it reports the row under it and shows the hover's parts. `false` draws the marks only (a sparkline in a list). |
| `motion` | `.motion(..)` | `PlotMotion` | none | The timing of the appear, the hover's fade in and out, and the spring the hover follows the pointer with (below). |
| `appearGeneration` | `.appear_generation(..)` | `number` | none | Opts in to the appear: the marks draw in when the plot is first shown, and again whenever this changes (another symbol, another period). |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say of the chart: what it shows and what stands out. |
| `accessibilityValue` | `.accessibility_value(..)` | `{ min?, max?, now?, text? }` | none | What screen readers hear as its value: the app's words for the row under the pointer. |
| `crossLineClass`, `crossLineStyle` | `.cross_line_class(..)`, `.cross_line_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The cross line: a view as tall as the plot, centered on the row under the pointer. |
| `dotClass`, `dotStyle` | `.dot_class(..)`, `.dot_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The hover's dots: a view per `Line` and `Area`, centered on its point at the row under the pointer. A mark's `hoverDotClass` / `hoverDotStyle` replace them for its own dot. |
| `tooltipContent` | `.tooltip_content(..)` | `JSX.Element` | none | The app's tooltip, placed by `tooltipPlacement` and moved and faded with the cross line. |
| `tooltipPlacement` | `.tooltip_placement(..)` | `"top" \| "pointer"` | `"top"` | Where the tooltip goes: at the top of the plot, centered on the cross line; or beside the pointer, on the side of the cross line toward the plot's middle and below the pointer in the upper half, above it in the lower one. At the top it stays between the plot's left and right edges (its offset from the top edge is the app's: a tag under the plot takes the plot's height and more); beside the pointer it stays inside the plot. |
| `tooltipOffset` | `.tooltip_offset(..)` | `number` | `0` | The distance between the tooltip and what places it: the top edge for `"top"`, the cross line and the pointer for `"pointer"`. |
| `children` | `.child(..)` | `JSX.Element` | none | The marks, drawn in order over each other, and whatever the app lays over them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The plot's size and look; the marks inherit its paint properties, as CSS inherits them. |

| Event | Rust | Payload | When |
|---|---|---|---|
| `onHoverChange` | `.on_hover_change(..)` | `index: number \| null` | The pointer came over another row: the index of the row nearest to it along the x axis; `null` once it leaves the plot. |

`Scale` is `{ type: "point" } | { type: "linear"; domain?: [number, number] }`. A `domain` is the extent of its two
values, in either order; a domain of one value puts it in the middle.

A function of a row (`y={(d) => d.high - d.low}`) is called once per row when the rows or the function change, in the
next turn, never while the plot draws or follows the pointer: keep it pure (the same row, the same number). A field
name is read with no JS at all.

## Line, Area and Grid

| Mark | Prop | Type | Default | Description |
|---|---|---|---|---|
| `Line` | `y` | `string \| (d, index) => number` | the plot's `y` | What it draws: one point per row with a value, the rows without one skipped. |
| `Line`, `Area` | `data`, `x` | `T[]`, `string \| (d, index) => number` | the plot's rows | Rows of a series of its own (other x values), placed on the plot's scales by its own `x` (a row's index without). |
| `Line`, `Area` | `curve` | `"natural" \| "linear" \| "stepAfter"` | `"natural"` | How it connects its points: a smooth curve, straight segments, or steps that hold each value until the next row. |
| `Line` | `dot`, `dotClass`, `dotStyle` | `boolean`, `string`, `StyleProp<ViewStyle>` | `false` | A dot on every point: a view centered on it, its size, background and border the app's. |
| `Line`, `Area` | `hoverDotClass`, `hoverDotStyle` | `string`, `StyleProp<ViewStyle>` | the plot's `dotClass`, `dotStyle` | Its hover dot, on its point at the row under the pointer: each series' dot in its own color. Each replaces the plot's for this mark (a mark's color over the plot's size and ring); `hidden` shows none. |
| `Area` | `backgroundClass`, `backgroundStyle` | `string`, `StyleProp<ViewStyle>` | none | Its background: a box around its shape (from its first point to its last, from its highest point to its baseline) whose background (`bg-*`, `bg-linear-to-b from-… to-…`, `backgroundImage`) shows only inside the shape, under its `fill`. With one, `fill` is `none` where none is set. |
| `Area` | `y1` | `string \| (d, index) => number` | the plot's `y` | What makes its top edge. |
| `Area` | `y0` | `number` | the bottom edge | The value of its baseline on the y scale. |
| `Grid` | `x` | `number[]` | none | Where its vertical lines go, as values of the x scale (row indices on a `point` scale). |
| `Grid` | `y` | `number[]` | none | Where its horizontal lines go, as values of the y scale. |

Each mark fills the plot and paints with its [SVG paint properties](../modules/style-reference.md#svg-paint), its own
over those of the plot, as CSS inherits them:

| Mark | Paints with | Where none is set |
|---|---|---|
| `Line` | `stroke`, `strokeWidth`, `strokeDasharray` | `currentColor`, 1 wide, solid |
| `Area` | `fill` (over its `background` part); its top edge `stroke`, `strokeWidth`, `strokeDasharray` | `fill` `currentColor` (`none` beside a background); no stroke |
| `Grid` | `stroke`, `strokeWidth`, `strokeDasharray` | `currentColor`, 1 wide, solid; each line on whole device pixels, so a thin one stays sharp |

The values a `Line` or an `Area` draws, an area's `y0` too, make the y scale's domain when the plot has none; a grid's
do not. A mark draws again only when what it draws changes (its rows, values, curve, the plot's size or scales, its
paint); the pointer moves the hover's parts and never draws a mark again.

`fill` is CSS's, as in a browser: a color. A gradient under a line is an area's background, the way a page shows a
gradient in a shape (a box's `background-image` under `clip-path`): `backgroundClass="bg-linear-to-b from-chart-1/20
to-transparent"` fades from the area's highest point to its baseline, in the theme's tokens and the appearance's
colors like any view's background.

## Motion

Motion is the app's, and none by default: everything shows at once. `motion` takes the timings of
[`nsh/animated`](../modules/nsh-animated.md) (`{ duration, easing, delay }` and `{ stiffness, damping, mass }`):

| Key | Type | What moves |
|---|---|---|
| `appear` | timing | The marks draw in from the leading edge, with an `appearGeneration`. |
| `enter` | timing | The hover's parts fade in when the pointer comes over the plot. |
| `exit` | timing | They fade out after it leaves. |
| `pointer` | spring | They glide from one row to the next while the pointer moves over the plot. |

The motion runs on the platform's animator, with no JS per frame, and is complete at once for people who ask for
reduced motion. A plot that a list makes again for a row that comes back draws in again; give it the row's key as its
`appearGeneration`.

It is the plot's own motion, the timings of what a chart moves: its marks' clip and its hover's parts. A view's
entrances, exits and attention seekers are [`createMotion`](../modules/nsh-animated.md#createmotion)'s presets and
keyframes, which an app can still play on the plot's view or on the elements around it.

## Building charts

A chart is a plot, its marks and the app's own elements around them. Give the y scale a `domain` when the app labels
it: the labels then sit at the grid's values. The hover's cross line, dots and tooltip are the plot's parts, styled and
filled by the app; the row's values go where the app shows them.

Grids read best as solid hairlines with a firmer baseline, which leaves a dashed line free to mean a reference value
(the opening price below). An area reads lighter as a wash that fades out toward its baseline than as a flat fill.
Each series' hover dot takes its series' color, and the color of the surface the chart sits on as its ring, so it
cuts out of its line, and the tooltip sits at the top of the plot, inside its edges at the first and last rows: a
`domain` with room above the highest value keeps it off the line.

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
      {/* The value of the row under the pointer, or the last one. */}
      <View class="flex-row items-baseline">
        <Text class="flex-1 text-sm text-muted-foreground">{shown().time}</Text>
        <Text class="text-right text-xl font-semibold tabular-nums text-foreground">{shown().price.toFixed(2)}</Text>
      </View>
      <View class="flex-row gap-2">
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
          onHoverChange={(index) => hovered.set(index)}
          class="h-48 flex-1"
        >
          <Grid y={[middle(), props.high]} class="stroke-border" />
          {/* A wash that fades out toward the baseline. */}
          <Area backgroundClass="bg-linear-to-b from-chart-1/20 to-transparent" />
          <Grid y={[props.low]} class="stroke-muted-foreground/40" />
          <Grid y={[props.rows[0].price]} class="stroke-muted-foreground" style={{ strokeDasharray: "3 3" }} />
          <Line class="stroke-chart-1 stroke-2" hoverDotClass="size-2.5 rounded-full border-2 border-card bg-chart-1" />
        </Plot>
        {/* The y axis' labels, at the grid's values (Text until an axis mark lands). */}
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

A sparkline in a list row is a plot with `interactive={false}`: it draws its marks and follows no pointer.

## Accessibility

- A plot is one element for screen readers, with the image role and the app's `accessibilityLabel`; its marks and the
  hover's parts are parts of it and say nothing themselves. Say in the label what the chart shows and what stands out
  (the range, the highest value), and give `accessibilityValue` the words for the row under the pointer, so a screen
  reader says the value as it changes.
- The row under the pointer is reported with `onHoverChange` on platforms with a pointer (desktops, the web, an iPad
  with a trackpad). Touch screens report no hover: show the values a touch user needs in the app's own elements, or
  offer the rows as text or a list where the numbers matter.
- A plot takes no presses and no keyboard focus.

See [Accessibility](../docs/accessibility.md) for labels and roles in general.

## Platform notes

- Every platform draws the marks the same way, from one drawing per mark recorded in Rust; a change of the rows draws
  the marks that read them again in one batch, and a change of a paint class (the appearance, `dark:`) sends the
  drawing again without recording it.
- The appear clips the marks with a value the platform's animator moves; the hover's parts are views the animator moves
  and fades, and it keeps the tooltip inside the plot from the plot's size and the tooltip's.
- An area's background is drawn in its own canvas, clipped to the area's shape, with the same gradient the platform
  draws for a view's `bg-linear-*`; a change of its classes (the appearance, `dark:`) sends the drawing again without
  recording it.
