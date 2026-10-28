import type { JSX } from "nsh";
import { cleanup, reduceMotion, signal, Text, View } from "nsh";
import { Arc, Area, Bar, Grid, Line, Pie, Plot } from "nsh/base/plot";
import { platform } from "nsh";
import { alpha, Button, Card, colors, DemoPage, finish, focusRing, Legend, mono, Segmented, toneColor, type Tone } from "../ui";

const pointer = platform.idiom === "desktop";
const size = pointer ? { gap: 10, switch: "small" as const } : { gap: 12, switch: "regular" as const };

/** A repeatable stream of numbers in [0, 1). */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s % 100000) / 100000;
  };
}

/** Values on the axes: small, monospaced and faint, so the marks lead. */
const axis = { fontSize: 10.5, fontFamily: mono, color: colors.faint, fontVariant: ["tabular-nums" as const] };
/** A tooltip's title: a small monospaced caps label over its values. */
const tipTitle = { fontSize: 10, fontFamily: mono, letterSpacing: 0.8, color: colors.muted };
/** A floating tooltip card. */
const tipCard = { ...finish.menu, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 6 };
/** A wash under a line: `color` at `top` opacity fading out to the baseline. */
const wash = (color: string, top = 0.18) => ({
  backgroundImage: `linear-gradient(to bottom, ${alpha(color, top)}, ${alpha(color, 0)})`,
});
const fixed = (n: number, digits = 2) => n.toFixed(digits);
const count = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number, digits = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
/** Grid values at a "nice" step (1, 2 or 5 × 10^k) strictly inside `lo..hi`, about `want` of them. */
function ticks(lo: number, hi: number, want = 4) {
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) if (v > lo) out.push(Math.round(v / step) * step);
  return out;
}

/** A label and its value, in a row of figures under a chart. */
function Figure(props: { label: string; value: string; tone?: Tone }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={{ fontSize: 10, fontFamily: mono, letterSpacing: 0.8, color: colors.faint }}>{props.label.toUpperCase()}</Text>
      <Text style={{ fontSize: 14, fontWeight: "500", color: props.tone ? toneColor(props.tone) : colors.text, fontVariant: ["tabular-nums"] }}>{props.value}</Text>
    </View>
  );
}

/** Figures in a row, over a hairline. */
function Figures(props: { children: JSX.Element }) {
  return <View style={{ flexDirection: "row", gap: 12, paddingTop: 12, borderTopWidth: 1, borderColor: colors.line }}>{props.children}</View>;
}

const LIVE_POINTS = 60;
const LIVE_HEIGHT = 176;
/** The gutter right of the live plot: the y labels and the last price's tag. */
const GUTTER = 58;
/** The session's open. */
const OPEN = 41.2;
/** The first tick's time of day, in seconds. */
const START = 10 * 3600 + 42 * 60;
const clock = (t: number) => {
  const s = START + t;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
};

/**
 * A minute of a price, a tick a second: the newest point is the plot's
 * right edge, its dot breathing while the stream runs, its price tagged in
 * the gutter at its height. The y domain holds still while the window fits
 * in it and re-fits only when the price leaves it or uses too little of it,
 * so the grid does not jump with every tick.
 */
