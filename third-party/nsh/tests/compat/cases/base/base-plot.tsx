// A case of the API's test suite (docs/dev/compatibility.md): `nsh/base/plot`,
// the parts of a chart: a `Plot` of the app's rows (`data`, its `x` / `y`
// fields, the `xScale` / `yScale`), one image for screen readers
// (`accessibilityLabel`, `accessibilityValue`), the row nearest the pointer
// (`onHoverChange`) with its parts (`crossLineClass`, `dotClass`,
// `tooltipContent`, `tooltipPlacement`, `tooltipOffset`) and `motion`, and
// its marks `Grid` (`x`, `y`), `Area` (`y1`, `y0`, `curve`, a gradient
// `background`, its own `hoverDot`) and `Line` (`y` as a field and as a
// function, `data` / `x` of its own, `curve`, `dot`, its own `hoverDot`),
// painted with the paint style keys. A headless run paints nothing, so the
// script checks the plot's layout, its role, label and value, the
// tooltip's text, where the layout puts the tooltip and the hover's dots,
// and what it reports.
import { Text, View, signal } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";

type Row = { t: number; price: number; avg: number };

function App() {
  const rows = signal<Row[]>([
    { t: 0, price: 10, avg: 12 },
    { t: 10, price: 30, avg: 18 },
    { t: 20, price: 20, avg: 22 },
  ]);
  const hovered = signal<number | null>(null);
  const placement = signal<"top" | "pointer">("top");
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
    </View>
  );
}

export default App;
