import { mount, signal, Text, View } from "nsh";
import { Dot, Grid, Plot, PlotAxis } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui } from "./palette";

// Dots placed by two values of each row: a `Dot` per row at its `x` on a
// linear x scale and its `value` up the y axis. Its `color` names each
// row's category, which the plot's ordinal `colorScale` turns into the
// dot's fill; a stroke in the card's color rings each dot, so dots that
// overlap stay apart.
//
// The scatter is one session a dot, minutes in the app against trades
// placed, colored by platform. The bubbles are countries by income and
// life expectancy, each bubble's radius from its population through a
// square-root `rScale`, so its area is in proportion to it; the bigger
// bubbles draw first and the smaller stay in sight over them. The dots
// grow in one after another, the dot under the pointer (or the arrow
// keys) is ringed by its hover dot and read out in the header, and the
// others fade.
type Session = { minutes: number; trades: number; platform: "iOS" | "Android" | "Web" };
type Country = { name: string; gdp: number; life: number; pop: number; region: Region };
type Region = "Asia" | "Africa" | "Americas" | "Europe" | "Oceania";

/** A repeatable stream of numbers in [0, 1), so every visit shows the same chart. */
const random = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s % 10000) / 10000;
  };
};
const PLATFORMS = ["iOS", "Android", "Web"] as const;
/** Fifteen sessions per platform around its own habits, in the order of their length. */
const SESSIONS: Session[] = (() => {
  const r = random(23);
  const centers = { iOS: [14, 6], Android: [9, 4], Web: [24, 10] } as const;
  return PLATFORMS.flatMap((platform) =>
    Array.from({ length: 15 }, () => {
      const [m, t] = centers[platform];
      const minutes = Math.max(1, Math.round(m + (r() - 0.5) * m * 1.1));
      const trades = Math.max(0, Math.round(t * (minutes / m) + (r() - 0.5) * 5));
      return { minutes, trades, platform };
    }),
  ).sort((a, b) => a.minutes - b.minutes);
})();

/** Countries' GDP per person (thousands of dollars), life expectancy (years) and population (millions), in the order of income. */
const COUNTRIES: Country[] = (
  [
    ["Ethiopia", 1.3, 66.6, 127, "Africa"],
    ["Nigeria", 1.6, 53.6, 224, "Africa"],
    ["India", 2.5, 70.8, 1430, "Asia"],
    ["Egypt", 3.5, 70.4, 113, "Africa"],
    ["Vietnam", 4.3, 74.6, 99, "Asia"],
    ["Indonesia", 4.9, 71.3, 278, "Asia"],
    ["South Africa", 6.0, 63.2, 60, "Africa"],
    ["Brazil", 10.0, 75.8, 216, "Americas"],
    ["China", 12.6, 78.6, 1410, "Asia"],
    ["Mexico", 13.9, 74.8, 129, "Americas"],
    ["South Korea", 33.1, 83.7, 52, "Asia"],
    ["Japan", 33.8, 84.7, 124, "Asia"],
    ["France", 44.5, 82.8, 68, "Europe"],
    ["United Kingdom", 48.9, 81.3, 68, "Europe"],
    ["Germany", 52.7, 81.4, 84, "Europe"],
    ["Australia", 64.7, 83.5, 27, "Oceania"],
    ["United States", 80.4, 77.5, 335, "Americas"],
  ] as const
).map(([name, gdp, life, pop, region]) => ({ name, gdp, life, pop, region }));
const REGIONS: Region[] = ["Asia", "Africa", "Americas", "Europe", "Oceania"];

const num = { fontVariant: ["tabular-nums" as const] };
/** The room under a plot for its x axis' labels: their 12 above a line of 14. */
const AXIS_BELOW = 12 + 14;
const axisLabel = () => ({ fontSize: 11, color: ui().muted, ...num });