function Live() {
  const next = random(29);
  let t = 0;
  let price = OPEN;
  const step = () => {
    price = Math.max(1, price + (next() - 0.485) * 0.16);
    t += 1;
    return { t, price: Math.round(price * 100) / 100 };
  };
  const points = signal(Array.from({ length: LIVE_POINTS }, step));
  const fit = (rows: { price: number }[]): [number, number] => {
    const values = rows.map((r) => r.price);
    const [lo, hi] = [Math.min(...values), Math.max(...values)];
    const pad = Math.max(0.2, (hi - lo) * 0.3);
    return [Math.floor((lo - pad) * 10) / 10, Math.ceil((hi + pad) * 10) / 10];
  };
  const domain = signal(fit(points()));
  const running = signal(true);
  const hover = signal<number | null>(null);
  const tip = signal(LIVE_POINTS - 1);
  const timer = setInterval(() => {
    if (!running()) return;
    const rows = [...points().slice(1), step()];
    points.set(rows);
    const [lo, hi] = domain();
    const values = rows.map((r) => r.price);
    const [min, max] = [Math.min(...values), Math.max(...values)];
    if (min < lo || max > hi || max - min < (hi - lo) * 0.3) domain.set(fit(rows));
  }, 1000);
  cleanup(() => clearInterval(timer));

  const last = () => points()[points().length - 1].price;
  const change = () => last() - OPEN;
  const tone = (): Tone => (change() >= 0 ? "up" : "down");
  const y = (v: number) => (1 - (v - domain()[0]) / (domain()[1] - domain()[0])) * LIVE_HEIGHT;
  const grid = () => ticks(domain()[0], domain()[1]);
  const high = () => Math.max(...points().map((p) => p.price));
  const low = () => Math.min(...points().map((p) => p.price));
  const breathing = () => running() && !reduceMotion();
  return (
    <Card icon="stocks" title="Live price" subtitle="A tick a second, the last price tagged at its height">
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 13, fontFamily: mono, color: colors.muted }}>NSHL</Text>
            {/* Live: a dot that breathes while the stream runs. */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View style={{ width: 6, height: 6 }}>
                <If when={breathing()}>
                  <View class="animate-ping" style={{ position: "absolute", width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor("up") }} />
                </If>
                <View style={{ position: "absolute", width: 6, height: 6, borderRadius: 3, backgroundColor: running() ? toneColor("up") : colors.faint }} />
              </View>
              <Text style={{ fontSize: 10, fontFamily: mono, letterSpacing: 0.8, color: running() ? toneColor("up") : colors.faint }}>{running() ? "LIVE" : "PAUSED"}</Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Text style={{ fontSize: 30, fontWeight: "600", letterSpacing: -0.6, color: colors.text, fontVariant: ["tabular-nums"] }}>{fixed(last())}</Text>
            <Text style={{ fontSize: 13, fontWeight: "500", color: toneColor(tone()), fontVariant: ["tabular-nums"] }}>
              {`${signed(change())}  ${signed((change() / OPEN) * 100)}%`}
            </Text>
          </View>
        </View>
        <Button
          label={running() ? "Pause" : "Resume"}
          variant="secondary"
          size="small"
          onPress={() => running.set(!running())}
        />
      </View>
      <View style={{ flexDirection: "row", marginTop: size.gap }}>
        <Plot
          data={points()}
          y="price"
          yScale={{ type: "linear", domain: domain() }}
          appearGeneration={1}
          motion={{ appear: { duration: 900, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 380, damping: 36 } }}
          accessibilityLabel={`NSHL, the last minute, ${fixed(last())}, ${signed((change() / OPEN) * 100)}% on the day`}
          accessibilityValue={{ text: hover() == null ? undefined : `${clock(points()[hover()!].t)}, ${fixed(points()[hover()!].price)}` }}
          crossLineClass="w-px h-full"
          crossLineStyle={{ backgroundColor: alpha(colors.text, 0.22) }}
          dotClass="size-2.5 rounded-full border-2"
          tooltipPlacement="pointer"
          tooltipOffset={10}
          tooltipContent={
            <View style={tipCard}>
              <Text style={tipTitle}>{clock(points()[tip()].t)}</Text>
              <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text, fontVariant: ["tabular-nums"] }}>{fixed(points()[tip()].price)}</Text>
            </View>
          }
          onHoverChange={(index) => {
            hover.set(index);
            if (index != null) tip.set(index);
          }}
          focusStyle={focusRing(4)}
          style={{ flex: 1, height: LIVE_HEIGHT }}
        >
          <Grid y={grid()} style={{ stroke: colors.line }} />
          {/* The open: a faint dashed reference, while it is in view. */}
          <Grid y={OPEN > domain()[0] && OPEN < domain()[1] ? [OPEN] : []} style={{ stroke: alpha(colors.text, 0.28), strokeDasharray: "2 4" }} />
          <Area backgroundStyle={wash(toneColor(tone()), 0.2)} hoverDotClass="hidden" />
          <Line style={{ stroke: toneColor(tone()), strokeWidth: 1.75 }} hoverDotStyle={{ backgroundColor: toneColor(tone()), borderColor: colors.inset }} />
          {/* The newest point: a dot ringed in the inset's color, its halo breathing. */}
          <View style={{ position: "absolute", left: "100%", top: y(last()), width: 0, height: 0, pointerEvents: "none" }}>
            <If when={breathing()}>
              <View class="animate-ping" style={{ position: "absolute", left: -6, top: -6, width: 12, height: 12, borderRadius: 6, backgroundColor: alpha(toneColor(tone()), 0.5) }} />
            </If>
            <View style={{ position: "absolute", left: -4.5, top: -4.5, width: 9, height: 9, borderRadius: 4.5, borderWidth: 2, borderColor: colors.inset, backgroundColor: toneColor(tone()) }} />
          </View>
        </Plot>
        {/* The gutter: the grid's values, and over them the last price's tag at its height. */}
        <View style={{ width: GUTTER, height: LIVE_HEIGHT }}>
          {grid()
            .filter((v) => Math.abs(y(v) - y(last())) > 14)
            .map((v) => (
              <Text style={{ ...axis, position: "absolute", left: 10, top: y(v) - 7 }}>{fixed(v)}</Text>
            ))}
          <View
            style={{
              position: "absolute",
              left: 6,
              top: y(last()) - 10,
              height: 20,
              paddingHorizontal: 6,
              borderRadius: 6,
              justifyContent: "center",
              backgroundColor: toneColor(tone()),
            }}
          >
            <Text style={{ fontSize: 11, fontFamily: mono, fontWeight: "600", color: colors.surface, fontVariant: ["tabular-nums"] }}>{fixed(last())}</Text>
          </View>
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8, marginRight: GUTTER }}>
        {["−60s", "−45s", "−30s", "−15s", "now"].map((label) => (
          <Text style={axis}>{label}</Text>
        ))}
      </View>
      <View style={{ marginTop: size.gap + 4 }}>
        <Figures>
          <Figure label="Open" value={fixed(OPEN)} />
          <Figure label="High" value={fixed(high())} />
          <Figure label="Low" value={fixed(low())} />
          <Figure label="Range" value={`${fixed(((high() - low()) / low()) * 100)}%`} />
        </Figures>
      </View>
    </Card>
  );
}

