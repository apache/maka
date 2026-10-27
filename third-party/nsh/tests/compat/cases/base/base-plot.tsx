// A case of the API's test suite (docs/dev/compatibility.md): `nsh/base/plot`,
// the parts of a chart: a `Plot` of the app's rows (`data`, its `x` / `y`
// fields, the `xScale` / `yScale`), one image for screen readers
// (`accessibilityLabel`, `accessibilityValue`), the row nearest the pointer
// (`onHoverChange`) with its parts (`crossLineClass`, `dotClass`,
// `tooltipContent`, `tooltipPlacement`, `tooltipOffset`) and `motion`, and
// its marks `Grid` (`x`, `y`), `Area` (`y1`, `y0`, `curve`, a gradient
// `background`, its own `hoverDot`) and `Line` (`y` as a field and as a
// function, `data` / `x` of its own, `curve`, `dot`, its own `hoverDot`),
// painted with the paint style keys; and `Bar` on a `band` scale (`value`,
// `base`, `stack`, `label` as a field and as a function with its part,
// `cornerRadii`, `stagger`, `inactiveOpacity`, a gradient `background`),
// upright and across. A headless run paints nothing, so the script checks
// the plot's layout, its role, label and value, the tooltip's text, where
// the layout puts the tooltip, the hover's dots, the bars' labels and the
// cross line on a band, and what it reports. A `Pie` (`value`,
// `startAngle`, `endAngle`, `innerRadius`, `outerRadius`) over an `Arc`
// reports the slice under the pointer, none in its hole, outside its ring
// or past its last angle; its hole closes with `motion.update`, the pointer
// finding the new ring at once.
import { Text, View, signal } from "nsh";
import { Arc, Area, Bar, Grid, Line, Pie, Plot } from "nsh/base/plot";

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
        onHoverChange={(index) => hovered.set(index)}
        class="h-[100px] w-[200px] stroke-current"
        style={{ color: "#3366ff" }}
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
      {/* A sparkline: no pointer. */}
      <Plot testID="spark" data={rows()} y="price" interactive={false} accessibilityLabel="Spark" onHoverChange={(index) => hovered.set(index)} style={{ width: 100, height: 20 }}>
        <Line />
      </Plot>
      {/* Bars in bands: one standing alone, a stack beside it. */}
      <Plot
        testID="bars"
        data={SALES}
        xScale={{ type: "band", paddingInner: 0.2, paddingOuter: 0.1, maxBandWidth: 60, bandCount: 4, groupPadding: 0 }}
        yScale={{ type: "linear", domain: [-20, 60] }}
        crossLineClass="w-full h-full bg-[#eeeeee]"
        tooltipContent={<View testID="bar-tip" style={{ width: 10, height: 10 }} />}
        onHoverChange={(index) => barHovered.set(index)}
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
    </View>
  );
}

/** Shares of 1, 1 and 2 over the lower half of a ring from 20 to 40 (the
 * largest circle of a 100 by 100 plot is 50), from 3 o'clock to 9. */
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
        onHoverChange={(index) => slice.set(index)}
        style={{ width: 100, height: 100 }}
      >
        <Arc innerRadius={hole() ? "40%" : 0} outerRadius="80%" class="fill-[#eeeeee]" />
        <Pie
          value="share"
          startAngle={Math.PI / 2}
          endAngle={(3 * Math.PI) / 2}
          innerRadius={hole() ? "40%" : 0}
          outerRadius="80%"
          padAngle={0.02}
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

export default App;
