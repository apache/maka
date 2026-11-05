import { mount, signal, Text, View } from "nsh";
import { Bar, Grid, Line, Plot, PlotAxis } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui } from "./palette";

// Two y scales in one plot: the volume bars on the plot's `yScale`, the
// close on its second one (`y2Scale`), which the line names with
// `scale="y2"` and the right-hand `PlotAxis` labels. Neither scale names a
// domain, so the plot widens both to the same round steps (`alignTicks`,
// on by default) and the one `<Grid />`, which follows the ticks, serves
// both axes. Switching the symbol moves both scales to their new domains;
// turning alignment off shows each scale on its own extent.
type Day = { day: number; volume: number; close: number; dir: "up" | "down" };

/** A repeatable walk of a stock's days: its close and its volume in
 * millions of shares, heavier on the days that move more. */
function walk(seed: number, start: number, volume: number): Day[] {
  let s = seed;
  const next = () => {
    s = (s * 16807) % 2147483647;
    return (s % 1000) / 1000;
  };
  let close = start;
  return Array.from({ length: 20 }, (_, day) => {
    const before = close;
    close = Math.round(close * (1 + (next() - 0.47) * 0.04) * 100) / 100;
    const move = Math.abs(close / before - 1);
    return { day, close, volume: Math.round(volume * (0.7 + next() * 0.5) * (1 + move * 18) * 10) / 10, dir: close >= before ? "up" : "down" };
  });
}

const SYMBOLS = {
  ORBX: walk(23, 184, 42),
  QBIT: walk(71, 36.5, 160),
} as const;
type Symbol = keyof typeof SYMBOLS;

const num = { fontVariant: ["tabular-nums" as const] };
/** The room under a plot for its x axis' labels: their 12 above a line of 14. */
const AXIS_BELOW = 12 + 14;
const SIDE = 40;
const shares = (m: number) => (m === 0 ? "0" : m >= 1000 ? `${(m / 1000).toFixed(1)}B` : `${m.toFixed(0)}M`);

function App() {
  const symbol = signal<Symbol>("ORBX");
  const aligned = signal(true);
  const hovered = signal<number | null>(null);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const height = desktop ? 200 : 180;
  const rows = () => SYMBOLS[symbol()];
  const day = () => rows()[hovered() ?? rows().length - 1];
  const tone = (dir: string) => (dir === "down" ? ui().down : ui().up);
  const axisLabel = () => ({ fontSize: 11, color: ui().muted, ...num });
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>plot dual axes</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Move the pointer over the chart to read both values" : "Volume on the left scale, the close on the right"}</Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="symbol">
              <Segmented options={["ORBX", "QBIT"] as const} value={symbol()} onChange={(s) => symbol.set(s)} />
            </Panel>
            <Panel title="alignTicks">
              <Segmented options={["on", "off"] as const} value={aligned() ? "on" : "off"} onChange={(v) => aligned.set(v === "on")} />
              <Text style={{ fontSize: 13, color: ui().text, ...num }}>{aligned() ? "Both scales in the same steps" : "Each scale its own extent"}</Text>
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 14, gap: 12 }}>
          <View class="flex-row items-baseline gap-3">
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>{symbol()}</Text>
              <Text style={{ fontSize: size.detail, color: ui().muted, ...num }}>{`Day ${day().day + 1} · ${shares(day().volume)} shares`}</Text>
            </View>
            <Text style={{ fontSize: 20, fontWeight: "600", color: tone(day().dir), ...num }}>{`$${day().close.toFixed(2)}`}</Text>
          </View>
          <View class="flex-row justify-between">
            <Text style={{ fontSize: 10, letterSpacing: 0.8, color: ui().muted }}>SHARES</Text>
            <Text style={{ fontSize: 10, letterSpacing: 0.8, color: ui().muted }}>USD</Text>
          </View>
          <Plot
            data={rows()}
            xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.15 }}
            alignTicks={aligned()}
            colorScale={{ type: "ordinal", domain: ["up", "down"], range: [tint(ui().up, 0.45), tint(ui().down, 0.45)] }}
            accessibilityLabel={`${symbol()}, ${rows().length} days: volume and close`}
            accessibilityValue={{ text: hovered() == null ? undefined : `Day ${day().day + 1}: close ${day().close}, ${shares(day().volume)} shares` }}
            appearGeneration="dual"
            motion={{ appear: { duration: 800, easing: "easeOut" }, update: { duration: 600, easing: "easeInOut" }, enter: { duration: 120 }, exit: { duration: 180 } }}
            crossLineClass="w-full h-full"
            crossLineStyle={{ backgroundColor: tint(ui().text, 0.05) }}
            dotStyle={{ width: 9, height: 9, borderRadius: 4.5, borderWidth: 2, borderColor: ui().info, backgroundColor: ui().page }}
            onHoverChange={({ index }) => {
              hovered.set(index);
              const d = index == null ? undefined : rows()[index];
              log(d == null ? "null: left the chart" : `${index}: $${d.close} · ${shares(d.volume)}`);
            }}
            style={{ height, marginLeft: SIDE, marginRight: SIDE, marginBottom: AXIS_BELOW }}
          >
            {/* No values: lines at the ticks of the y scale, which the right axis' share. */}
            <Grid style={{ stroke: tint(ui().text, 0.08) }} />
            <Bar value="volume" color="dir" cornerRadii={{ topLeft: 1.5, topRight: 1.5 }} stagger={0.5} inactiveOpacity={0.4} />
            <Line y="close" scale="y2" curve="linear" style={{ stroke: ui().info, strokeWidth: 2 }} />
            <PlotAxis placement="left" format={shares} labelStyle={{ ...axisLabel(), width: SIDE, paddingRight: 8, textAlign: "right" }} />
            <PlotAxis placement="right" scale="y2" format={(v) => v.toFixed(0)} labelStyle={{ ...axisLabel(), width: SIDE, paddingLeft: 8 }} />
            <PlotAxis tickValues={[0, 9, 19]} format={(i) => `Day ${i + 1}`} labelStyle={{ fontSize: 11, lineHeight: 14, paddingTop: 12, color: ui().muted }} />
          </Plot>
        </View>
      </Split>
    </View>
  );
}

mount(App);
