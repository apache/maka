import { mount, signal, Text, View } from "nsh";
import { Bar, Grid, Plot, PlotAxis, Rule } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui } from "./palette";

// Bars that span a range of their own row: `Bar`'s `base` takes a field
// name or a function of the row as well as a number, so each bar runs
// from its row's base to its value. `Rule` draws a straight line per row
// the same way, along the value axis.
//
// The candlestick is two marks in the same bands: a `Rule` from each day's
// low to its high (the wick) under a `Bar` from its open to its close (the
// body), both colored by the day's direction through the plot's ordinal
// `colorScale`. The bridge is one `Bar` whose base is where the running
// total stood before each step: totals stand on zero, costs hang down from
// the level before them, each labeled at its end with its signed change
// (above a rise, below a fall). The marks grow from their bases one after
// another, and the row under the pointer stays lit while the others fade.
type Candle = { day: number; open: number; high: number; low: number; close: number; dir: "up" | "down" };
type Step = { name: string; kind: "total" | "up" | "down"; start: number; end: number };

/** A repeatable walk of daily candles, so every visit shows the same chart. */
const CANDLES: Candle[] = (() => {
  let s = 17;
  const next = () => {
    s = (s * 16807) % 2147483647;
    return (s % 1000) / 1000;
  };
  let close = 92;
  return Array.from({ length: 24 }, (_, day) => {
    const open = close + (next() - 0.5) * 0.8;
    close = open + (next() - 0.46) * 3.2;
    const high = Math.max(open, close) + next() * 1.2;
    const low = Math.min(open, close) - next() * 1.2;
    const r = (v: number) => Math.round(v * 100) / 100;
    return { day, open: r(open), high: r(high), low: r(low), close: r(close), dir: close >= open ? "up" : "down" };
  });
})();
const LOW = Math.floor(Math.min(...CANDLES.map((c) => c.low)) - 1);
const HIGH = Math.ceil(Math.max(...CANDLES.map((c) => c.high)) + 1);

/** A quarter's revenue down to net profit, in millions: each step from
 * where the total stood to where it leaves it. */
const STEPS: Step[] = (() => {
  const lines: [string, number][] = [
    ["Cost", -54.1],
    ["R&D", -22.8],
    ["SG&A", -27.4],
    ["Other", 3.9],
    ["Tax", -9.2],
  ];
  let level = 142.7;
  const steps: Step[] = [{ name: "Revenue", kind: "total", start: 0, end: level }];
  for (const [name, v] of lines) {
    const end = Math.round((level + v) * 10) / 10;
    steps.push({ name, kind: v >= 0 ? "up" : "down", start: level, end });
    level = end;
  }
  steps.push({ name: "Net", kind: "total", start: 0, end: level });
  return steps;
})();

const num = { fontVariant: ["tabular-nums" as const] };
/** The room under a plot for its x axis' labels: their 12 above a line of 14. */
const AXIS_BELOW = 12 + 14;
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;