/** The book around the middle price: levels a tick apart on each side. */
const MID = 100;
const TICK = 0.02;
const LEVELS = 40;
type Level = { price: number; bid?: number; ask?: number };
/** Each side's sizes, thicker away from the middle, with a few walls. */
const SIDES = (() => {
  const r = random(83);
  const side = () =>
    Array.from({ length: LEVELS }, (_, k) => {
      const wall = r() > 0.9 ? 3.2 : 1;
      return Math.round((30 + r() * 140) * (1 + k / 14) * wall);
    });
  return { bids: side(), asks: side() };
})();
/** The levels within `n` ticks of the best prices, from the lowest bid up: each
 * side's size summed from the best price out. */
function book(n: number): Level[] {
  const bids: Level[] = [];
  let sum = 0;
  for (let k = 0; k < n; k++) {
    sum += SIDES.bids[k];
    bids.unshift({ price: Math.round((MID - TICK - k * TICK) * 100) / 100, bid: sum });
  }
  const asks: Level[] = [];
  sum = 0;
  for (let k = 0; k < n; k++) {
    sum += SIDES.asks[k];
    asks.push({ price: Math.round((MID + TICK + k * TICK) * 100) / 100, ask: sum });
  }
  return [...bids, ...asks];
}
const DEPTH_HEIGHT = 168;
const RANGES = [
  { value: "10", label: "10 ticks" },
  { value: "20", label: "20 ticks" },
  { value: "40", label: "40 ticks" },
] as const;

/**
 * An order book's depth: the bids' size summed from the best bid down on
 * the left, the asks' from the best ask up on the right, as steps (a
 * level's size holds until the next one), the spread a gap in the middle.
 * The side under the pointer shows its dot and its sum; the bar under the
 * plot weighs one side against the other.
 */
function Depth() {
  const range = signal<(typeof RANGES)[number]["value"]>("20");
  const rows = () => book(Number(range()));
  const hover = signal<number | null>(null);
  const tip = signal(0);
  const lo = () => rows()[0].price - TICK;
  const hi = () => rows()[rows().length - 1].price + TICK;
  const top = () => Math.max(...rows().map((r) => r.bid ?? r.ask ?? 0)) * 1.18;
  const at = (price: number): `${number}%` => `${((price - lo()) / (hi() - lo())) * 100}%`;
  const bids = () => rows().reduce((s, r) => Math.max(s, r.bid ?? 0), 0);
  const asks = () => rows().reduce((s, r) => Math.max(s, r.ask ?? 0), 0);
  const shown = () => rows()[tip()] ?? rows()[0];
  const side = () => (shown().bid != null ? "bid" : "ask");
  const hoveredSide = () => (hover() == null ? null : side());
  // A side's dot shows only while the pointer is over that side.
  const dot = (which: "bid" | "ask", tone: Tone) => ({
    backgroundColor: toneColor(tone),
    borderColor: colors.inset,
    opacity: hoveredSide() === which ? 1 : 0,
  });
  return (
    <Card icon="stocks" title="Order book depth" subtitle="Each side summed out from the spread, as steps">
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={{ fontSize: 22, fontWeight: "600", letterSpacing: -0.4, color: colors.text, fontVariant: ["tabular-nums"] }}>{fixed(MID)}</Text>
        <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`mid · spread ${fixed(TICK * 2)} (${fixed(((TICK * 2) / MID) * 100)}%)`}</Text>
      </View>
      <View style={{ marginTop: size.gap }}>
        <Plot
          data={rows()}
          x="price"
          xScale={{ type: "linear", domain: [lo(), hi()] }}
          yScale={{ type: "linear", domain: [0, top()] }}
          appearGeneration={Number(range())}
          motion={{ appear: { duration: 700, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 420, damping: 40 } }}
          accessibilityLabel={`Order book depth within ${range()} ticks: ${count(bids())} bid, ${count(asks())} asked`}
          accessibilityValue={{ text: hover() == null ? undefined : `${side() === "bid" ? "Bids" : "Asks"} to ${fixed(shown().price)}: ${count(shown().bid ?? shown().ask ?? 0)}` }}
          crossLineClass="w-px h-full"
          crossLineStyle={{ backgroundColor: alpha(colors.text, 0.22) }}
          dotClass="size-2.5 rounded-full border-2"
          tooltipOffset={6}
          tooltipContent={
            <View style={tipCard}>
              <Text style={{ ...tipTitle, color: toneColor(side() === "bid" ? "up" : "down") }}>{side() === "bid" ? `BIDS ≥ ${fixed(shown().price)}` : `ASKS ≤ ${fixed(shown().price)}`}</Text>
              <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text, fontVariant: ["tabular-nums"] }}>{count(shown().bid ?? shown().ask ?? 0)}</Text>
            </View>
          }
          onHoverChange={(index) => {
            hover.set(index);
            if (index != null) tip.set(index);
          }}
          focusStyle={focusRing(4)}
          style={{ height: DEPTH_HEIGHT }}
        >
          <Grid y={ticks(0, top(), 3)} style={{ stroke: colors.line }} />
          {/* The middle: a dashed hairline in the spread. */}
          <View style={{ position: "absolute", left: at(MID), top: 0, bottom: 0, borderLeftWidth: 1, borderStyle: "dashed", borderColor: alpha(colors.text, 0.2), pointerEvents: "none" }} />
          <Area y1="bid" curve="stepAfter" backgroundStyle={wash(toneColor("up"), 0.22)} hoverDotClass="hidden" />
          <Area y1="ask" curve="stepAfter" backgroundStyle={wash(toneColor("down"), 0.22)} hoverDotClass="hidden" />
          <Line y="bid" curve="stepAfter" style={{ stroke: toneColor("up"), strokeWidth: 1.5 }} hoverDotStyle={dot("bid", "up")} />
          <Line y="ask" curve="stepAfter" style={{ stroke: toneColor("down"), strokeWidth: 1.5 }} hoverDotStyle={dot("ask", "down")} />
          <Grid y={[0]} style={{ stroke: colors.border }} />
        </Plot>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
        <Text style={axis}>{fixed(lo())}</Text>
        <Text style={{ ...axis, color: colors.muted }}>{fixed(MID)}</Text>
        <Text style={axis}>{fixed(hi())}</Text>
      </View>
      {/* The balance: each side's share of what the book holds in view. */}
      <View style={{ marginTop: size.gap + 4, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 12, color: toneColor("up"), fontVariant: ["tabular-nums"] }}>{`Bids ${fixed((bids() / (bids() + asks())) * 100, 0)}%`}</Text>
          <Text style={{ fontSize: 12, color: toneColor("down"), fontVariant: ["tabular-nums"] }}>{`${fixed((asks() / (bids() + asks())) * 100, 0)}% Asks`}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 3, height: 4 }}>
          <View class="transition-all duration-500 motion-reduce:transition-none" style={{ flex: bids(), borderRadius: 2, backgroundColor: toneColor("up") }} />
          <View class="transition-all duration-500 motion-reduce:transition-none" style={{ flex: asks(), borderRadius: 2, backgroundColor: toneColor("down") }} />
        </View>
      </View>
      <View style={{ marginTop: size.gap + 2, alignSelf: pointer ? "flex-start" : "stretch", width: pointer ? 260 : undefined }}>
        <Segmented options={RANGES} value={range()} size={size.switch} onChange={(next) => range.set(next)} />
      </View>
    </Card>
  );
}

