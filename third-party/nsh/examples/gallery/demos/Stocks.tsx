import { Canvas, cleanup, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { createAnimatedValue, Easing, LayoutAnimation } from "nsh";
import { Icon } from "../icons";
import { nav } from "../nav";
import { Button, colors, desktop, finish, motion, paneWidth, Press, Segmented, TERMINAL_COLUMN, TERMINAL_GAP, TERMINAL_ROW, terminal } from "../ui";
import { Detail, StockView } from "./stocks/Detail";
import { createMarket, grouped, INDEX_BASE, ISSUES, type Market, percent, price, type Stock, sectors, signed, time, toneOf } from "./stocks/market";
import { alpha, calm, SpringBar } from "./stocks/parts";

type Filter = "all" | "gainers" | "losers" | "active";

/** Expanding and collapsing, reordering rows: one native layout animation. */
const relayout = {
  duration: 380,
  update: { type: "spring", springDamping: 0.84 },
  create: { type: "easeInEaseOut", property: "opacity" },
  delete: { type: "easeInEaseOut", property: "opacity" },
} as const;

/** A stock's details, pushed. */
const open = (market: Market, stock: Stock) => nav.push({ name: "page", page: () => <Detail market={market} stock={stock} /> });

/** A sector's mean change as a bar diverging from the middle. */
function SectorBar(props: { label: string; change: () => number; scale: () => number }) {
  const share = () => Math.min(1, Math.abs(props.change()) / props.scale());
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: terminal ? TERMINAL_ROW : 22 }}>
      <Text style={{ numberOfLines: 1, width: terminal ? 96 : 84, fontSize: 13, color: colors.muted }}>
        {props.label}
      </Text>
      <If when={!terminal} else={<View style={{ flex: 1 }} />}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
          <View style={{ flex: 1 }}>
            <SpringBar share={() => (props.change() < 0 ? share() : 0)} color={colors.down} from="right" height={8} radius={2} />
          </View>
          <View style={{ width: 1, height: 14, backgroundColor: colors.border }} />
          <View style={{ flex: 1 }}>
            <SpringBar share={() => (props.change() > 0 ? share() : 0)} color={colors.up} height={8} radius={2} />
          </View>
        </View>
      </If>
      <Text style={{ width: 56, textAlign: "right", fontSize: 12, fontVariant: ["tabular-nums"], color: toneOf(props.change()) }}>{signed(props.change())}%</Text>
    </View>
  );
}

/** Advancers vs decliners across the composite and the sectors' moves:
 * what the strip opens to. */
function Breadth(props: { market: Market }) {
  const b = () => props.market.breadth();
  const means = computed(() => {
    props.market.pulse();
    return untracked(() =>
      sectors.map((s) => {
        const members = props.market.stocks.filter((m) => m.sector === s.id);
        return members.reduce((sum, m) => sum + percent(m.quote()), 0) / members.length;
      }),
    );
  });
  const scale = () => Math.max(0.5, ...means().map(Math.abs)) * 1.1;
  return (
    <View style={terminal ? { paddingHorizontal: TERMINAL_COLUMN, paddingBottom: TERMINAL_ROW, gap: TERMINAL_ROW } : { paddingHorizontal: 16, paddingBottom: 14, gap: 10 }}>
      <View style={{ gap: terminal ? 0 : 6 }}>
        <If when={!terminal}>
          <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", gap: 2 }}>
            <View style={{ flex: b().up, backgroundColor: colors.up }} />
            <View style={{ flex: b().flat, backgroundColor: colors.faint }} />
            <View style={{ flex: b().down, backgroundColor: colors.down }} />
          </View>
        </If>
        <View style={{ flexDirection: "row" }}>
          <Text style={{ flex: 1, fontSize: 12, fontVariant: ["tabular-nums"], color: colors.up }}>{b().up} up</Text>
          <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"], color: colors.faint }}>
            {b().flat} flat · {ISSUES} issues
          </Text>
          <Text style={{ flex: 1, textAlign: "right", fontSize: 12, fontVariant: ["tabular-nums"], color: colors.down }}>{b().down} down</Text>
        </View>
      </View>
      <View style={{ gap: terminal ? 0 : 2 }}>
        <Each of={sectors}>{(s, i) => <SectorBar label={s().label} change={() => means()[i()]} scale={scale} />}</Each>
      </View>
    </View>
  );
}