function App() {
  const chart = signal<"candles" | "bridge">("candles");
  const hovered = signal<number | null>(null);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const height = desktop ? 200 : 180;
  const candle = () => CANDLES[hovered() != null && chart() === "candles" ? Math.min(hovered()!, CANDLES.length - 1) : CANDLES.length - 1];
  const step = () => STEPS[hovered() != null && chart() === "bridge" ? Math.min(hovered()!, STEPS.length - 1) : STEPS.length - 1];
  const tone = (dir: string) => (dir === "down" ? ui().down : dir === "up" ? ui().up : ui().text);
  const labelStyle = () => ({ fontSize: 11, paddingVertical: 3, color: ui().muted, ...num });
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>plot ranges</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Move the pointer over the chart to read a row" : chart() === "candles" ? "Each candle spans its day: wick low to high, body open to close" : "Each step starts where the total stood"}
      </Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="chart">
              <Segmented options={["candles", "bridge"] as const} value={chart()} onChange={(c) => (chart.set(c), hovered.set(null))} />
              <Text style={{ fontSize: 13, color: ui().text, ...num }}>
                {chart() === "candles" ? `Rule high ← low · Bar close ← open` : `Bar end ← start · ${STEPS.length} steps`}
              </Text>
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 14, gap: 12 }}>
          <If
            when={chart() === "candles"}
            else={
              <>
                <View class="flex-row items-baseline gap-3">
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>Profit bridge</Text>
                    <Text style={{ fontSize: size.detail, color: ui().muted }}>{`${step().name} · millions`}</Text>
                  </View>
                  <Text style={{ fontSize: 20, fontWeight: "600", color: tone(step().kind), ...num }}>
                    {step().kind === "total" ? `$${step().end.toFixed(1)}M` : `${signed(step().end - step().start)}M`}
                  </Text>
                </View>
                <Plot
                  data={STEPS}
                  xScale={{ type: "band", paddingInner: 0.32, paddingOuter: 0.16 }}
                  yScale={{ type: "linear", domain: [0, 160] }}
                  colorScale={{ type: "ordinal", domain: ["total", "up", "down"], range: [ui().info, ui().up, ui().down] }}
                  accessibilityLabel={`Profit bridge: $142.7M revenue to $${STEPS[STEPS.length - 1].end.toFixed(1)}M net profit`}
                  accessibilityValue={{ text: hovered() == null ? undefined : `${step().name}: ${step().end.toFixed(1)}` }}
                  appearGeneration="bridge"
                  motion={{ appear: { duration: 800, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 320, damping: 32 } }}
                  crossLineClass="w-full h-full"
                  crossLineStyle={{ backgroundColor: tint(ui().text, 0.05) }}
                  onHoverChange={({ index }) => {
                    hovered.set(index);
                    log(index == null ? "null: left the chart" : `${index}: ${STEPS[index].name}, ${STEPS[index].start} → ${STEPS[index].end}`);
                  }}
                  style={{ height, marginRight: 36, marginBottom: AXIS_BELOW }}
                >
                  <Grid y={[40, 80, 120]} style={{ stroke: tint(ui().text, 0.08) }} />
                  <Grid y={[0]} style={{ stroke: tint(ui().text, 0.2) }} />
                  {/* From each row's start to its end, colored by its kind. */}
                  <Bar
                    value="end"
                    base="start"
                    color="kind"
                    cornerRadii={2}
                    stagger={0.5}
                    inactiveOpacity={0.4}
                    label={(d: Step) => (d.kind === "total" ? d.end.toFixed(1) : signed(d.end - d.start))}
                    labelStyle={labelStyle()}
                  />
                  <PlotAxis placement="right" tickValues={[0, 40, 80, 120]} labelStyle={{ width: 36, paddingLeft: 8, textAlign: "right", fontSize: 11, color: ui().muted, ...num }} />
                  <PlotAxis format={(i) => STEPS[i].name} labelStyle={{ fontSize: 11, lineHeight: 14, paddingTop: 12, color: ui().muted }} />
                </Plot>
              </>
            }
          >
            <View class="flex-row items-baseline gap-3">
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>NSH Labs</Text>
                <Text style={{ fontSize: size.detail, color: ui().muted, ...num }}>
                  {`Day ${candle().day + 1} · O ${candle().open.toFixed(2)} H ${candle().high.toFixed(2)} L ${candle().low.toFixed(2)}`}
                </Text>
              </View>
              <Text style={{ fontSize: 20, fontWeight: "600", color: tone(candle().dir), ...num }}>{candle().close.toFixed(2)}</Text>
            </View>
            <Plot
              data={CANDLES}
              xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.15 }}
              yScale={{ type: "linear", domain: [LOW, HIGH] }}
              colorScale={{ type: "ordinal", domain: ["up", "down"], range: [ui().up, ui().down] }}
              accessibilityLabel={`NSH Labs, ${CANDLES.length} days: from ${CANDLES[0].open.toFixed(2)} to ${CANDLES[CANDLES.length - 1].close.toFixed(2)}`}
              accessibilityValue={{ text: hovered() == null ? undefined : `Day ${candle().day + 1}: open ${candle().open}, high ${candle().high}, low ${candle().low}, close ${candle().close}` }}
              appearGeneration="candles"
              motion={{ appear: { duration: 800, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 320, damping: 32 } }}
              crossLineClass="w-full h-full"
              crossLineStyle={{ backgroundColor: tint(ui().text, 0.06) }}
              onHoverChange={({ index }) => {
                hovered.set(index);
                const c = index == null ? undefined : CANDLES[index];
                log(c == null ? "null: left the chart" : `${index}: ${c.low} – ${c.high}, ${c.open} → ${c.close}`);
              }}
              style={{ height, marginRight: 36, marginBottom: AXIS_BELOW }}
            >
              <Grid y={[LOW + (HIGH - LOW) / 3, LOW + ((HIGH - LOW) * 2) / 3]} style={{ stroke: tint(ui().text, 0.08) }} />
              {/* The wick, low to high, under the body, open to close. */}
              <Rule value="high" base="low" color="dir" stagger={0.5} inactiveOpacity={0.3} style={{ strokeWidth: 1 }} />
              <Bar value="close" base="open" color="dir" cornerRadii={1} stagger={0.5} inactiveOpacity={0.3} />
              <PlotAxis
                placement="right"
                tickValues={[LOW + (HIGH - LOW) / 3, LOW + ((HIGH - LOW) * 2) / 3]}
                format={(v) => v.toFixed(0)}
                labelStyle={{ paddingLeft: 8, fontSize: 11, color: ui().muted, ...num }}
              />
              <PlotAxis tickValues={[0, 11, 23]} format={(i) => `Day ${i + 1}`} labelStyle={{ fontSize: 11, lineHeight: 14, paddingTop: 12, color: ui().muted }} />
            </Plot>
          </If>
        </View>
      </Split>
    </View>
  );
}

mount(App);
