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
// along a plot's edges. A `PlotLabel` writes its `texts` at values of a
// plot's scales, each starting at, centered on or ending at its point.
// A sparkline's y domain, the extent of its rows, moves to a new one with
// `motion.update` as rows come.
// Bars take their colors from their rows' regions through the plot's
// `colorScale` (`color` on the mark, an ordinal scale on the plot).
// Candles: a `Bar` from each row's open to its close (`base` a field), a
// `Rule` from its low to its high (`value`, `base` a function, `color`,
// `inactiveOpacity`).
// Bubbles: a `Dot` per row at its `x` and `value`, its radius from a field
// through a square root scale (`r`, `rScale`), its fill from its row's
// category (`color`), the others fading with the hover
// (`inactiveOpacity`), found past its edge within `hitRadius`.
// Dual axes: marks on the plot's second y scale (`y2Scale`, a mark's
// `scale="y2"`): a line, an area, a rule, a bar, dots, a grid line, a label
// and a right-hand axis; automatic domains aligned in the same steps
// (`alignTicks`), a `Grid` without values on their ticks (`ticks`), and
// a plot that does not align.
// Heatmaps: a `Cell` per row in the bands of its two categories (`x`,
// `y`), the x scale's bands in the order of its `domain`, the y scale's
// in the order the cells name them, which the `PlotAxis`es write; colored
// by its `value` along a diverging `colorScale` about its `pivot` (a value
// past the `domain` at its end, a row without one `unknown`), along a
// sequential one, or by its `color` category through an ordinal one; its
// corners round (`cornerRadii`), a `label` in each cell (`labelClass`,
// `labelStyle`) light on dark cells (`data-dark:`), the others fading with
// the hover (`inactiveOpacity`).
// Reversed scales (`reverse`): bars hanging from the top of a reversed
// linear y scale in bands from the right edge, and bars across from the
// right edge of a reversed x; the axis's labels and the hover follow.
// A radar: `RadialLine`s (`radius` as a field and as a function, `angle`,
// `startAngle`, `endAngle`, `outerRadius`) report the row nearest the
// pointer by angle, none outside their outer radius, and step through the
// rows with a screen reader's increment; `RadialGrid`s draw circular
// `rings` and `spokes` between their radii.
// A `Sankey` (`links`, `nodeWidth`, `nodePadding`, `nodeAlign`,
// `iterations`, `valueScale`, `minLinkWidth`, `nodeCornerRadius`,
// `hoverDim`, its `node`, `link` and `linkBackground` parts, and its
// labels: `nodeLabel`, `valueLabel` and their parts) fills its plot with
// flows between the plot's rows, reports the node under the pointer and
// steps through its nodes with a screen reader's increment, and moves to
// new flows with `motion.update`; links that make a cycle draw nothing.
// A `Treemap` (`id`, `parent`, `value`, `sort`, `ratio`, `paddingInner`,
// `paddingOuter`, `paddingTop`, `cornerRadii`, `color`, `colorValue`,
// `inactiveOpacity`, its `leaf`, `group` and `hover` parts, its labels:
// `label`, `valueLabel`, `labelPlacement`, `groupLabel` and their parts)
// tiles the plot's rows as a hierarchy, reports the node under the
// pointer and moves to new rows with `motion.update`; a leaf of 0 takes
// no area.
// A `PlotAppearScope` (`id`) remembers the appears that finished in it: a
// plot made again there shows whole at once, a new `appearGeneration` (a
// string) and a new `id` draw it in again.
import { Text, View, signal } from "nsh";
import { Arc, Area, Bar, Cell, Dot, Grid, Line, Pie, Plot, PlotAppearScope, PlotAxis, PlotLabel, RadialGrid, RadialLine, Rule, Sankey, Treemap } from "nsh/base/plot";

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
        <Area testID="band-low" y0="avg" curve="linear" />
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
      <ColorCase />
      <RangeCase />
      <DotCase />
      <CellCase />
      <CellColorCase />
      <CellRampCase />
      <DualCase />
      <ReverseCase />
      <RadarCase />
      <LabelCase />
      <SankeyCase />
      <TreemapCase />
      <StackCase />
      <ScopeCase />
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
          testID="slices"
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