function App() {
  const chart = signal<"scatter" | "bubbles">("scatter");
  const hovered = signal<number | null>(null);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const height = desktop ? 220 : 200;
  const platformColors = () => [ui().accent, ui().info, ui().warn];
  const regionColors = () => [ui().info, ui().warn, ui().accent, ui().violet, ui().muted];
  const session = () => (hovered() == null || chart() !== "scatter" ? undefined : SESSIONS[hovered()!]);
  const country = () => (hovered() == null || chart() !== "bubbles" ? undefined : COUNTRIES[hovered()!]);
  // A ring around the dot under the pointer, in the text's color, a little out from its edge.
  const ring = () => ({ outlineWidth: 1.5, outlineOffset: 1.5, outlineColor: ui().text });
  const key = (color: string, label: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: color }} />
      <Text style={{ fontSize: 12, color: ui().muted }}>{label}</Text>
    </View>
  );
  const motion = { appear: { duration: 900, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 320, damping: 32 } } as const;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>plot dots</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Move the pointer over a dot to read it" : chart() === "scatter" ? "Each dot is a session, colored by platform" : "Each bubble's area is a country's population"}
      </Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="chart">
              <Segmented options={["scatter", "bubbles"] as const} value={chart()} onChange={(c) => (chart.set(c), hovered.set(null))} />
              <Text style={{ fontSize: 13, color: ui().text, ...num }}>
                {chart() === "scatter" ? `Dot x minutes · value trades · ${SESSIONS.length} rows` : `Dot r pop · rScale sqrt · ${COUNTRIES.length} rows`}
              </Text>
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 14, gap: 12 }}>
          <If
            when={chart() === "scatter"}
            else={
              <>
                <View class="flex-row items-baseline gap-3">
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>{country()?.name ?? "Income and lifespan"}</Text>
                    <Text style={{ fontSize: size.detail, color: ui().muted, ...num }}>
                      {country() ? `${country()!.region} · ${country()!.pop.toLocaleString("en-US")}M people` : "GDP per person against life expectancy"}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>{country() ? `${country()!.life.toFixed(1)} yrs` : ""}</Text>
                </View>
                <View class="flex-row flex-wrap gap-x-3 gap-y-1">{REGIONS.map((r, i) => key(regionColors()[i], r))}</View>
                <Plot
                  data={COUNTRIES}
                  x="gdp"
                  xScale={{ type: "linear", domain: [-10, 95] }}
                  yScale={{ type: "linear", domain: [48, 90] }}
                  colorScale={{ type: "ordinal", domain: REGIONS, range: regionColors().map((c) => tint(c, 0.75)) }}
                  accessibilityLabel={`${COUNTRIES.length} countries by GDP per person and life expectancy, sized by population`}
                  accessibilityValue={{ text: country() && `${country()!.name}: $${country()!.gdp}k per person, ${country()!.life} years` }}
                  appearGeneration="bubbles"
                  motion={motion}
                  onHoverChange={({ index }) => {
                    hovered.set(index);
                    const c = index == null ? undefined : COUNTRIES[index];
                    log(c == null ? "null: left the chart" : `${index}: ${c.name}, $${c.gdp}k, ${c.life} yrs, ${c.pop}M`);
                  }}
                  style={{ height, marginRight: 36, marginBottom: AXIS_BELOW }}
                >
                  <Grid x={[20, 40, 60, 80]} y={[60, 70, 80]} style={{ stroke: tint(ui().text, 0.08) }} />
                  {/* A bubble's area is its population: radii from 3 to the largest's, over 0 to the most people. */}
                  <Dot
                    value="life"
                    r="pop"
                    rScale={{ type: "sqrt", range: [3, desktop ? 26 : 18] }}
                    color="region"
                    stagger={0.5}
                    inactiveOpacity={0.25}
                    style={{ stroke: ui().card.backgroundColor, strokeWidth: 1 }}
                    hoverDotClass="rounded-full"
                    hoverDotStyle={ring()}
                  />
                  <PlotAxis placement="right" tickValues={[60, 70, 80]} format={(v) => `${v}`} labelStyle={{ ...axisLabel(), width: 36, paddingLeft: 8, textAlign: "right" }} />
                  <PlotAxis tickValues={[0, 20, 40, 60, 80]} format={(v) => `$${v}k`} labelStyle={{ ...axisLabel(), lineHeight: 14, paddingTop: 12 }} />
                </Plot>
              </>
            }
          >
            <View class="flex-row items-baseline gap-3">
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>{session() ? `${session()!.platform} session` : "Sessions"}</Text>
                <Text style={{ fontSize: size.detail, color: ui().muted, ...num }}>
                  {session() ? `${session()!.minutes} minutes in the app` : `${SESSIONS.length} sessions · minutes against trades`}
                </Text>
              </View>
              <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>{session() ? `${session()!.trades} trades` : ""}</Text>
            </View>
            <View class="flex-row flex-wrap gap-x-3 gap-y-1">{PLATFORMS.map((p, i) => key(platformColors()[i], p))}</View>
            <Plot
              data={SESSIONS}
              x="minutes"
              xScale={{ type: "linear", domain: [0, 42] }}
              yScale={{ type: "linear", domain: [0, 22] }}
              colorScale={{ type: "ordinal", domain: [...PLATFORMS], range: platformColors() }}
              accessibilityLabel={`${SESSIONS.length} sessions by minutes in the app and trades placed, longest on the web`}
              accessibilityValue={{ text: session() && `${session()!.platform}: ${session()!.minutes} minutes, ${session()!.trades} trades` }}
              appearGeneration="scatter"
              motion={motion}
              onHoverChange={({ index }) => {
                hovered.set(index);
                const s = index == null ? undefined : SESSIONS[index];
                log(s == null ? "null: left the chart" : `${index}: ${s.platform}, ${s.minutes} min, ${s.trades} trades`);
              }}
              style={{ height, marginRight: 36, marginBottom: AXIS_BELOW }}
            >
              <Grid x={[10, 20, 30, 40]} y={[5, 10, 15, 20]} style={{ stroke: tint(ui().text, 0.08) }} />
              <Grid y={[0]} style={{ stroke: tint(ui().text, 0.2) }} />
              <Dot
                value="trades"
                r={desktop ? 4 : 4.5}
                color="platform"
                stagger={0.6}
                inactiveOpacity={0.3}
                style={{ stroke: ui().card.backgroundColor, strokeWidth: 1.5 }}
                hoverDotClass="rounded-full"
                hoverDotStyle={ring()}
              />
              <PlotAxis placement="right" tickValues={[5, 10, 15, 20]} labelStyle={{ ...axisLabel(), width: 36, paddingLeft: 8, textAlign: "right" }} />
              <PlotAxis tickValues={[0, 10, 20, 30, 40]} format={(v) => `${v} min`} labelStyle={{ ...axisLabel(), lineHeight: 14, paddingTop: 12 }} />
            </Plot>
          </If>
        </View>
      </Split>
    </View>
  );
}

mount(App);