/** A portfolio's value over 120 days and how far each day sits under its best so far. */
const EQUITY = (() => {
  const r = random(5);
  let value = 10000;
  let peak = value;
  return Array.from({ length: 120 }, (_, day) => {
    // A rally, a slide, a recovery: drift that changes sign with the phase.
    const drift = day < 38 ? 0.004 : day < 66 ? -0.0062 : 0.0058;
    value *= 1 + drift + (r() - 0.5) * 0.018;
    peak = Math.max(peak, value);
    return { day, value: Math.round(value), drawdown: (value / peak - 1) * 100 };
  });
})();
const TROUGH = EQUITY.reduce((a, b) => (b.drawdown < a.drawdown ? b : a));
const PEAK = EQUITY.slice(0, TROUGH.day + 1).reduce((a, b) => (b.value > a.value ? b : a));
/** The days of the worst run, from its high to its low. */
const WORST_RUN = EQUITY.slice(PEAK.day, TROUGH.day + 1);
const RECOVERED = EQUITY.find((d) => d.day > TROUGH.day && d.value >= PEAK.value);
const UNDERWATER = EQUITY.filter((d) => d.drawdown < -0.05).length / EQUITY.length;
const EQUITY_HEIGHT = 140;
const WATER_HEIGHT = 64;
const DD_FLOOR = Math.floor(TROUGH.drawdown / 5) * 5 - 2;
const VALUE_LO = Math.min(...EQUITY.map((d) => d.value)) * 0.97;
const VALUE_HI = Math.max(...EQUITY.map((d) => d.value)) * 1.03;
/** Where day `i` is across both plots (their rows are evenly spread). */
const across = (i: number): `${number}%` => `${(i / (EQUITY.length - 1)) * 100}%`;

/**
 * A portfolio's value over its drawdown: the equity curve, the worst run
 * from a high to its low shaded on it, and under it the "underwater" plot,
 * how far each day sits below the best day before it. The day under the
 * pointer is marked on both plots and read out above them.
 */