type Region = { region: string; v: number };

/** Bars colored by region through the plot's ordinal `colorScale`: EU
 * and US in the domain, APAC past it. */
function ColorCase() {
  return (
    <Plot
      data={[
        { region: "EU", v: 10 },
        { region: "US", v: 20 },
        { region: "APAC", v: 30 },
      ]}
      y="v"
      xScale={{ type: "band" }}
      colorScale={{ type: "ordinal", domain: ["US", "EU"], range: ["#ff0000", "#00ff00"] }}
      style={{ width: 150, height: 50 }}
    >
      <Bar color="region" label={(d: Region) => `r${d.v}`} labelStyle={{ width: 20, height: 10 }} />
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

type Spoke = { a: number; b: number };

/** A radar of four rows on 0 to 10 in a 100 by 100 plot (center 50, 50):
 * a closed line over the half turn from 9 o'clock to 3 (its rows 60°
 * apart) out to 40, and a smooth one at angles of its own (an eighth of a
 * turn apart from 12 o'clock) from 6 out to 30, which the pointer finds
 * first; a circular ring at 5 (20 out) from 3 o'clock, and a spoke per row
 * from 6 out. */
function RadarCase() {
  const axis = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="radar"
        data={[{ a: 10, b: 5 }, { a: 5, b: 10 }, { a: 10, b: 5 }, { a: 0, b: 10 }] as Spoke[]}
        yScale={{ type: "linear", domain: [0, 10] }}
        accessibilityLabel="Radar"
        onHoverChange={({ index }) => axis.set(index)}
        style={{ width: 100, height: 100 }}
      >
        <RadialGrid testID="rings" rings={[5]} circular startAngle={Math.PI / 2} outerRadius="80%" class="stroke-[#dddddd]" />
        <RadialGrid testID="spokes" spokes innerRadius={6} outerRadius="80%" />
        <RadialLine radius="a" startAngle={-Math.PI / 2} endAngle={Math.PI / 2} outerRadius="80%" closed class="fill-[#3366ff]/20 stroke-[#3366ff]" />
        <RadialLine
          radius={(d: Spoke) => d.b}
          angle={(_, i) => (i * Math.PI) / 4}
          innerRadius={6}
          outerRadius="60%"
          curve="natural"
          hoverDotClass="size-2"
        />
      </Plot>
      <Text>{`axis ${axis()}`}</Text>
    </View>
  );
}

/** Texts at values of a plot of three rows by 0 to 100: each 20 by 10,
 * its top on the middle row's point at 50, starting at it, centered on it
 * and ending at it (a class or a style sizing it); one half a row from
 * the first, at 100. */
function LabelCase() {
  const size = "h-[10px] w-[20px]";
  return (
    <Plot testID="labels" data={[{ v: 0 }, { v: 50 }, { v: 100 }]} y="v" style={{ width: 200, height: 100 }}>
      <Line />
      <PlotLabel
        class="text-xs"
        texts={[
          { text: "lab-left", x: 1, y: 50, class: size },
          { text: "lab-center", x: 1, y: 50, align: "center", class: size },
          { text: "lab-right", x: 1, y: 50, align: "right", style: { width: 20, height: 10 } },
          { text: "lab-top", x: 0.5, y: 100, class: size },
        ]}
      />
    </Plot>
  );
}

type Stage = { name: string };
const STAGES: Stage[] = [{ name: "visits" }, { name: "trials" }, { name: "gone" }, { name: "paid" }];
const FLOWS = [
  { source: 0, target: 1, value: 60 },
  { source: 0, target: 2, value: 40 },
  { source: 1, target: 3, value: 25 },
];
const MORE_FLOWS = [
  { source: 0, target: 2, value: 30 },
  { source: 0, target: 1, value: 70 },
  { source: 1, target: 3, value: 35 },
];
const STEPS: Stage[] = [{ name: "ra" }, { name: "rb" }, { name: "rc" }, { name: "rx" }, { name: "ry" }];
const STEP_FLOWS = [
  { source: 0, target: 3, value: 10 },
  { source: 1, target: 3, value: 10 },
  { source: 2, target: 4, value: 10 },
];
const FILLS = ["fill-[#3366ff]", "fill-[#33aa66]", "fill-[#999999]", "fill-[#ffaa00]"];

/** Flows from visits to trials and away, trials to paid: four nodes in
 * three columns, a ribbon per link, each node its row's fill, each ribbon
 * outlined over a gradient from its source's color; a plot whose links
 * make a cycle; and one laid out with no relaxing, each node where the
 * layout first puts it. */
function SankeyCase() {
  const flow = signal<number | null>(null);
  const more = signal(false);
  return (
    <View>
      <Plot
        testID="flows"
        data={STAGES}
        accessibilityLabel="Flows"
        motion={{ update: { duration: 200 } }}
        onHoverChange={({ index }) => flow.set(index)}
        style={{ width: 200, height: 100, marginHorizontal: 40 }}
      >
        <Sankey
          testID="sankey"
          links={more() ? MORE_FLOWS : FLOWS}
          nodeWidth={8}
          nodePadding={10}
          nodeAlign="left"
          iterations={4}
          valueScale="sqrt"
          minLinkWidth={36}
          nodeCornerRadius={2}
          nodeClass={(_: Stage, i: number) => FILLS[i]}
          nodeStyle={{ stroke: "#ffffff", strokeWidth: 1 }}
          linkClass="stroke-[#dddddd]"
          linkStyle={{ opacity: 0.8 }}
          linkBackgroundClass={(link) => `bg-linear-to-r ${FILLS[link.source].replace("fill-", "from-")}/40 to-transparent`}
          linkBackgroundStyle={{ opacity: 0.9 }}
          hoverDim={0.6}
          nodeLabel={(d: Stage) => d.name}
          valueLabel={(_: Stage, value: number) => `v${Math.round(value)}`}
          nodeLabelClass="px-1"
          nodeLabelStyle={{ fontSize: 10 }}
          valueLabelClass="font-semibold"
          valueLabelStyle={{ color: "#333333" }}
        />
      </Plot>
      <Text>{`flow ${flow()}`}</Text>
      <View testID="more-flows" onPress={() => more.set(true)} style={{ height: 20 }} />
      <Plot testID="cycle" data={STAGES} accessibilityLabel="Cycle" style={{ width: 100, height: 50 }}>
        <Sankey links={[{ source: 0, target: 1, value: 1 }, { source: 1, target: 0, value: 1 }]} />
      </Plot>
      <Plot testID="unrelaxed" data={STEPS} style={{ width: 100, height: 100 }}>
        <Sankey links={STEP_FLOWS} iterations={0} nodeLabel="name" />
      </Plot>
    </View>
  );
}

type Node = { key: string; group?: string; name: string; size?: number; chg?: number; kind?: string };

const TREE: Node[] = [
  { key: "g", name: "Grow", kind: "a" },
  { key: "h", name: "Hold", kind: "b" },
  { key: "a", group: "g", name: "Ant", size: 50, chg: 2, kind: "a" },
  { key: "b", group: "g", name: "Bee", size: 30, chg: -2, kind: "a" },
  { key: "c", group: "h", name: "Cat", size: 20, chg: 0, kind: "b" },
  { key: "z", group: "h", name: "Zed", size: 0, chg: 1, kind: "b" },
];
const RETREE: Node[] = TREE.map((n) => (n.key === "b" ? { ...n, size: 60 } : n));

/** Two groups of leaves on a 300 by 100 plot: `Grow` (80) on the left,
 * `Hold` (20) right of a 4-point gap, each with a band of 20 for its
 * name, its leaves 2 apart inside a padding of 1; colored by their change
 * on a diverging scale, red to white to green; `Zed` (0) takes no area.
 * At a `ratio` of 4, `Ant` lies over `Bee` (side by side by default).
 * `Bee` grows to 60 with the next rows. A second plot tiles the same
 * leaves in the rows' order, colored by kind, without bands. */
function TreemapCase() {
  const node = signal<number | null>(null);
  const grown = signal(false);
  return (
    <View>
      <Plot
        testID="tree"
        data={grown() ? RETREE : TREE}
        accessibilityLabel="Tree"
        colorScale={{ type: "diverging", domain: [-2, 2], range: ["#ff0000", "#ffffff", "#00ff00"] }}
        motion={{ update: { duration: 200 } }}
        onHoverChange={({ index }) => node.set(index)}
        style={{ width: 300, height: 100 }}
      >
        <Treemap
          testID="treemap"
          id="key"
          parent="group"
          value="size"
          ratio={4}
          paddingInner={[4, 2]}
          paddingOuter={1}
          paddingTop={20}
          cornerRadii={3}
          colorValue="chg"
          leafClass={(d: Node) => (d.key === "a" ? "stroke-[#000000]" : "stroke-[#0000ff]")}
          leafStyle={{ opacity: 0.9 }}
          groupClass="fill-[#eeeeee]"
          groupStyle={{ opacity: 0.5 }}
          inactiveOpacity={0.25}
          label="name"
          valueLabel={(_: Node, value: number) => `t${value}`}
          labelPlacement="center"
          labelClass="p-1"
          labelStyle={{ fontSize: 10 }}
          valueLabelClass="font-semibold"
          valueLabelStyle={{ color: "#333333" }}
          groupLabel="name"
          groupLabelClass="px-1"
          groupLabelStyle={{ fontSize: 9 }}
          hoverClass="border"
          hoverStyle={{ borderColor: "#ff00ff" }}
        />
      </Plot>
      <Text>{`node ${node()}`}</Text>
      <View testID="grow-tree" onPress={() => grown.set(true)} style={{ height: 20 }} />
      <Plot testID="tree-data" data={TREE} colorScale={{ type: "ordinal", domain: ["a", "b"], range: ["#ff0000", "#00ff00"] }} style={{ width: 100, height: 100 }}>
        <Treemap id="key" parent="group" value="size" sort="data" color="kind" label={(d: Node) => `d-${d.name}`} />
      </Plot>
    </View>
  );
}

type Candle = { o: number; c: number; l: number; h: number; dir: string };

const CANDLES: Candle[] = [
  { o: 20, c: 40, l: 10, h: 50, dir: "up" },
  { o: 40, c: 30, l: 25, h: 75, dir: "down" },
];

/** Two candles in bands of 100 of a 200 by 100 plot on 0 to 100 (a value
 * at 100 - value): bodies from the open to the close, the second growing
 * down, labeled at the close; wicks from the low to the high, green up
 * and red down, the other row's fading to 0.25 with the hover. */
function RangeCase() {
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="candles"
        data={CANDLES}
        xScale={{ type: "band" }}
        yScale={{ type: "linear", domain: [0, 100] }}
        colorScale={{ type: "ordinal", domain: ["up", "down"], range: ["#00ff00", "#ff0000"] }}
        onHoverChange={({ index }) => hovered.set(index)}
        style={{ width: 200, height: 100 }}
      >
        <Rule testID="wicks" value="h" base={(d: Candle) => d.l} color="dir" inactiveOpacity={0.25} />
        <Bar value="c" base="o" label={(d: Candle) => `c${d.c}`} labelClass="h-[10px] w-[20px]" />
      </Plot>
      <Text>{`candle ${hovered()}`}</Text>
    </View>
  );
}

