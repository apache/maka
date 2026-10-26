import { List, signal, Text, View } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";
import { platform } from "nsh/device";
import { alpha, Button, Caption, Card, colors, DemoPage, finish, mono, toneColor } from "../ui";

const pointer = platform.idiom === "desktop";
const size = pointer ? { gap: 10, label: 14, detail: 12, switch: "small" as const } : { gap: 12, label: 15, detail: 13, switch: "regular" as const };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Visitors per day of two weeks. */
const WEEKS: { day: string; visitors: number }[][] = [
  [1820, 2140, 1960, 2480, 2310, 1290, 1180],
  [1910, 2260, 2390, 2650, 2520, 1420, 1330],
].map((week) => week.map((visitors, i) => ({ day: DAYS[i], visitors })));

/** A repeatable walk of `count` prices from `start`. */
const walk = (count: number, seed: number, start: number) => {
  let price = start;
  let s = seed;
  return Array.from({ length: count }, (_, i) => {
    s = (s * 16807) % 2147483647;
    price += ((s % 1000) / 1000 - 0.48) * start * 0.02;
    return { i, price };
  });
};
const SYMBOLS = ["NSHL", "GPUI", "TAFY", "QJSX", "RUST", "OKLC", "SKIA", "CORE", "BASE", "WASM", "GTK4", "D2D1"];
const TICKERS = Array.from({ length: 48 }, (_, n) => {
  const points = walk(40, 7 + n * 13, 40 + ((n * 37) % 160));
  return { id: n, symbol: `${SYMBOLS[n % SYMBOLS.length]}${n >= SYMBOLS.length ? Math.floor(n / SYMBOLS.length) : ""}`, points };
});

const count = (n: number) => n.toLocaleString("en-US");
const WEEK_NAMES = ["Last week", "This week"];
/** The top of the visitors' y scale: a step above the highest grid line,
 * room for the tooltip. */
const TOP = 3500;
/** The width of the y axis' labels. */
const AXIS = 24;

/** A series' key, as its mark: a short line, dashed for the other week. */
function Key(props: { dashed?: boolean }) {
  return props.dashed ? (
    <View style={{ width: 10, flexDirection: "row", gap: 2 }}>
      <View style={{ width: 4, height: 1.5, backgroundColor: colors.muted }} />
      <View style={{ width: 4, height: 1.5, backgroundColor: colors.muted }} />
    </View>
  ) : (
    <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: toneColor("accent") }} />
  );
}

/** A legend entry: the key, then the series' name. */
function LegendItem(props: { label: string; dashed?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Key dashed={props.dashed} />
      <Text style={{ fontSize: 12, color: colors.muted }}>{props.label}</Text>
    </View>
  );
}

/** A wash of `color` under a line: its background, fading out from the
 * line's highest point (16%) to the baseline. */
const wash = (color: string) => ({
  backgroundImage: `linear-gradient(to bottom, ${alpha(color, 0.16)}, ${alpha(color, 0)})`,
});

/** A value in the tooltip, after its series' key. */
function TipValue(props: { value: string; dashed?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Key dashed={props.dashed} />
      <Text style={{ fontSize: 12, color: props.dashed ? colors.muted : colors.text, fontVariant: ["tabular-nums"] }}>{props.value}</Text>
    </View>
  );
}

/**
 * Charts: `nsh/base/plot`'s `Plot` with `Line`, `Area` and `Grid`, drawn
 * natively from the app's rows: a week of visitors over the other week
 * (dashed), with a legend, compact y labels and the hover's cross line,
 * dots (each series' own, in its color, ringed in the card's) and tooltip
 * gliding natively, and a list of sparklines, each with a wash in its tone
 * and its change beside it, that draw in as their rows come. Washes fade
 * out toward the baseline (an area's background, a gradient inside its
 * shape). Grid lines are hairlines with a firmer baseline; the tooltip
 * floats in the room above the highest value, off the lines, and stays
 * within the plot's width at the first and last days.
 */
