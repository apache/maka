import { mount, signal, Text, View } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui } from "./palette";

// A price chart built from the plot's parts: the rows are the app's, the
// look is the palette's (paint as styles: `stroke`, `fill`,
// `strokeDasharray`). The y domain is the app's, so its labels sit at the
// grid's values; the row under the pointer drives the value in the header,
// and the plot's cross line, dot and tooltip follow it natively. Grid lines
// are solid hairlines and the bottom one a firmer baseline; the one dashed
// line is a reference, the opening price the change is measured from. The
// area is a wash of the line's color that fades out toward the baseline
// (its background, a gradient inside its shape), and the line has the
// hover's dot, in its color. The tooltip is the time of the row, a tag
// over the x axis' labels, so it never covers the line, and it stays
// within the plot's width at the first and last rows. Numbers are tabular
// and at the trailing edge.
type Row = { minute: number; price: number };
type Range = "1D" | "1W" | "1M";
type Curve = "natural" | "linear" | "stepAfter";

// A repeatable walk, so every visit shows the same chart.
const walk = (count: number, seed: number, start: number, step: number): Row[] => {
  let price = start;
  let s = seed;
  return Array.from({ length: count }, (_, minute) => {
    s = (s * 16807) % 2147483647;
    price += ((s % 1000) / 1000 - 0.47) * step;
    return { minute, price: Math.round(price * 100) / 100 };
  });
};
// The time of each row: every five minutes of a session, seven an hour
// apart each day of a week, and the trading days of October 2026.
const clock = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const OCTOBER = Array.from({ length: 31 }, (_, d) => d + 1).filter((d) => (d + 3) % 7 !== 0 && (d + 3) % 7 !== 6);
const RANGES: Record<Range, { rows: Row[]; ticks: string[]; period: string; time: (row: number) => string }> = {
  "1D": { rows: walk(78, 7, 188, 1.2), ticks: ["9:30", "12:45", "16:00"], period: "Today", time: (i) => clock(570 + i * 5) },
  "1W": { rows: walk(35, 11, 181, 2.4), ticks: ["Mon", "Wed", "Fri"], period: "Past week", time: (i) => `${DAYS[Math.floor(i / 7)]} ${clock(600 + (i % 7) * 60)}` },
  "1M": { rows: walk(22, 5, 172, 3.6), ticks: ["Oct 1", "Oct 15", "Oct 30"], period: "Past month", time: (i) => `Oct ${OCTOBER[i]}` },
};

// The y domain: the rows' extent, rounded out to whole steps of 5.
const domain = (rows: Row[]): [number, number] => {
  const prices = rows.map((r) => r.price);
  return [Math.floor(Math.min(...prices) / 5) * 5, Math.ceil(Math.max(...prices) / 5) * 5];
};

const num = { fontVariant: ["tabular-nums" as const], textAlign: "right" as const };

