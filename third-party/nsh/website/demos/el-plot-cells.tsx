import { mount, signal, Text, View } from "nsh";
import { Cell, Plot, PlotAxis } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui, sectionSurface, plotAxisText, seriesColor } from "./palette";

// Heatmaps: a `Cell` per row in the band of its `x` category across and
// of its `y` category down, both band scales, colored by its `value`
// through the plot's `colorScale`.
//
// The returns are a stock's months: the months across in the order of the
// x scale's `domain` (this year's months to come stay blank), the years
// down in the order the rows bring them, a loss red and a gain green along
// a diverging ramp about 0, its domain the largest move either way, each
// return written in its cell, white on the dark ones (`data-dark:`). The
// activity is a market's trades per hour of a week along a sequential
// ramp from the card's line color to the accent; the hour of its lunch
// break has no rows and stays blank. The cells grow in one after another,
// the cell under the pointer (or the arrow keys, which step across the
// grid) is ringed and read out in the header, and the others fade.
type Month = { year: string; month: string; ret: number };
type Hour = { day: string; hour: string; trades: number };

/** A repeatable stream of numbers in [0, 1), so every visit shows the same chart. */
const random = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s % 10000) / 10000;
  };
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Four years of a stock's monthly returns in percent, this year's up to October. */
const RETURNS: Month[] = (() => {
  const r = random(41);
  const drift: Record<string, number> = { "2023": 2.4, "2024": 1.9, "2025": 0.6, "2026": 1.2 };
  return Object.keys(drift).flatMap((year) =>
    MONTHS.slice(0, year === "2026" ? 10 : 12).map((month) => ({ year, month, ret: Math.round((drift[year] + (r() - 0.5) * 12) * 10) / 10 })),
  );
})();
const HOURS = ["9:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
/** A week of a market's trades per hour, in thousands: busy at the open and the close, closed from 12:00 to 13:00. */
const ACTIVITY: Hour[] = (() => {
  const r = random(17);
  const shape = [1, 0.62, 0.5, null, 0.58, 0.55, 0.86];
  return DAYS.flatMap((day, d) =>
    HOURS.flatMap((hour, h) => (shape[h] == null ? [] : [{ day, hour, trades: Math.round(40 * shape[h]! * (0.92 + d * 0.04) * (0.9 + r() * 0.2) * 10) / 10 }])),
  );
})();

const num = { fontVariant: ["tabular-nums" as const] };
const signed = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}%`;
const axisLabel = plotAxisText;
/** The largest move either way: the ends of the diverging scale's own domain. */
const REACH = Math.max(...RETURNS.map((m) => Math.abs(m.ret)));

function App() {
  const chart = signal<"returns" | "activity">("returns");
  const hovered = signal<number | null>(null);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const month = () => (hovered() == null || chart() !== "returns" ? undefined : RETURNS[hovered()!]);
  const hour = () => (hovered() == null || chart() !== "activity" ? undefined : ACTIVITY[hovered()!]);
  // A ring around the cell under the pointer, in the text's color, a little out from its edge.
  const ring = () => ({ outlineWidth: 1.5, outlineOffset: 1.5, outlineColor: ui().text });
  const returnsRamp = () => [ui().down, ui().line, ui().up];
  const activityRamp = () => [ui().line, seriesColor(0)];
  const key = (colors: string[], labels: string[]) => (
    <View style={{ gap: 4 }}>
      <View style={{ height: 6, borderRadius: 3, backgroundImage: `linear-gradient(to right, ${colors.join(", ")})` }} />
      <View class="flex-row justify-between">
        {labels.map((l) => (
          <Text style={{ fontSize: 11, color: ui().muted, ...num }}>{l}</Text>
        ))}
      </View>
    </View>
  );
  const motion = { appear: { duration: 900, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 380, damping: 34 } } as const;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>plot cells</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Move the pointer over a cell to read it" : chart() === "returns" ? "Each cell is a month's return" : "Each cell is an hour's trades"}
      </Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="chart">
              <Segmented options={["returns", "activity"] as const} value={chart()} onChange={(c) => (chart.set(c), hovered.set(null))} />
              <Text style={{ fontSize: 13, color: ui().text, ...num }}>
                {chart() === "returns" ? `colorScale diverging · ${RETURNS.length} rows` : `colorScale sequential · ${ACTIVITY.length} rows`}
              </Text>
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...sectionSurface({ padded: true }), gap: 12 }}>
          <If
            when={chart() === "returns"}
            else={
              <>
                <View class="flex-row items-baseline gap-3">
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>{hour() ? `${hour()!.day} ${hour()!.hour}` : "Trades per hour"}</Text>
                    <Text style={{ fontSize: size.detail, color: ui().muted }}>{hour() ? "thousand trades" : "A week, closed from 12:00 to 13:00"}</Text>
                  </View>
                  <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>{hour() ? `${hour()!.trades.toFixed(1)}k` : ""}</Text>
                </View>
                {key(activityRamp(), ["Fewer", "More"])}
                <Plot
                  data={ACTIVITY}
                  xScale={{ type: "band", domain: HOURS, paddingInner: 0.12 }}
                  yScale={{ type: "band", domain: DAYS, paddingInner: 0.12 }}
                  colorScale={{ type: "sequential", range: activityRamp() }}
                  accessibilityLabel="Trades per hour over a week, busiest at the open"
                  accessibilityValue={{ text: hour() && `${hour()!.day} ${hour()!.hour}: ${hour()!.trades} thousand trades` }}
                  appearGeneration="activity"
                  motion={motion}
                  onHoverChange={({ index }) => {
                    hovered.set(index);
                    const h = index == null ? undefined : ACTIVITY[index];
                    log(h == null ? "null: left the chart" : `${index}: ${h.day} ${h.hour}, ${h.trades}k`);
                  }}
                  style={{ height: DAYS.length * 30, marginLeft: 36, marginTop: 20 }}
                >
                  <Cell x="hour" y="day" value="trades" cornerRadii={4} stagger={0.6} inactiveOpacity={0.4} hoverCellClass="rounded-[5px]" hoverCellStyle={ring()} />
                  <PlotAxis placement="top" labelStyle={{ ...axisLabel(), lineHeight: 14, paddingBottom: 6 }} />
                  <PlotAxis placement="left" labelStyle={{ ...axisLabel(), width: 36, paddingRight: 8, textAlign: "right" }} />
                </Plot>
              </>
            }
          >
            <View class="flex-row items-baseline gap-3">
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>{month() ? `${month()!.month} ${month()!.year}` : "Monthly returns"}</Text>
                <Text style={{ fontSize: size.detail, color: ui().muted }}>{month() ? "the month's return" : "Red for a loss, green for a gain"}</Text>
              </View>
              <Text style={{ fontSize: 20, fontWeight: "600", color: month() ? (month()!.ret < 0 ? ui().down : ui().up) : ui().text, ...num }}>
                {month() ? signed(month()!.ret) : ""}
              </Text>
            </View>
            {key(returnsRamp(), [signed(-REACH), "0", signed(REACH)])}
            <Plot
              data={RETURNS}
              xScale={{ type: "band", domain: MONTHS, paddingInner: 0.1 }}
              yScale={{ type: "band", paddingInner: 0.12 }}
              colorScale={{ type: "diverging", range: returnsRamp() }}
              accessibilityLabel={`Monthly returns since 2023, ${RETURNS.filter((m) => m.ret > 0).length} of ${RETURNS.length} months up`}
              accessibilityValue={{ text: month() && `${month()!.month} ${month()!.year}: ${signed(month()!.ret)}` }}
              appearGeneration="returns"
              motion={motion}
              onHoverChange={({ index }) => {
                hovered.set(index);
                const m = index == null ? undefined : RETURNS[index];
                log(m == null ? "null: left the chart" : `${index}: ${m.month} ${m.year}, ${signed(m.ret)}`);
              }}
              style={{ height: 4 * 30, marginLeft: 36, marginTop: 20 }}
            >
              <Cell
                x="month"
                y="year"
                value="ret"
                cornerRadii={3}
                stagger={0.6}
                inactiveOpacity={0.4}
                label={(d: Month) => (d.ret < 0 ? `−${(-d.ret).toFixed(1)}` : d.ret.toFixed(1))}
                labelClass="text-black/70 data-dark:text-white/90"
                labelStyle={{ fontSize: 10, ...num }}
                hoverCellClass="rounded-[4px]"
                hoverCellStyle={ring()}
              />
              <PlotAxis placement="top" labelStyle={{ ...axisLabel(), lineHeight: 14, paddingBottom: 6 }} />
              <PlotAxis placement="left" labelStyle={{ ...axisLabel(), width: 36, paddingRight: 8, textAlign: "right" }} />
            </Plot>
            <Text style={{ fontSize: 12, color: tint(ui().text, 0.5) }}>Each return shows where its cell has room for it.</Text>
          </If>
        </View>
      </Split>
    </View>
  );
}

mount(App);