function Drawdown() {
  const hover = signal<number | null>(null);
  // Which plot the pointer is over: the other one marks the day itself.
  const over = signal<"equity" | "water" | null>(null);
  const shown = () => EQUITY[hover() ?? EQUITY.length - 1];
  const follow = (which: "equity" | "water") => (index: number | null) => {
    hover.set(index);
    over.set(index == null ? null : which);
  };
  // Where the hovered day is on each plot, from its own scale.
  const height = (which: "equity" | "water") =>
    which === "equity"
      ? (1 - (shown().value - VALUE_LO) / (VALUE_HI - VALUE_LO)) * EQUITY_HEIGHT
      : (shown().drawdown / DD_FLOOR) * WATER_HEIGHT;
  const mark = (which: "equity" | "water", tone: Tone) => (
    <If when={hover() != null && over() !== which}>
      <View style={{ position: "absolute", left: across(hover() ?? 0), top: 0, bottom: 0, width: 1, backgroundColor: alpha(colors.text, 0.22), pointerEvents: "none" }} />
      <View style={{ position: "absolute", left: across(hover() ?? 0), top: height(which), width: 0, height: 0, pointerEvents: "none" }}>
        <View style={{ position: "absolute", left: -4, top: -4, width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: colors.inset, backgroundColor: toneColor(tone) }} />
      </View>
    </If>
  );
  const total = (EQUITY[EQUITY.length - 1].value / EQUITY[0].value - 1) * 100;
  return (
    <Card icon="stocks" title="Drawdown" subtitle="Value over its distance from the high, the worst run shaded">
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={{ fontSize: 22, fontWeight: "600", letterSpacing: -0.4, color: colors.text, fontVariant: ["tabular-nums"] }}>{`$${count(shown().value)}`}</Text>
        <Text style={{ fontSize: 12, color: shown().drawdown < -0.05 ? toneColor("danger") : colors.muted, fontVariant: ["tabular-nums"] }}>
          {shown().drawdown < -0.05 ? `${signed(shown().drawdown, 1)}% from the high` : "at a high"}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ ...axis, color: colors.muted }}>{`DAY ${shown().day + 1}`}</Text>
      </View>
      <View style={{ marginTop: size.gap, gap: 6 }}>
        <Plot
          data={EQUITY}
          // Days on a linear scale, so the worst run's own rows land on their days.
          x="day"
          xScale={{ type: "linear", domain: [0, EQUITY.length - 1] }}
          y="value"
          yScale={{ type: "linear", domain: [VALUE_LO, VALUE_HI] }}
          appearGeneration={1}
          // No pointer spring: the other plot marks the same day at once, so both move together.
          motion={{ appear: { duration: 1000, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 } }}
          accessibilityLabel={`Portfolio value over 120 days, ${signed(total, 1)}%; worst drawdown ${signed(TROUGH.drawdown, 1)}% from day ${PEAK.day + 1} to day ${TROUGH.day + 1}`}
          accessibilityValue={{ text: hover() == null ? undefined : `Day ${shown().day + 1}, $${count(shown().value)}, ${signed(shown().drawdown, 1)}%` }}
          crossLineClass="w-px h-full"
          crossLineStyle={{ backgroundColor: alpha(colors.text, 0.22) }}
          dotClass="size-2.5 rounded-full border-2"
          onHoverChange={follow("equity")}
          focusStyle={focusRing(4)}
          style={{ height: EQUITY_HEIGHT }}
        >
          {/* The worst run, from its high to its low, its value hatched under the curve. */}
          <View style={{ position: "absolute", left: across(PEAK.day), width: `${((TROUGH.day - PEAK.day) / (EQUITY.length - 1)) * 100}%`, top: 0, bottom: 0, backgroundColor: alpha(colors.danger, 0.04), pointerEvents: "none" }}>
            <Text style={{ ...axis, position: "absolute", left: 6, top: 6, color: toneColor("danger") }}>{`MAX ${signed(TROUGH.drawdown, 1)}%`}</Text>
          </View>
          <Grid y={ticks(VALUE_LO, VALUE_HI, 3)} style={{ stroke: colors.line }} />
          <Area backgroundStyle={wash(toneColor("accent"), 0.16)} hoverDotClass="hidden" />
          {/* Hairline stripes 6pt apart, falling to the right. */}
          <Area
            data={WORST_RUN}
            x="day"
            backgroundStyle={{ backgroundImage: `repeating-linear-gradient(-45deg, ${alpha(colors.danger, 0.32)} 0px, ${alpha(colors.danger, 0.32)} 1px, transparent 1px, transparent 6px)` }}
            hoverDotClass="hidden"
          />
          <Line style={{ stroke: toneColor("accent"), strokeWidth: 1.75 }} hoverDotStyle={{ backgroundColor: toneColor("accent"), borderColor: colors.inset }} />
          {mark("equity", "accent")}
        </Plot>
        {/* Underwater: hanging from zero, deeper red the further down. */}
        <Plot
          data={EQUITY}
          y="drawdown"
          yScale={{ type: "linear", domain: [DD_FLOOR, 0] }}
          appearGeneration={1}
          motion={{ appear: { duration: 1000, easing: "easeOut" }, enter: { duration: 120 }, exit: { duration: 160 } }}
          accessibilityLabel={`Drawdown from the high, at worst ${signed(TROUGH.drawdown, 1)}% on day ${TROUGH.day + 1}`}
          accessibilityValue={{ text: hover() == null ? undefined : `Day ${shown().day + 1}, ${signed(shown().drawdown, 1)}% from the high` }}
          crossLineClass="w-px h-full"
          crossLineStyle={{ backgroundColor: alpha(colors.text, 0.22) }}
          dotClass="size-2 rounded-full border-2"
          onHoverChange={follow("water")}
          focusStyle={focusRing(4)}
          style={{ height: WATER_HEIGHT }}
        >
          <Area
            y0={0}
            backgroundStyle={{ backgroundImage: `linear-gradient(to bottom, ${alpha(colors.danger, 0.04)}, ${alpha(colors.danger, 0.26)})` }}
            hoverDotClass="hidden"
          />
          <Line style={{ stroke: toneColor("danger"), strokeWidth: 1.25 }} hoverDotStyle={{ backgroundColor: toneColor("danger"), borderColor: colors.inset }} />
          {/* The floor's value, and the low marked where it is. */}
          <Text style={{ ...axis, position: "absolute", left: 0, bottom: 2, pointerEvents: "none" }}>{`${DD_FLOOR}%`}</Text>
          <View style={{ position: "absolute", left: across(TROUGH.day), top: (TROUGH.drawdown / DD_FLOOR) * WATER_HEIGHT, width: 0, height: 0, pointerEvents: "none" }}>
            <View style={{ position: "absolute", left: -3.5, top: -3.5, width: 7, height: 7, borderRadius: 3.5, borderWidth: 1.5, borderColor: colors.inset, backgroundColor: toneColor("danger") }} />
            {/* A width of its own: the zero-width anchor would wrap it at every break. */}
            <Text style={{ ...axis, position: "absolute", left: 8, top: -6, width: 64, color: toneColor("danger") }}>{`${signed(TROUGH.drawdown, 1)}%`}</Text>
          </View>
          {mark("water", "danger")}
        </Plot>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
        {["Day 1", "30", "60", "90", "120"].map((label) => (
          <Text style={axis}>{label}</Text>
        ))}
      </View>
      <View style={{ marginTop: size.gap + 4 }}>
        <Figures>
          <Figure label="Return" value={`${signed(total, 1)}%`} tone={total >= 0 ? "up" : "down"} />
          <Figure label="Worst" value={`${signed(TROUGH.drawdown, 1)}%`} tone="danger" />
          <Figure label="Recovery" value={RECOVERED ? `${RECOVERED.day - TROUGH.day} days` : "—"} />
          <Figure label="Underwater" value={`${fixed(UNDERWATER * 100, 0)}%`} />
        </Figures>
      </View>
    </Card>
  );
}