type Holding = { risk: number; ret: number; cap: number; sector: string };

const HOLDINGS: Holding[] = [
  { risk: 10, ret: 20, cap: 100, sector: "a" },
  { risk: 30, ret: 40, cap: 400, sector: "b" },
];

/** Two bubbles on a 200 by 100 plot, x from 0 to 40 (5 points a value),
 * y from 0 to 100 (at 100 - value): radii from the caps' square roots, up
 * to 20, the bigger drawn first; red and green by sector; the pointer finds
 * a bubble 20 past its edge. */
function DotCase() {
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="bubbles"
        data={HOLDINGS}
        x="risk"
        xScale={{ type: "linear", domain: [0, 40] }}
        yScale={{ type: "linear", domain: [0, 100] }}
        colorScale={{ type: "ordinal", domain: ["a", "b"], range: ["#ff0000", "#00ff00"] }}
        onHoverChange={({ index }) => hovered.set(index)}
        style={{ width: 200, height: 100 }}
      >
        <Dot
          testID="dots"
          value="ret"
          r="cap"
          rScale={{ type: "sqrt", range: [0, 20] }}
          color="sector"
          inactiveOpacity={0.25}
          hitRadius={20}
        />
      </Plot>
      <Text>{`bubble ${hovered()}`}</Text>
    </View>
  );
}