function App() {
  const range = signal<Range>("1D");
  const curve = signal<Curve>("natural");
  const hovered = signal<number | null>(null);
  // The last row hovered: the tooltip keeps it while it fades out.
  const tipRow = signal(0);
  const events = signal<string[]>([]);
  const rows = () => RANGES[range()].rows;
  const [lo, hi] = [() => domain(rows())[0], () => domain(rows())[1]];
  // The hovered row, or the last one; a row of the range before a switch
  // reads as the last one of the new range.
  const shown = () => {
    const all = rows();
    const at = hovered();
    return all[at != null && at < all.length ? at : all.length - 1];
  };
  const open = () => rows()[0].price;
  const change = () => shown().price - open();
  const color = () => (change() >= 0 ? ui().up : ui().down);
  // Signed figures: an explicit plus and a true minus.
  const signed = (v: number, digits: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
  const label = (v: number) => v.toFixed(0);
  const height = desktop ? 200 : 180;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>plot</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Move the pointer over the chart to read a row" : "Pick a range to draw other rows"}
      </Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="data · curve">
              <Segmented options={["1D", "1W", "1M"] as const} value={range()} onChange={(r) => (range.set(r), hovered.set(null))} />
              <Segmented options={["natural", "linear", "stepAfter"] as const} value={curve()} onChange={(c) => curve.set(c)} />
              <Text style={{ fontSize: 13, color: ui().text, ...num, textAlign: "left" }}>
                {`${rows().length} rows · domain ${lo()} to ${hi()}`}
              </Text>
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 14, gap: 12 }}>
          <View class="flex-row items-baseline gap-3">
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>NSH Labs</Text>
              <Text style={{ fontSize: size.detail, color: ui().muted }}>
                {`${RANGES[range()].period} · open ${open().toFixed(2)}`}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>{shown().price.toFixed(2)}</Text>
              <Text style={{ fontSize: size.detail, color: color(), ...num }}>
                {`${signed(change(), 2)} (${signed((change() / open()) * 100, 2)}%)`}
              </Text>
            </View>
          </View>

          {/* Above the x axis' labels, so the tooltip covers them. */}
          <View class="flex-row gap-2" style={{ zIndex: 1 }}>
            <Plot
              data={rows()}
              y="price"
              yScale={{ type: "linear", domain: [lo(), hi()] }}
              accessibilityLabel={`NSH Labs, ${range()}: from ${rows()[0].price.toFixed(2)} to ${rows()[rows().length - 1].price.toFixed(2)}`}
              accessibilityValue={{ text: hovered() == null ? undefined : `${RANGES[range()].time(hovered()!)}: ${shown().price.toFixed(2)}` }}
              // Motion of the app's: the marks draw in for each range, the
              // hover fades and glides; reduced motion shows it all at once.
              appearGeneration={["1D", "1W", "1M"].indexOf(range())}
              motion={{ appear: { duration: 700, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 300, damping: 30 } }}
              crossLineClass="w-px h-full"
              crossLineStyle={{ backgroundColor: ui().muted }}
              dotClass="size-2.5 rounded-full border-2"
              // The time of the row, at the foot of the cross line, kept
              // within the plot's width.
              tooltipOffset={height + 9}
              tooltipContent={
                <View style={{ ...ui().raised, height: 20, paddingHorizontal: 6, borderRadius: 6, justifyContent: "center" }}>
                  <Text style={{ fontSize: 11, color: ui().text, ...num }}>{RANGES[range()].time(Math.min(tipRow(), rows().length - 1))}</Text>
                </View>
              }
              onHoverChange={(index) => {
                hovered.set(index);
                if (index != null) tipRow.set(index);
                const line = index == null ? "null: left the chart" : `${index}: ${rows()[index].price.toFixed(2)}`;
                events.set([line, ...events()].slice(0, 5));
              }}
              style={{ flex: 1, height }}
            >
              <Grid y={[(lo() + hi()) / 2, hi()]} style={{ stroke: tint(ui().text, 0.08) }} />
              {/* A wash that fades out toward the baseline; the line has the dot. */}
              <Area
                curve={curve()}
                backgroundStyle={{ backgroundImage: `linear-gradient(to bottom, ${tint(color(), 0.16)}, ${tint(color(), 0)})` }}
                hoverDotClass="hidden"
              />
              <Grid y={[lo()]} style={{ stroke: tint(ui().text, 0.2) }} />
              <Grid y={[open()]} style={{ stroke: ui().faint, strokeDasharray: "3 3" }} />
              {/* Its dot in its color, ringed in the card's: it cuts out of the line. */}
              <Line
                curve={curve()}
                style={{ stroke: color(), strokeWidth: 2 }}
                hoverDotStyle={{ backgroundColor: color(), borderColor: ui().card.backgroundColor }}
              />
            </Plot>
            <View style={{ justifyContent: "space-between", marginVertical: -7, width: 28 }}>
              {[hi(), (lo() + hi()) / 2, lo()].map((v) => (
                <Text style={{ fontSize: 11, color: ui().muted, ...num }}>{label(v)}</Text>
              ))}
            </View>
          </View>
          <View class="flex-row justify-between" style={{ marginRight: 36 }}>
            {RANGES[range()].ticks.map((t) => (
              <Text style={{ fontSize: 11, color: ui().muted }}>{t}</Text>
            ))}
          </View>
        </View>
      </Split>
    </View>
  );
}

mount(App);