/**
 * The market in one line, on the 16 pt gutters: the composite and its
 * change, the clock, pause. A tap opens breadth and sectors (a layout
 * animation; the chevron turns natively). One row in the terminal, pause
 * a text button.
 */
function MarketStrip(props: { market: Market }) {
  const opened = signal(false);
  const turn = createAnimatedValue(0);
  const level = () => props.market.composite();
  const change = () => ((level() - INDEX_BASE) / INDEX_BASE) * 100;
  const running = () => props.market.running();
  const toggle = () => {
    LayoutAnimation.configureNext(relayout);
    opened.set(!opened());
    turn.spring(opened() ? 1 : 0, motion.settle);
  };
  const height = terminal ? TERMINAL_ROW : 56;
  const pause = () => (running() ? props.market.stop() : props.market.start());
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: terminal ? TERMINAL_GAP : 12, paddingHorizontal: terminal ? TERMINAL_COLUMN : 16, height }}>
        <View
          onPress={toggle}
          role="button"
          accessibilityLabel={opened() ? "Hide breadth" : "Show breadth"}
          hoverStyle={{ opacity: 0.72 }}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: terminal ? TERMINAL_COLUMN : 8, height, transitionProperty: "opacity", transitionDuration: 120 }}
        >
          <Text style={{ numberOfLines: 1, fontSize: 13, color: colors.muted }}>
            Composite
          </Text>
          <Text style={{ numberOfLines: 1, fontSize: 15, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>
            {grouped(level())}
          </Text>
          <Text style={{ fontSize: 13, fontWeight: "500", color: toneOf(change()), fontVariant: ["tabular-nums"] }}>{signed(change())}%</Text>
          <If when={!terminal}>
            <View style={{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["90deg", "-90deg"] }) }}>
              <Icon name="chevron" size={12} tint={colors.faint} />
            </View>
          </If>
        </View>
        <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{time(props.market.clock())}</Text>
        <If
          when={!terminal}
          else={<Button label={running() ? "Pause" : "Resume"} accessibilityLabel={running() ? "Pause the market" : "Resume the market"} variant="secondary" onPress={pause} />}
        >
          <Press
            onPress={pause}
            hitSlop={6}
            accessibilityLabel={running() ? "Pause the market" : "Resume the market"}
            hoverStyle={running() ? finish.hover : { opacity: 0.94 }}
            style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, ...(running() ? finish.pill : finish.accent) }}
          >
            <Icon name={running() ? "pause" : "play"} size={13} tint={running() ? colors.muted : colors.onAccent} />
          </Press>
        </If>
      </View>
      <If when={opened()}>
        <Breadth market={props.market} />
      </If>
    </View>
  );
}

/** Points a sparkline draws: few enough for a calm, readable curve. */
const SPARK_POINTS = 24;
/** Minutes each sparkline point averages over. */
const SPARK_SMOOTH = 4;
/** The newest point's ring at its widest: the canvas reaches this far past
 * the plot on every side, so the ring is never clipped. */
const RING = 10;
/** The plot's size. */
const SPARK_W = 104;
const SPARK_H = 38;
/** The shortest time between two pulses of a row (ms): each one completes. */
const PULSE_GAP = 600;

/**
 * Today in 104 × 38 pt: a smooth line through a moving average of the
 * minutes' closes ending at the live price, a soft fill under it that
 * fades in from the left and down from the line, the previous close dotted
 * and a dot at the newest point that rings natively on each change. The y
 * range eases instead of jumping.
 */