type Heat = { col: string; line: string; v: number | null };

const HEAT: Heat[] = [
  { col: "col-a", line: "row-a", v: -15 },
  { col: "col-b", line: "row-a", v: 5 },
  { col: "col-a", line: "row-b", v: 45 },
  { col: "col-b", line: "row-b", v: null },
];

/** Four cells of a 200 by 100 plot, in two bands of 100 across and two of
 * 50 down: the columns in the order of the x scale's `domain` (`col-b` at
 * the left), the lines in the order the cells name them (`row-a` at the
 * top). Colored along a ramp from dark red through white to dark green
 * over -15 to 25, white at 5 (`pivot`), 45 past the domain at its green
 * end and the row without a value navy (`unknown`); round corners of 4; a
 * label in each, black, or white on the dark cells; the other cells'
 * labels fading to 0.25 with the hover. */
function CellCase() {
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="heat"
        data={HEAT}
        xScale={{ type: "band", domain: ["col-b", "col-a"] }}
        yScale={{ type: "band" }}
        colorScale={{ type: "diverging", domain: [-15, 25], pivot: 5, range: ["#990000", "#ffffff", "#006600"], unknown: "#000080" }}
        onHoverChange={({ index }) => hovered.set(index)}
        style={{ width: 200, height: 100 }}
      >
        <Cell
          x="col"
          y="line"
          value="v"
          cornerRadii={4}
          inactiveOpacity={0.25}
          label={(d: Heat) => (d.v == null ? "vnone" : `v${d.v}`)}
          labelClass="text-[#000000] data-dark:text-[#ffffff]"
          labelStyle={{ fontSize: 9 }}
        />
        <PlotAxis placement="top" labelClass="h-[10px] w-[40px]" />
        <PlotAxis placement="left" labelClass="h-[10px] w-[40px]" />
      </Plot>
      <Text>{`cell ${hovered()}`}</Text>
    </View>
  );
}

