// A case of the API's test suite (docs/dev/compatibility.md): `nsh/base/plot`,
// the parts of a chart: a `Plot` of the app's rows (`data`, its `x` / `y`
// fields, the `xScale` / `yScale`), one image for screen readers
// (`accessibilityLabel`, `accessibilityValue`), the row nearest the pointer
// (`onHoverChange`) with its parts (`crossLineClass`, `dotClass`,
// `tooltipContent`, `tooltipPlacement`, `tooltipOffset`) and `motion`, and
// its marks `Grid` (`x`, `y`), `Area` (`y1`, `y0` as a value, a field and
// a function, `curve`, a gradient `background`, its own `hoverDot`) and
// `Line` (`y` as a field and as a function, `data` / `x` of its own,
// `curve`, `dot`, its own `hoverDot`),
// painted with the paint style keys, the plot a stop of the keyboard
// focus (its ring the app's `focusStyle`) whose rows a screen reader's
// increment and decrement step through; and `Bar` on a `band` scale (`value`,
// `base`, `stack`, `label` as a field and as a function with its part,
// `cornerRadii`, `stagger`, `inactiveOpacity`, a gradient `background`),
// upright and across. A headless run paints nothing, so the script checks
// the plot's layout, its role, label and value, the tooltip's text, where
// the layout puts the tooltip, the hover's dots, the bars' labels and the
// cross line on a band, and what it reports. A `Pie` (`value`,
// `startAngle`, `endAngle`, `innerRadius`, `outerRadius`, `cornerRadius`)
// over an `Arc` reports the slice under the pointer, none in its hole,
// outside its ring or past its last angle, and steps through its slices
// with a screen reader's increment; its hole closes with `motion.update`,
// the pointer finding the new ring at once. A gauge `Arc` draws round
// corners (`cornerRadius`) and sweeps back to its new end with
// `motion.update`.
// A `Pie`'s labels (`label`, `labelClass`, `labelStyle`, `labelGap`) sit
// outside its ring toward each slice's middle, with leader lines
// (`labelLineClass`, `labelLineStyle`).
// `PlotAxis`es (`placement`, `labelPlacement`, `ticks`, `tickValues`,
// `format`, the `label`, `tick` and `line` parts) lay their labels out
// along a plot's edges.
// A sparkline's y domain, the extent of its rows, moves to a new one with
// `motion.update` as rows come.
// Reversed scales (`reverse`): bars hanging from the top of a reversed
// linear y scale in bands from the right edge, and bars across from the
// right edge of a reversed x; the axis's labels and the hover follow.
import { Text, View, signal } from "nsh";
import { Arc, Area, Bar, Grid, Line, Pie, Plot, PlotAxis } from "nsh/base/plot";

type Row = { t: number; price: number; avg: number };
type Sale = { v: number; w: number };
const SALES: Sale[] = [
  { v: 10, w: 20 },
  { v: 30, w: 10 },
  { v: -10, w: 5 },
];