/** Three resources' load, by period. */
const PERIODS = [
  { value: "now", label: "Now" },
  { value: "day", label: "24h peak" },
  { value: "week", label: "7d peak" },
] as const;
type Period = (typeof PERIODS)[number]["value"];
const RESOURCES: { name: string; tone: Tone; unit: string; total: number; used: Record<Period, number> }[] = [
  { name: "Compute", tone: "accent", unit: "vCPU", total: 64, used: { now: 38, day: 51, week: 59 } },
  { name: "Memory", tone: "info", unit: "GB", total: 256, used: { now: 141, day: 188, week: 214 } },
  { name: "Network", tone: "warn", unit: "Gbps", total: 10, used: { now: 3.2, day: 7.4, week: 8.9 } },
];
const RINGS = pointer ? 164 : 172;
/** Each ring's width and the gap between rings, in points. */
const RING_WIDTH = 11;
const RING_GAP = 5;

/**
 * Capacity as rings: a track per resource and over it the share in use,
 * sweeping in from 12 o'clock, again for each period; the average in the
 * middle and the figures beside, in the rings' colors.
 */
function Capacity() {
  const period = signal<Period>("now");
  const share = (r: (typeof RESOURCES)[number]) => r.used[period()] / r.total;
  const average = () => RESOURCES.reduce((s, r) => s + share(r), 0) / RESOURCES.length;
  const outer = RINGS / 2 - 2;
  const radii = RESOURCES.map((_, i) => {
    const o = outer - i * (RING_WIDTH + RING_GAP);
    return { outer: o, inner: o - RING_WIDTH };
  });
  const generation = () => PERIODS.findIndex((p) => p.value === period()) + 1;
  return (
    <Card icon="system" title="Capacity" subtitle="Rings of load against each resource's limit">
      <View style={{ flexDirection: pointer ? "row" : "column", alignItems: "center", gap: pointer ? 24 : 16 }}>
        <Plot
          data={RESOURCES}
          interactive={false}
          appearGeneration={generation()}
          motion={{ appear: { duration: 1100, easing: "easeOut" } }}
          accessibilityLabel={`Capacity, ${PERIODS.find((p) => p.value === period())!.label}: ${RESOURCES.map((r) => `${r.name} ${fixed(share(r) * 100, 0)}%`).join(", ")}`}
          style={{ width: RINGS, height: RINGS }}
        >
          {RESOURCES.map((r, i) => (
            <Arc innerRadius={radii[i].inner} outerRadius={radii[i].outer} style={{ fill: alpha(toneColor(r.tone), 0.13) }} />
          ))}
          {RESOURCES.map((r, i) => (
            <Arc innerRadius={radii[i].inner} outerRadius={radii[i].outer} endAngle={share(r) * 2 * Math.PI} style={{ fill: toneColor(r.tone) }} />
          ))}
          <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 2, pointerEvents: "none" }}>
            <Text style={{ fontSize: 22, fontWeight: "600", letterSpacing: -0.4, color: colors.text, fontVariant: ["tabular-nums"] }}>{`${fixed(average() * 100, 0)}%`}</Text>
            <Text style={{ fontSize: 10, fontFamily: mono, letterSpacing: 0.8, color: colors.faint }}>AVG LOAD</Text>
          </View>
        </Plot>
        <View style={{ alignSelf: "stretch", flex: pointer ? 1 : undefined, justifyContent: "center", gap: 14 }}>
          {RESOURCES.map((r) => (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(r.tone) }} />
                <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{r.name}</Text>
                <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{`${fixed(share(r) * 100, 0)}%`}</Text>
              </View>
              <Text style={{ ...axis, marginLeft: 16 }}>{`${r.used[period()]} / ${r.total} ${r.unit}`}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={{ marginTop: size.gap + 4, alignSelf: pointer ? "flex-start" : "stretch", width: pointer ? 260 : undefined }}>
        <Segmented options={PERIODS} value={period()} size={size.switch} onChange={(next) => period.set(next)} />
      </View>
    </Card>
  );
}