type Tagged = { col: string; tag: string };

const TAGGED: Tagged[] = [
  { col: "tag-a", tag: "q" },
  { col: "tag-b", tag: "p" },
];

/** Two square cells of 100 by 50 in one line, colored by their category
 * through an ordinal scale: `q` green, `p` red. */
function CellColorCase() {
  return (
    <Plot
      data={TAGGED}
      xScale={{ type: "band" }}
      yScale={{ type: "band" }}
      colorScale={{ type: "ordinal", domain: ["p", "q"], range: ["#ff0000", "#00ff00"] }}
      interactive={false}
      style={{ width: 200, height: 50 }}
    >
      <Cell x="col" y={() => "all"} color="tag" label="col" labelClass="h-[10px] w-[30px]" />
    </Plot>
  );
}

type Level = { at: string; v: number | null };

const LEVELS: Level[] = [
  { at: "lv-a", v: 0 },
  { at: "lv-b", v: 10 },
  { at: "lv-c", v: 40 },
  { at: "lv-d", v: null },
];

/** Four cells of 50 by 20 colored along a sequential ramp from white
 * through gray to black over 0 to 20: 0 white, 10 gray, 40 past the domain
 * black, the row without a value magenta (`unknown`). */
function CellRampCase() {
  return (
    <Plot
      data={LEVELS}
      xScale={{ type: "band" }}
      yScale={{ type: "band" }}
      colorScale={{ type: "sequential", domain: [0, 20], range: ["#ffffff", "#808080", "#000000"], unknown: "#ff00ff" }}
      interactive={false}
      style={{ width: 200, height: 20 }}
    >
      <Cell x="at" y={() => "level"} value="v" label="at" labelClass="h-[10px] w-[30px]" />
    </Plot>
  );
}

type Dual = { v: number; p: number };

const DUAL: Dual[] = [
  { v: 100, p: 12 },
  { v: 200, p: 27 },
];