function App() {
  const rows = signal<Row[]>([
    { t: 0, price: 10, avg: 12 },
    { t: 10, price: 30, avg: 18 },
    { t: 20, price: 20, avg: 22 },
  ]);
  const hovered = signal<number | null>(null);
  const placement = signal<"top" | "pointer">("top");
  const barHovered = signal<number | null>(null);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Plot
        testID="plot"
        data={rows()}
        x="t"
        y="price"
        xScale={{ type: "linear", domain: [0, 40] }}
        yScale={{ type: "linear", domain: [0, 40] }}
        accessibilityLabel="Price"
        accessibilityValue={{ text: hovered() == null ? undefined : `row${hovered()}` }}
        appearGeneration={rows().length}
        motion={{ appear: { duration: 300 }, enter: { duration: 100 }, exit: { duration: 100 }, pointer: { stiffness: 300, damping: 30 } }}
        crossLineClass="w-px h-full bg-[#999999]"
        dotClass="size-2 rounded-full bg-[#3366ff]"
        tooltipContent={
          <View testID="tip" style={{ width: 40, height: 16 }}>
            <Text>{`tip ${hovered()}`}</Text>
          </View>
        }
        tooltipPlacement={placement()}
        tooltipOffset={6}
        onHoverChange={({ index }) => hovered.set(index)}
        class="h-[100px] w-[200px] stroke-current"
        style={{ color: "#3366ff" }}
        focusStyle={{ opacity: 0.9 }}
      >
        <Grid x={[0, 10, 20]} y={[0, 20, 40]} class="stroke-[#cccccc] stroke-1" style={{ strokeDasharray: "2 2" }} />
        <Area
          y1="price"
          y0={0}
          curve="linear"
          class="stroke-none"
          backgroundClass="bg-linear-to-b from-[#3366ff]/30 to-transparent"
          backgroundStyle={{ opacity: 0.8 }}
          hoverDotClass="size-1"
          hoverDotStyle={{ height: 6 }}
        />
        <Line y={(d: Row) => d.avg} curve="stepAfter" style={{ stroke: "#ff0000", strokeWidth: 2 }} />
        <Line data={[{ at: 5, v: 15 }, { at: 15, v: 25 }]} x="at" y="v" dot dotClass="size-1" hoverDotClass="size-3 rounded-full" />
        <Line class="fill-none" hoverDotStyle={{ width: 10, height: 10, backgroundColor: "#ff0000" }} />
      </Plot>
      <Text>{`hovered ${hovered()}`}</Text>
      <View testID="pointer-tip" onPress={() => placement.set("pointer")} style={{ height: 20 }} />
      <View testID="more" onPress={() => rows.set([...rows(), { t: 20, price: 35, avg: 25 }])} style={{ height: 20 }} />
      <Text>{`rows ${rows().length}`}</Text>
      {/* A sparkline: no pointer; its y domain, the extent of its rows,
          glides to a new one as rows come (`motion.update`). */}
      <Plot testID="spark" data={rows()} y="price" interactive={false} motion={{ update: { duration: 200, easing: "easeInOut" } }} accessibilityLabel="Spark" onHoverChange={({ index }) => hovered.set(index)} style={{ width: 100, height: 20 }}>
        <Line />
      </Plot>
      {/* A band: its bottom edge a value of each row (a field, a function). */}
      <Plot testID="band" data={rows()} y="price" interactive={false} accessibilityLabel="Band" style={{ width: 100, height: 20 }}>
        <Area y0="avg" curve="linear" />
        <Area y1="avg" y0={(d: Row) => d.avg - 2} />
      </Plot>
      {/* Bars in bands: one standing alone, a stack beside it. */}
      <Plot
        testID="bars"
        data={SALES}
        xScale={{ type: "band", paddingInner: 0.2, paddingOuter: 0.1, maxBandWidth: 60, bandCount: 4, groupPadding: 0 }}
        yScale={{ type: "linear", domain: [-20, 60] }}
        crossLineClass="w-full h-full bg-[#eeeeee]"
        tooltipContent={<View testID="bar-tip" style={{ width: 10, height: 10 }} />}
        onHoverChange={({ index }) => barHovered.set(index)}
        style={{ width: 400, height: 80 }}
      >
        <Bar
          value="v"
          base={-20}
          label="v"
          labelClass="h-[14px]"
          labelStyle={{ width: 30 }}
          cornerRadii={{ topLeft: 2, topRight: 2 }}
          stagger={0.3}
          inactiveOpacity={0.5}
          backgroundClass="bg-linear-to-t from-[#3366ff] to-[#3366ff]/40"
          backgroundStyle={{ opacity: 0.9 }}
          class="fill-[#3366ff]"
        />
        <Bar value="w" stack="s" label={(d: Sale) => `w${d.w}`} labelClass="h-[14px] w-[30px]" />
      </Plot>
      <Text>{`bar ${barHovered()}`}</Text>
      {/* Bars across: bands down the y axis. */}
      <Plot data={SALES} yScale={{ type: "band" }} style={{ width: 100, height: 60 }}>
        <Bar value="w" label={(d: Sale) => `x${d.w}`} labelClass="h-[14px] w-[30px]" cornerRadii={2} />
      </Plot>
      <PieCase />
      <PieLabelCase />
      <AxisCase />
      <ReverseCase />
    </View>
  );
}

/** Shares of 1, 1 and 2 over the lower half of a ring from 20 to 40 (the
 * largest circle of a 100 by 100 plot is 50), from 3 o'clock to 9; a
 * gauge with round corners over the upper right, from 42 to 48, a
 * quarter turn, then a sixth. */
