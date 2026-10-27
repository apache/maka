import { mount, signal, Text, View } from "nsh";
import { Area, Bar, Grid, Line, Plot } from "nsh/base/plot";
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
//
// The other chart is sales per month as bars in the bands of a band scale,
// side by side or stacked: tips rounded and bases square, a hair between
// the bars of a month, a value over each (the total over a stack), the
// month under the pointer a faint band while the other months' bars fade,
// and the bars growing in one month after another.
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

type Sale = { month: string; online: number; store: number };
type Mode = "grouped" | "stacked";
/** Sales per month, in thousands. */
const SALES: Sale[] = [
  [42, 31],
  [51, 28],
  [48, 36],
  [63, 33],
  [58, 40],
  [71, 38],
  [66, 44],
].map(([online, store], i) => ({ month: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"][i], online, store }));
const total = (d: Sale) => d.online + d.store;
/** The top of the sales' y scale: room above the highest stack for its
 * label. */
const SALES_TOP = 130;

// The y domain: the rows' extent, rounded out to whole steps of 5.
const domain = (rows: Row[]): [number, number] => {
  const prices = rows.map((r) => r.price);
  return [Math.floor(Math.min(...prices) / 5) * 5, Math.ceil(Math.max(...prices) / 5) * 5];
};

const num = { fontVariant: ["tabular-nums" as const], textAlign: "right" as const };

/** A series' key: a swatch in its color, its name and the shown month's value. */
function Key(props: { color: string; label: string; value: string }) {
  return (
    <View class="flex-row items-center gap-1.5">
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: props.color }} />
      <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.label}</Text>
      <Text style={{ fontSize: size.detail, color: ui().text, ...num }}>{props.value}</Text>
    </View>
  );
}

/** Sales per month as bars, side by side or stacked. */
function SalesCard(props: { mode: Mode; onHover: (index: number | null) => void }) {
  const hovered = signal<number | null>(null);
  const shown = () => SALES[hovered() ?? SALES.length - 1];
  const stacked = () => props.mode === "stacked";
  const height = desktop ? 200 : 180;
  // Tips rounded, bases square; a stack only at its top.
  const tip = { topLeft: 3, topRight: 3 };
  const labelStyle = () => ({ fontSize: 11, paddingBottom: 3, color: ui().muted, fontVariant: ["tabular-nums" as const] });
  return (
    <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 14, gap: 12 }}>
      <View class="flex-row items-baseline gap-3">
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>Sales</Text>
          <Text style={{ fontSize: size.detail, color: ui().muted }}>{`${shown().month} · thousands`}</Text>
        </View>
        <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>{`${total(shown())}k`}</Text>
      </View>
      <View class="flex-row gap-4">
        <Key color={ui().info} label="Online" value={`${shown().online}k`} />
        <Key color={ui().violet} label="In store" value={`${shown().store}k`} />
      </View>
      <View class="flex-row gap-2">
        <Plot
          data={SALES}
          // Half the inner gap at the ends: the bands' middles divide the
          // width evenly, under the months' equal cells.
          xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.15, maxBandWidth: 56, groupPadding: 0.12 }}
          yScale={{ type: "linear", domain: [0, SALES_TOP] }}
          accessibilityLabel={`Sales per month, online and in store, highest in Jul at ${total(SALES[6])}k`}
          accessibilityValue={{ text: hovered() == null ? undefined : `${shown().month}: ${shown().online}k online, ${shown().store}k in store` }}
          appearGeneration={stacked() ? 1 : 0}
          motion={{ appear: { duration: 600, easing: "easeOut" }, enter: { duration: 150 }, exit: { duration: 180 }, pointer: { stiffness: 320, damping: 32 } }}
          // The month under the pointer: a faint band over its bars.
          crossLineClass="w-full h-full"
          crossLineStyle={{ backgroundColor: tint(ui().text, 0.05) }}
          onHoverChange={(index) => {
            hovered.set(index);
            props.onHover(index);
          }}
          style={{ flex: 1, height }}
        >
          <Grid y={[40, 80, 120]} style={{ stroke: tint(ui().text, 0.08) }} />
          <Grid y={[0]} style={{ stroke: tint(ui().text, 0.2) }} />
          <Bar
            value="online"
            stack={stacked() ? "sales" : undefined}
            cornerRadii={stacked() ? 0 : tip}
            stagger={0.4}
            inactiveOpacity={0.45}
            label={stacked() ? undefined : "online"}
            labelStyle={labelStyle()}
            style={{ fill: ui().info }}
          />
          <Bar
            value="store"
            stack={stacked() ? "sales" : undefined}
            cornerRadii={tip}
            stagger={0.4}
            inactiveOpacity={0.45}
            // Stacked, the top bar's label is the month's total.
            label={stacked() ? (d: Sale) => String(total(d)) : "store"}
            labelStyle={labelStyle()}
            style={{ fill: ui().violet }}
          />
        </Plot>
        <View style={{ width: 28, height }}>
          {[0, 40, 80, 120].map((v) => (
            <Text style={{ position: "absolute", right: 0, top: (1 - v / SALES_TOP) * height - 7, fontSize: 11, color: ui().muted, ...num }}>
              {String(v)}
            </Text>
          ))}
        </View>
      </View>
      <View class="flex-row" style={{ marginRight: 36 }}>
        {SALES.map((d) => (
          <Text style={{ flex: 1, textAlign: "center", fontSize: 11, color: ui().muted }}>{d.month}</Text>
        ))}
      </View>
    </View>
  );
}

function App() {
  const chart = signal<"price" | "sales">("price");
  const mode = signal<Mode>("grouped");
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
        {desktop
          ? "Move the pointer over the chart to read a row"
          : chart() === "price"
            ? "Pick a range to draw other rows"
            : "Stack the bars to read each month's total"}
      </Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="chart">
              <Segmented options={["price", "sales"] as const} value={chart()} onChange={(c) => (chart.set(c), hovered.set(null))} />
            </Panel>
            <If
              when={chart() === "price"}
              else={
                <Panel title="bars">
                  <Segmented options={["grouped", "stacked"] as const} value={mode()} onChange={(m) => mode.set(m)} />
                  <Text style={{ fontSize: 13, color: ui().text, ...num, textAlign: "left" }}>
                    {`${SALES.length} bands · ${mode() === "stacked" ? "one stack" : "two bars"} each`}
                  </Text>
                </Panel>
              }
            >
              <Panel title="data · curve">
                <Segmented options={["1D", "1W", "1M"] as const} value={range()} onChange={(r) => (range.set(r), hovered.set(null))} />
                <Segmented options={["natural", "linear", "stepAfter"] as const} value={curve()} onChange={(c) => curve.set(c)} />
                <Text style={{ fontSize: 13, color: ui().text, ...num, textAlign: "left" }}>
                  {`${rows().length} rows · domain ${lo()} to ${hi()}`}
                </Text>
              </Panel>
            </If>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <If
          when={chart() === "price"}
          else={
            <SalesCard
              mode={mode()}
              onHover={(index) => {
                const line = index == null ? "null: left the chart" : `${index}: ${SALES[index].month}, ${total(SALES[index])}k`;
                events.set([line, ...events()].slice(0, 5));
              }}
            />
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
        </If>
      </Split>
    </View>
  );
}

mount(App);