/** Revenue of a quarter by region, in thousands, the largest first. */
const REGIONS = [
  { name: "North America", revenue: 482 },
  { name: "EMEA", revenue: 312 },
  { name: "APAC", revenue: 268 },
  { name: "Latin America", revenue: 104 },
  { name: "Other", revenue: 74 },
];
const REVENUE = REGIONS.reduce((sum, r) => sum + r.revenue, 0);
/** The theme's series colors: a slice's fill, its legend key's background. */
const FILLS = ["fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-chart-4", "fill-chart-5"];
const KEYS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];
const money = (k: number) => (k >= 1000 ? `$${(k / 1000).toFixed(2)}M` : `$${k}k`);
const portion = (k: number) => `${((k / REVENUE) * 100).toFixed(1)}%`;
/** The ring's size, its rim 8 points in (room for the lift), the gaps
 * between slices 2 points wide there. */
const RING = pointer ? 168 : 176;
const RIM = RING / 2 - 8;

/**
 * Revenue by region as a donut: 2-point gaps of even width, the hovered
 * slice lifted and the others dimmed, its value in the hole, a legend with
 * tabular figures at the trailing edge whose hovered row stands out; it
 * closes into a pie, the hole's radius moving on `motion.update`.
 */
function Revenue() {
  const hover = signal<number | null>(null);
  const donut = signal(true);
  const shown = () => (hover() == null ? undefined : REGIONS[hover()!]);
  return (
    <Card icon="stocks" title="Revenue by region" subtitle="A donut of shares, the hovered slice lifted">
      <View style={{ flexDirection: pointer ? "row" : "column", alignItems: "center", gap: pointer ? 24 : 16 }}>
        <Plot
          data={REGIONS}
          accessibilityLabel={`Revenue by region, ${money(REVENUE)} in all; largest North America at ${portion(482)}`}
          accessibilityValue={{ text: shown() && `${shown()!.name}: ${money(shown()!.revenue)}, ${portion(shown()!.revenue)}` }}
          appearGeneration={1}
          motion={{ appear: { duration: 900, easing: "easeOut" }, update: { duration: 450, easing: "easeInOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 420, damping: 40 } }}
          onHoverChange={(index) => hover.set(index)}
          focusStyle={{ ...focusRing(4), borderRadius: RING / 2 }}
          style={{ width: RING, height: RING }}
        >
          <Pie
            value="revenue"
            innerRadius={donut() ? RIM * 0.62 : 0}
            outerRadius={RIM}
            padAngle={2 / RIM}
            sliceClass={(_, i) => FILLS[i % FILLS.length]}
            hoverLift={6}
            hoverDim={0.64}
          />
          {/* The total in the hole fades as it opens and closes. */}
          <View
            class="transition-opacity duration-300 motion-reduce:transition-none"
            style={{ pointerEvents: "none", position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 2, opacity: donut() ? 1 : 0 }}
          >
            <Text style={{ fontSize: 10, fontFamily: mono, letterSpacing: 0.8, color: colors.faint }}>{(shown()?.name ?? "Total").toUpperCase()}</Text>
            <Text style={{ fontSize: 20, fontWeight: "600", letterSpacing: -0.4, color: colors.text, fontVariant: ["tabular-nums"] }}>{money(shown()?.revenue ?? REVENUE)}</Text>
          </View>
        </Plot>
        <View style={{ alignSelf: "stretch", flex: pointer ? 1 : undefined, justifyContent: "center", gap: 2 }}>
          {REGIONS.map((r, i) => (
            <View
              class="transition-opacity duration-150 motion-reduce:transition-none"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                height: pointer ? 30 : 36,
                paddingHorizontal: 8,
                borderRadius: 6,
                backgroundColor: hover() === i ? alpha(colors.text, 0.05) : undefined,
                opacity: hover() == null || hover() === i ? 1 : 0.45,
              }}
            >
              <View class={KEYS[i]} style={{ width: 8, height: 8, borderRadius: 2 }} />
              <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, color: colors.text }}>{r.name}</Text>
              <Text style={{ fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"], textAlign: "right" }}>{money(r.revenue)}</Text>
              <Text style={{ width: 48, fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"], textAlign: "right" }}>{portion(r.revenue)}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={{ flexDirection: "row", marginTop: size.gap + 4, alignSelf: pointer ? "flex-start" : "stretch" }}>
        <Button
          label={donut() ? "Show as pie" : "Show as donut"}
          variant="secondary"
          size={size.switch}
          flex={pointer ? undefined : 1}
          onPress={() => {
            donut.set(!donut());
            hover.set(null);
          }}
        />
      </View>
    </Card>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
/** Sales per month, in thousands, online and in store. */
const SALES = [
  [42, 31],
  [51, 28],
  [48, 36],
  [63, 33],
  [58, 40],
  [71, 38],
  [66, 44],
].map(([online, store], i) => ({ month: MONTHS[i], online, store }));
type Sale = (typeof SALES)[number];
/** The top of the y scale: a step above the highest grid line, room for
 * the labels over the stacks. */
const SALES_TOP = 130;
const SALES_HEIGHT = 168;
/** The width of the y axis' labels. */
const AXIS = 28;

/**
 * Sales per month as bars in bands, side by side or stacked, growing in
 * one after another, a value over each (the total over a stack), the month
 * under the pointer a faint band over its bars while the others fade.
 */
function Sales() {
  const mode = signal<"grouped" | "stacked">("grouped");
  const hover = signal<number | null>(null);
  const stacked = () => mode() === "stacked";
  const shown = () => SALES[hover() ?? SALES.length - 1];
  const total = (d: Sale) => d.online + d.store;
  // Upright bars, their tips rounded; a stack only at its top.
  const tip = { topLeft: 3, topRight: 3 };
  const labelStyle = { fontSize: 10.5, fontFamily: mono, paddingBottom: 3, color: colors.muted, fontVariant: ["tabular-nums" as const] };
  return (
    <Card icon="stocks" title="Sales" subtitle="Bars per month, side by side or stacked">
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={{ fontSize: 22, fontWeight: "600", letterSpacing: -0.4, color: colors.text, fontVariant: ["tabular-nums"] }}>{`${total(shown())}k`}</Text>
        <Text style={{ fontSize: 12, color: colors.muted }}>{hover() == null ? `${shown().month}, the last month` : shown().month}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8 }}>
        <Legend color={toneColor("accent")} label="Online" value={`${shown().online}k`} />
        <Legend color={toneColor("info")} label="In store" value={`${shown().store}k`} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: size.gap }}>
        <Plot
          data={SALES}
          // Bands with half their gap at the ends: their middles divide
          // the width evenly, under the month labels' equal cells.
          xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.15, maxBandWidth: 56, groupPadding: 0.12 }}
          yScale={{ type: "linear", domain: [0, SALES_TOP] }}
          appearGeneration={stacked() ? 1 : 0}
          motion={{ appear: { duration: 600, easing: "easeOut" }, enter: { duration: 150 }, exit: { duration: 150 }, pointer: { stiffness: 320, damping: 32 } }}
          accessibilityLabel={`Sales per month, online and in store, highest in ${SALES.reduce((a, b) => (total(b) > total(a) ? b : a)).month}`}
          accessibilityValue={{ text: hover() == null ? undefined : `${shown().month}, ${shown().online}k online, ${shown().store}k in store` }}
          // The band of the month under the pointer: a faint tint over it.
          crossLineClass="w-full h-full"
          crossLineStyle={{ backgroundColor: alpha(colors.text, 0.05) }}
          onHoverChange={(index) => hover.set(index)}
          focusStyle={focusRing(4)}
          style={{ flex: 1, height: SALES_HEIGHT }}
        >
          <Grid y={[40, 80, 120]} style={{ stroke: colors.line }} />
          <Grid y={[0]} style={{ stroke: colors.border }} />
          <Bar
            value="online"
            stack={stacked() ? "sales" : undefined}
            cornerRadii={stacked() ? 0 : tip}
            stagger={0.4}
            inactiveOpacity={0.45}
            label={stacked() ? undefined : "online"}
            labelStyle={labelStyle}
            style={{ fill: toneColor("accent") }}
          />
          <Bar
            value="store"
            stack={stacked() ? "sales" : undefined}
            cornerRadii={tip}
            stagger={0.4}
            inactiveOpacity={0.45}
            // Stacked, the top bar's label is the month's total.
            label={stacked() ? (d: Sale) => String(total(d)) : "store"}
            labelStyle={labelStyle}
            style={{ fill: toneColor("info") }}
          />
        </Plot>
        {/* The y axis' labels at the grid's values. */}
        <View style={{ width: AXIS, height: SALES_HEIGHT }}>
          {[0, 40, 80, 120].map((v) => (
            <Text style={{ ...axis, position: "absolute", right: 0, top: (1 - v / SALES_TOP) * SALES_HEIGHT - 7 }}>{String(v)}</Text>
          ))}
        </View>
      </View>
      {/* A month under each band: equal cells, as the bands' middles. */}
      <View style={{ flexDirection: "row", marginTop: 8, marginRight: AXIS + 8 }}>
        {MONTHS.map((m) => (
          <Text style={{ ...axis, flex: 1, textAlign: "center" }}>{m}</Text>
        ))}
      </View>
      <View style={{ marginTop: size.gap + 4, alignSelf: pointer ? "flex-start" : "stretch", width: pointer ? 220 : undefined }}>
        <Segmented
          options={[
            { value: "grouped", label: "Side by side" },
            { value: "stacked", label: "Stacked" },
          ]}
          value={mode()}
          size={size.switch}
          onChange={(next) => mode.set(next)}
        />
      </View>
    </Card>
  );
}

/**
 * Charts: what an app builds from `nsh/base/plot`'s parts and its own
 * views, with no chart component in between. A live price streamed a tick
 * a second, its newest point breathing and tagged in the gutter; an order
 * book's depth as steps either side of the spread, the side under the
 * pointer read out; a portfolio's value over its underwater plot, the
 * worst run shaded and the hovered day marked on both; capacity rings that
 * sweep in for each period; revenue as a donut whose hovered slice lifts;
 * and sales as bars side by side or stacked. Values on the axes are small
 * monospaced figures, grids hairlines, tooltips floating cards with a caps
 * title.
 */
export function Charts() {
  return <DemoPage cards={[Live, Depth, Drawdown, Capacity, Revenue, Sales]} />;
}