function PieCase() {
  const slice = signal<number | null>(null);
  const hole = signal(true);
  return (
    <View>
      <Plot
        testID="pie"
        data={[{ share: 1 }, { share: 1 }, { share: 2 }]}
        accessibilityLabel="Shares"
        motion={{ update: { duration: 200, easing: "easeInOut" } }}
        onHoverChange={({ index }) => slice.set(index)}
        style={{ width: 100, height: 100 }}
      >
        <Arc innerRadius={hole() ? "40%" : 0} outerRadius="80%" class="fill-[#eeeeee]" />
        <Arc testID="gauge" endAngle={hole() ? Math.PI / 2 : Math.PI / 3} innerRadius={42} outerRadius={48} cornerRadius={3} />
        <Pie
          value="share"
          startAngle={Math.PI / 2}
          endAngle={(3 * Math.PI) / 2}
          innerRadius={hole() ? "40%" : 0}
          outerRadius="80%"
          padAngle={0.02}
          cornerRadius={2}
          sliceClass={(_, i) => (i === 0 ? "fill-[#3366ff]" : "fill-[#99aaff]")}
          sliceStyle={{ stroke: "#ffffff", strokeWidth: 2 }}
          hoverLift={4}
          hoverDim={0.3}
        />
      </Plot>
      <Text>{`slice ${slice()}`}</Text>
      <View testID="hole" onPress={() => hole.set(false)} style={{ height: 20 }} />
    </View>
  );
}

/** Two equal slices of a ring 30 out in a 100 by 100 plot, from 12
 * o'clock: the first's middle at 3 o'clock, the second's at 9, each label
 * 10 past the rim; a row worth nothing has none. */
function PieLabelCase() {
  type Region = { share: number; name: string };
  return (
    <Plot
      data={[
        { share: 1, name: "east" },
        { share: 1, name: "west" },
        { share: 0, name: "south" },
      ]}
      style={{ width: 100, height: 100 }}
    >
      <Pie
        value="share"
        outerRadius={30}
        label={(d: Region) => d.name}
        labelClass="h-[10px]"
        labelStyle={{ width: 20 }}
        labelGap={10}
        labelLineClass={(_: Region, i: number) => (i === 0 ? "stroke-[#ff0000]" : "stroke-[#0000ff]")}
        labelLineStyle={{ strokeWidth: 2 }}
      />
    </Plot>
  );
}

/** Axes on a plot of four bands by 0 to 100: two months under it, the
 * app's text of each; d3's text of the app's values left of it, and one
 * inside its right edge. Each axis styles one of its tick marks and line
 * with classes and the other with a style. */
function AxisCase() {
  return (
    <Plot
      testID="axes"
      data={[{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }]}
      y="v"
      xScale={{ type: "band" }}
      yScale={{ type: "linear", domain: [0, 100] }}
      style={{ width: 200, height: 100, marginLeft: 30, marginBottom: 20 }}
    >
      <Bar />
      <PlotAxis ticks={2} format={(v, i) => `m${v}i${i}`} labelClass="h-[10px]" labelStyle={{ width: 20 }} tickClass="h-[4px] w-px" lineStyle={{ height: 1 }} />
      <PlotAxis placement="left" tickValues={[0, 50, 100]} labelStyle={{ width: 20, height: 10 }} tickStyle={{ width: 4, height: 1 }} lineClass="w-px" />
      <PlotAxis placement="right" labelPlacement="inside" tickValues={[50]} format={(v) => `in${v}`} labelStyle={{ width: 30, height: 10 }} />
    </Plot>
  );
}

/** Bars of 20, 10 and 5 hanging from the top of a reversed y scale of 0
 * to 40, in three bands from the right edge; under it, the bands' texts.
 * Bars across from the right edge of a reversed x scale of 0 to 20, the
 * bands from the bottom edge up. */
function ReverseCase() {
  const row = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="hanging"
        data={SALES}
        xScale={{ type: "band", reverse: true }}
        yScale={{ type: "linear", domain: [0, 40], reverse: true }}
        onHoverChange={({ index }) => row.set(index)}
        style={{ width: 300, height: 80, marginBottom: 20 }}
      >
        <Bar value="w" label={(d: Sale) => `h${d.w}`} labelClass="h-[14px] w-[30px]" />
        <PlotAxis format={(v) => `rev${v}`} labelStyle={{ width: 20, height: 10 }} />
      </Plot>
      <Text>{`reversed ${row()}`}</Text>
      <Plot data={SALES} xScale={{ type: "linear", domain: [0, 20], reverse: true }} yScale={{ type: "band", reverse: true }} style={{ width: 100, height: 60 }}>
        <Bar value="w" label={(d: Sale) => `l${d.w}`} labelClass="h-[14px] w-[30px]" />
      </Plot>
    </View>
  );
}

export default App;