export function Charts() {
  const last = signal("—");

  function Visitors() {
    const week = signal(0);
    const hover = signal<number | null>(null);
    // The last day hovered: the tooltip keeps it while it fades out.
    const tip = signal(0);
    const rows = () => WEEKS[week()];
    const other = () => WEEKS[1 - week()];
    const shown = () => rows()[hover() ?? rows().length - 1];
    return (
      <Card icon="stocks" title="Visitors" subtitle="A week over the other, with hover, grid lines and motion">
        <Caption label={hover() == null ? `${shown().day}, the last day` : shown().day} note={`${count(shown().visitors)} visitors`} />
        {/* The key of each series mirrors its mark: a solid line, a dashed one. */}
        <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
          <LegendItem label={WEEK_NAMES[week()]} />
          <LegendItem label={WEEK_NAMES[1 - week()]} dashed />
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginTop: size.gap }}>
          <Plot
            data={rows()}
            y="visitors"
            // Room above the highest week for the tooltip.
            yScale={{ type: "linear", domain: [0, TOP] }}
            appearGeneration={week()}
            motion={{ appear: { duration: 600, easing: "easeOut" }, enter: { duration: 150 }, exit: { duration: 150 }, pointer: { stiffness: 320, damping: 32 } }}
            accessibilityLabel={`Visitors per day, from ${count(rows()[0].visitors)} on Monday to ${count(rows()[6].visitors)} on Sunday`}
            accessibilityValue={{
              text: hover() == null ? undefined : `${shown().day}, ${count(shown().visitors)} visitors, ${count(other()[hover()!].visitors)} ${WEEK_NAMES[1 - week()].toLowerCase()}`,
            }}
            crossLineClass="w-px h-full"
            crossLineStyle={{ backgroundColor: alpha(colors.text, 0.3) }}
            // The dots' shape; each week's line gives its own its color.
            dotClass="size-2.5 rounded-full border-2"
            tooltipOffset={4}
            tooltipContent={
              <View style={{ ...finish.menu, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, height: 26, borderRadius: 8, borderWidth: 1 }}>
                <TipValue value={count(rows()[tip()].visitors)} />
                <TipValue value={count(other()[tip()].visitors)} dashed />
              </View>
            }
            onHoverChange={(index) => {
              hover.set(index);
              if (index != null) tip.set(index);
              last.set(index == null ? "Plot: left" : `Plot: ${rows()[index].day}, ${count(rows()[index].visitors)}`);
            }}
            style={{ flex: 1, height: 160 }}
          >
            <Grid y={[1000, 2000, 3000]} style={{ stroke: colors.line }} />
            {/* The line over it has the dot. */}
            <Area backgroundStyle={wash(toneColor("accent"))} hoverDotClass="hidden" />
            <Grid y={[0]} style={{ stroke: colors.border }} />
            {/* Each week's dot in its line's color, ringed in the card's, so it cuts out of the line. */}
            <Line
              data={other()}
              y="visitors"
              style={{ stroke: colors.muted, strokeWidth: 1.5, strokeDasharray: "4 4" }}
              hoverDotStyle={{ backgroundColor: colors.muted, borderColor: colors.surface }}
            />
            <Line style={{ stroke: toneColor("accent"), strokeWidth: 2 }} hoverDotStyle={{ backgroundColor: toneColor("accent"), borderColor: colors.surface }} />
          </Plot>
          {/* The y axis' labels at the grid's values, compact. */}
          <View style={{ width: AXIS, height: 160 }}>
            {[0, 1000, 2000, 3000].map((v) => (
              <Text style={{ position: "absolute", right: 0, top: (1 - v / TOP) * 160 - 8, fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>
                {v === 0 ? "0" : `${v / 1000}k`}
              </Text>
            ))}
          </View>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6, marginRight: AXIS + 8 }}>
          {DAYS.map((d) => (
            <Text style={{ fontSize: 12, color: colors.muted }}>{d}</Text>
          ))}
        </View>
        <View style={{ flexDirection: "row", marginTop: size.gap, alignSelf: pointer ? "flex-start" : "stretch" }}>
          <Button
            label={week() === 0 ? "Show this week" : "Show last week"}
            variant="secondary"
            size={size.switch}
            flex={pointer ? undefined : 1}
            onPress={() => {
              week.set(1 - week());
              hover.set(null);
              last.set(`Plot: ${week() === 0 ? "last" : "this"} week`);
            }}
          />
        </View>
      </Card>
    );
  }

  function Sparklines() {
    return (
      <Card icon="stocks" title="Sparklines" subtitle="A plot per row of a list, drawn in as the row comes">
        <List each={TICKERS} keyExtractor={(t) => String(t.id)} estimatedItemSize={44} style={{ height: 44 * 6 }}>
          {(ticker) => {
            const first = () => ticker().points[0].price;
            const close = () => ticker().points[ticker().points.length - 1].price;
            const up = () => close() >= first();
            const tone = () => (up() ? "up" : "down");
            const change = () => ((close() - first()) / first()) * 100;
            return (
              <View style={{ height: 44, flexDirection: "row", alignItems: "center", gap: size.gap }}>
                <Text style={{ width: 64, fontSize: size.label, color: colors.text, fontFamily: mono }}>{ticker().symbol}</Text>
                <Plot
                  data={ticker().points}
                  y="price"
                  interactive={false}
                  appearGeneration={ticker().id}
                  motion={{ appear: { duration: 400, easing: "easeOut" } }}
                  accessibilityLabel={`${ticker().symbol}, ${up() ? "up" : "down"} ${Math.abs(change()).toFixed(2)}%`}
                  style={{ flex: 1, height: 28 }}
                >
                  {/* A wash under the line, in its tone, fading out. */}
                  <Area backgroundStyle={wash(toneColor(tone()))} />
                  <Line style={{ stroke: toneColor(tone()), strokeWidth: 1.5 }} />
                </Plot>
                {/* The close over its change: an explicit plus, a true minus. */}
                <View style={{ width: 72, alignItems: "flex-end", gap: 2 }}>
                  <Text style={{ fontSize: size.label, color: colors.text, fontVariant: ["tabular-nums"] }}>{close().toFixed(2)}</Text>
                  <Text style={{ fontSize: size.detail, color: toneColor(tone()), fontVariant: ["tabular-nums"] }}>
                    {`${up() ? "+" : "−"}${Math.abs(change()).toFixed(2)}%`}
                  </Text>
                </View>
              </View>
            );
          }}
        </List>
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Visitors, Sparklines, Last]} />;
}