function Sparkline(props: { stock: Stock }) {
  const scale = calm(0.1);
  const ring = createAnimatedValue(1);
  const ringRadius = ring.interpolate({ inputRange: [0, 1], outputRange: [3, RING] });
  const haloAlpha = ring.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });
  const strokeAlpha = ring.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });
  let seen = untracked(() => props.stock.quote().changedAt);
  let fired = -Infinity;
  effect(() => {
    const q = props.stock.quote();
    if (q.changedAt === seen) return;
    seen = q.changedAt;
    // A pulse at most every 600 ms, so each one plays out.
    const now = performance.now();
    if (now - fired < PULSE_GAP) return;
    fired = now;
    ring.set(0);
    ring.timing(1, { duration: 700, easing: Easing.out(Easing.cubic) });
  });
  const ys: number[] = [];
  return (
    <Canvas
      style={{ pointerEvents: "none", width: SPARK_W + RING * 2, height: SPARK_H + RING * 2, margin: -RING }}
      draw={(cx, { width, height }) => {
        const minutes = props.stock.minutes();
        const q = props.stock.quote();
        // Each point: the mean close of the minutes before it; the newest
        // point is the last trade.
        const n = Math.min(SPARK_POINTS, minutes.length);
        ys.length = n;
        for (let k = 0; k < n; k++) {
          const end = Math.round((k / Math.max(1, n - 1)) * (minutes.length - 1));
          const start = Math.max(0, end - SPARK_SMOOTH + 1);
          let sum = 0;
          for (let i = start; i <= end; i++) sum += minutes[i].c;
          ys[k] = sum / (end - start + 1);
        }
        ys[n - 1] = q.last;
        let lo = q.prevClose, hi = q.prevClose;
        for (const v of ys) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        const r = scale.fit(lo, hi);
        const left = RING, right = width - RING, bottom = height - RING;
        const Y = (v: number) => RING + 2 + ((r.hi - v) / (r.hi - r.lo || 1)) * (bottom - RING - 4);
        const X = (k: number) => left + (k / Math.max(1, n - 1)) * (right - left);
        const tone = toneOf(q.last - q.prevClose);
        // A smooth curve: quadratic segments through the midpoints.
        const curve = () => {
          cx.moveTo(X(0), Y(ys[0]));
          for (let k = 1; k < n - 1; k++) {
            cx.quadraticCurveTo(X(k), Y(ys[k]), (X(k) + X(k + 1)) / 2, (Y(ys[k]) + Y(ys[k + 1])) / 2);
          }
          cx.lineTo(X(n - 1), Y(ys[n - 1]));
        };

        // The fill: down from the line's top, strictly under the curve...
        let top = bottom;
        for (const v of ys) top = Math.min(top, Y(v));
        const fill = cx.createLinearGradient(0, top, 0, bottom);
        fill.addColorStop(0, alpha(tone, 0.22));
        fill.addColorStop(1, alpha(tone, 0));
        cx.beginPath();
        curve();
        cx.lineTo(X(n - 1), bottom);
        cx.lineTo(X(0), bottom);
        cx.closePath();
        cx.fillStyle = fill;
        cx.fill();
        // ...and faded in over the first fifth (erased, not overdrawn).
        const fadeTo = left + (right - left) * 0.2;
        const fade = cx.createLinearGradient(left, 0, fadeTo, 0);
        fade.addColorStop(0, "rgba(0,0,0,1)");
        fade.addColorStop(1, "rgba(0,0,0,0)");
        cx.globalCompositeOperation = "destination-out";
        cx.fillStyle = fade;
        cx.fillRect(0, 0, fadeTo, height);
        cx.globalCompositeOperation = "source-over";

        // The previous close, dotted.
        cx.strokeStyle = alpha(colors.muted, 0.4);
        cx.lineWidth = 1;
        cx.setLineDash([1, 3]);
        cx.beginPath();
        cx.moveTo(left, Y(q.prevClose));
        cx.lineTo(right, Y(q.prevClose));
        cx.stroke();
        cx.setLineDash([]);

        cx.beginPath();
        curve();
        cx.strokeStyle = tone;
        cx.lineWidth = 1.75;
        cx.lineJoin = "round";
        cx.lineCap = "round";
        cx.stroke();

        // The newest point and its pulse: a soft halo and a ring that grow
        // and fade natively (the canvas has room for them on every side).
        const x = X(n - 1), y = Y(ys[n - 1]);
        cx.fillStyle = tone;
        cx.strokeStyle = tone;
        cx.globalAlpha = haloAlpha;
        cx.beginPath();
        cx.arc(x, y, ringRadius, 0, Math.PI * 2);
        cx.fill();
        cx.globalAlpha = strokeAlpha;
        cx.lineWidth = 1.5;
        cx.beginPath();
        cx.arc(x, y, ringRadius, 0, Math.PI * 2);
        cx.stroke();
        cx.globalAlpha = 1;
        cx.beginPath();
        cx.arc(x, y, 3, 0, Math.PI * 2);
        cx.fill();
      }}
    />
  );
}