/** Dual axes in bands of 100 of 200 by 100 plots, the y scales kept
 * half a label (5) inside an edge a right axis's label sits on: on the
 * app's domains (y 0 to 200, y2 0 to 40, from 100 up to 5: 12 at 71.5,
 * 27 at 35.875, 20 at 52.5) every part that names `y2` places its values
 * there; on automatic ones the two are aligned in two steps (y 0 to 200,
 * y2 10 to 30, from 95 up to 5: 12 at 86), the right axis ticks every
 * step and a `Grid` with `ticks` takes d3's; not aligned (no axis: over
 * the whole height), the second scale is 12 to 27. */
function DualCase() {
  return (
    <View>
      <Plot testID="dual" data={DUAL} xScale={{ type: "band" }} yScale={{ type: "linear", domain: [0, 200] }} y2Scale={{ type: "linear", domain: [0, 40] }} style={{ width: 200, height: 100 }}>
        <Grid testID="dual-grid" y={[20]} scale="y2" />
        <Area testID="dual-area" y1="p" scale="y2" curve="linear" />
        <Rule testID="dual-rule" value="p" scale="y2" />
        <Bar value="p" scale="y2" label={(d: Dual) => `b${d.p}`} labelClass="h-[10px] w-[20px]" />
        <Line testID="dual-line" y="p" scale="y2" curve="linear" />
        <Dot testID="dual-dots" value="p" scale="y2" />
        <PlotLabel scale="y2" texts={[{ text: "y2-label", x: 0, y: 20 }]} />
        <PlotAxis placement="right" scale="y2" tickValues={[40]} format={(v) => `y2-r${v}`} labelStyle={{ width: 20, height: 10 }} />
      </Plot>
      <Plot data={DUAL} xScale={{ type: "band" }} style={{ width: 200, height: 100 }}>
        <Grid testID="aligned-grid" ticks={4} />
        <Bar value="v" />
        <Line testID="aligned-line" y="p" scale="y2" curve="linear" />
        <PlotAxis placement="right" scale="y2" format={(v) => `p${v}`} labelStyle={{ width: 20, height: 10 }} />
      </Plot>
      <Plot data={DUAL} xScale={{ type: "band" }} alignTicks={false} style={{ width: 200, height: 100 }}>
        <Bar value="v" />
        <Line testID="own-line" y="p" scale="y2" curve="linear" />
      </Plot>
    </View>
  );
}

/** Two bars in one stack (`stack`), in three bands of a 120 by 80 plot
 * on -20 to 60 (1 point a value): the second on the first, a negative
 * first one below the base. */
function StackCase() {
  return (
    <Plot data={SALES} xScale={{ type: "band" }} yScale={{ type: "linear", domain: [-20, 60] }} style={{ width: 120, height: 80 }}>
      <Bar value="v" stack="t" label={(d: Sale) => `sa${d.v}`} labelClass="h-[14px] w-[30px]" />
      <Bar value="w" stack="t" label={(d: Sale) => `sb${d.w}`} labelClass="h-[14px] w-[30px]" />
    </Plot>
  );
}

/** A sparkline a row of a list would make again: shown and taken away,
 * its period changed, and the scope's `id` changed, over an appear of
 * 100 ms, or of an hour easing in (`scope-slow`), which stays at its
 * start for the seconds a script reads it. */
function ScopeCase() {
  const shown = signal(false);
  const period = signal("1D");
  const list = signal("watch");
  const slow = signal(false);
  return (
    <View>
      <PlotAppearScope id={list()}>
        <If when={shown()}>
          <Plot
            data={[{ v: 1 }, { v: 3 }, { v: 2 }]}
            y="v"
            interactive={false}
            appearGeneration={`AAPL ${period()}`}
            motion={{ appear: slow() ? { duration: 3_600_000, easing: "easeIn" } : { duration: 100 } }}
            style={{ width: 100, height: 20 }}
          >
            <Line testID="scoped-line" />
          </Plot>
        </If>
      </PlotAppearScope>
      <Text>{`scoped ${shown()} ${period()} ${list()}`}</Text>
      <View testID="scope-toggle" onPress={() => shown.set(!shown())} style={{ height: 20 }} />
      <View testID="scope-period" onPress={() => period.set("1W")} style={{ height: 20 }} />
      <View testID="scope-rename" onPress={() => list.set("hot")} style={{ height: 20 }} />
      <View testID="scope-slow" onPress={() => slow.set(!slow())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