/** A watchlist row: code and name, today's sparkline, the price and its
 * change, plain text on a flat row. In the desktop layout the row shown
 * beside the list is `active`, and the others light up under the pointer. */
function StockRow(props: { market: Market; stock: Stock; first: boolean; onPress: () => void; wide?: boolean; active?: boolean }) {
  const q = () => props.stock.quote();
  const change = () => percent(q());
  return (
    <View
      onPress={props.onPress}
      activeStyle={{ backgroundColor: colors.surface }}
      role="button"
      accessibilityLabel={props.stock.name}
      accessibilityState={props.wide ? { selected: !!props.active } : undefined}
      class={props.wide ? (props.active ? "bg-accent" : "hover:bg-card") : undefined}
      style={{ height: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, cursor: props.wide ? "pointer" : undefined }}
    >
      <If when={props.active}>
        <View style={{ position: "absolute", top: 14, bottom: 14, left: 0, width: 3, borderRadius: 1.5, backgroundColor: colors.accent }} />
      </If>
      <If when={!props.first}>
        <View style={{ position: "absolute", top: 0, left: 16, right: 0, height: 1, backgroundColor: colors.line }} />
      </If>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ numberOfLines: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>
          {props.stock.code}
        </Text>
        <Text style={{ numberOfLines: 1, fontSize: 13, color: colors.muted }}>
          {props.stock.name}
        </Text>
      </View>
      <Sparkline stock={props.stock} />
      <View style={{ width: 84, alignItems: "flex-end", gap: 3 }}>
        <Text style={{ numberOfLines: 1, fontSize: 16, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>
          {price(q().last, props.stock)}
        </Text>
        <Text style={{ numberOfLines: 1, fontSize: 13, fontWeight: "500", color: toneOf(change()), fontVariant: ["tabular-nums"] }}>
          {signed(change())}%
        </Text>
      </View>
    </View>
  );
}

/** A watchlist row in the terminal, on one row: code, name, price and
 * change in columns, the prices and changes right-aligned. */
function TerminalStockRow(props: { stock: Stock; onPress: () => void; wide?: boolean; active?: boolean }) {
  const q = () => props.stock.quote();
  const change = () => percent(q());
  return (
    <View
      onPress={props.onPress}
      role="button"
      accessibilityLabel={props.stock.name}
      accessibilityState={props.wide ? { selected: !!props.active } : undefined}
      style={{ height: TERMINAL_ROW, flexDirection: "row", alignItems: "center", gap: TERMINAL_GAP, paddingHorizontal: TERMINAL_COLUMN }}
    >
      <Text style={{ numberOfLines: 1, width: 4 * TERMINAL_COLUMN, fontSize: 16, fontWeight: "600", color: colors.text }}>
        {props.stock.code}
      </Text>
      <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, color: colors.muted }}>
        {props.stock.name}
      </Text>
      <Text style={{ numberOfLines: 1, width: 9 * TERMINAL_COLUMN, textAlign: "right", fontSize: 16, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>
        {price(q().last, props.stock)}
      </Text>
      <Text style={{ numberOfLines: 1, width: 7 * TERMINAL_COLUMN, textAlign: "right", fontSize: 13, fontWeight: "500", color: toneOf(change()), fontVariant: ["tabular-nums"] }}>
        {signed(change())}%
      </Text>
    </View>
  );
}

/** The watchlist's width beside the stock in the desktop layout. */
const WATCHLIST = 380;
/** The least a terminal's stock keeps beside the watchlist: with less, the
 * watchlist is the page and a stock is pushed over it, as on a phone. */
const TERMINAL_DETAIL = 48 * TERMINAL_COLUMN;

/** The watchlist: quotes that change every 50 ms under a one-line market
 * strip; sorted filters re-sort once a second with a layout animation. A
 * stock opens its details, pushed on phones and narrow terminals, beside
 * the list on desktops; leaving the demo stops the market. */
export function Stocks() {
  const wide = computed(() => desktop() && !(terminal && paneWidth() < WATCHLIST + TERMINAL_DETAIL));
  const market = createMarket();
  market.start();
  cleanup(() => market.stop());
  const stocks = market.stocks;
  const filter = signal<Filter>("all");
  const ordered = (f: Filter) => {
    const change = (s: Stock) => percent(s.quote());
    if (f === "all") return stocks;
    if (f === "gainers") return stocks.filter((s) => change(s) > 0).sort((a, b) => change(b) - change(a));
    if (f === "losers") return stocks.filter((s) => change(s) < 0).sort((a, b) => change(a) - change(b));
    return [...stocks].sort((a, b) => b.quote().turnover - a.quote().turnover).slice(0, 10);
  };
  const rows = signal<Stock[]>(stocks);
  effect(() => {
    const f = filter();
    market.pulse();
    untracked(() => {
      const next = ordered(f);
      const now = rows();
      if (next.length === now.length && next.every((s, i) => s === now[i])) return;
      LayoutAnimation.configureNext(relayout);
      rows.set(next);
    });
  });
  const counts = computed(() => {
    market.pulse();
    let up = 0, down = 0;
    for (const c of untracked(() => stocks.map((m) => percent(m.quote())))) {
      if (c > 0) up++;
      else if (c < 0) down++;
    }
    return { up, down };
  });
  // Stable options (the segments stay mounted); the counts are getters, so
  // the control tracks the once-a-second counts.
  const options = [
    { value: "all" as const, label: "All", count: stocks.length },
    {
      value: "gainers" as const,
      label: "Gainers",
      get count() {
        return counts().up;
      },
    },
    {
      value: "losers" as const,
      label: "Losers",
      get count() {
        return counts().down;
      },
    },
    { value: "active" as const, label: "Active" },
  ];
  const stats = () => market.stats();
  // Desktop: the stock beside the list.
  const shown = signal<Stock>(stocks[0]);
  const watchlist = () => (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <MarketStrip market={market} />
      <View style={terminal ? { paddingHorizontal: TERMINAL_COLUMN, paddingBottom: TERMINAL_ROW } : { paddingHorizontal: 16, paddingBottom: 6 }}>
        <Segmented options={options} value={filter()} onChange={(f) => filter.set(f)} size="small" />
      </View>
      <Scroll style={{ flex: 1 }}>
        <View>
          <Each of={rows()}>
            {(stock, i) =>
              terminal ? (
                <TerminalStockRow
                  stock={stock()}
                  onPress={() => (wide() ? shown.set(stock()) : open(market, stock()))}
                  wide={wide()}
                  active={wide() && shown() === stock()}
                />
              ) : (
                <StockRow
                  market={market}
                  stock={stock()}
                  first={i() === 0}
                  onPress={() => (wide() ? shown.set(stock()) : open(market, stock()))}
                  wide={wide()}
                  active={wide() && shown() === stock()}
                />
              )
            }
          </Each>
          <If when={!rows().length}>
            <Text style={{ paddingVertical: 32, textAlign: "center", fontSize: 14, color: colors.muted }}>Nothing here right now</Text>
          </If>
        </View>
        <Text style={{ paddingHorizontal: terminal ? TERMINAL_COLUMN : 16, paddingTop: 16, paddingBottom: terminal ? TERMINAL_ROW : 40, fontSize: 12, lineHeight: 17, color: colors.faint, fontVariant: ["tabular-nums"] }}>
          Simulated, fictional companies · tick 50 ms · {stats().ms.toFixed(2)} ms JS/tick · {stats().updates} quotes/s
        </Text>
      </Scroll>
    </View>
  );
  if (!desktop()) return watchlist();
  // The book and the tape go beside the chart when the stock has the room.
  const split = computed(() => paneWidth() - WATCHLIST >= 860);
  // A terminal that narrows past the room for both keeps the list alone.
  return (
    <View style={{ flex: 1 }}>
      {wide() ? (
        <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
          <View style={{ width: WATCHLIST, borderRightWidth: 1, borderRightColor: colors.line }}>{watchlist()}</View>
          <View style={{ flex: 1 }}>
            {(() => {
              const stock = shown();
              return <StockView market={market} stock={stock} wide split={split} />;
            })()}
          </View>
        </View>
      ) : (
        watchlist()
      )}
    </View>
  );
}
