import { Canvas, computed, effect, signal, Text, untracked, View } from "nsh";
import { LayoutAnimation } from "nsh";
import { colors, Legend, Press, radius } from "../../ui";
import { compact, type Level, LEVELS, type Market, price, type Stock, toneOf } from "./market";
import { alpha, Block, calm, grid, Head, hatch, SpringBar } from "./parts";

const ROW = 26;
/** Ticks either side of the mid price the depth chart spans. */
const SPAN = LEVELS + 2;

/** Sizes summed outward from the best price. */
function cumulative(levels: Level[]) {
  let sum = 0;
  return levels.map((l) => (sum += l.size));
}

/**
 * Cumulative depth: bids stepping down to the left, asks to the right, the
 * spread hatched and the mid price dashed. It is calm on purpose: it redraws
 * four times a second, the price axis is a fixed span around the mid, and
 * the size axis widens at once but narrows over about a second.
 */
export function Depth(props: { market: Market; stock: Stock }) {
  const frame = signal(0, { equals: false });
  effect(() => {
    if (props.market.ticks() % 5 === 0) frame.set(0);
  });
  const book = () => {
    frame();
    return untracked(() => props.market.book());
  };
  const totals = computed(() => {
    const b = book();
    const bids = b.bids.reduce((s, l) => s + l.size, 0), asks = b.asks.reduce((s, l) => s + l.size, 0);
    return { bids, asks, imbalance: bids + asks ? (bids - asks) / (bids + asks) : 0 };
  });
  const top = calm(0.25);
  return (
    <Block title="Depth" note={`±${SPAN} ticks · cumulative`}>
      <Canvas
        style={{ height: 120 }}
        accessibilityLabel="Depth chart"
        draw={(cx, { width, height }) => {
          const b = book();
          if (!b.bids.length) return;
          const bids = cumulative(b.bids), asks = cumulative(b.asks);
          const tick = props.stock.tick;
          const mid = (b.bids[0].price + b.asks[0].price) / 2;
          const lo = mid - SPAN * tick, hi = mid + SPAN * tick;
          const ymax = top.fit(0, Math.max(bids[bids.length - 1], asks[asks.length - 1]) * 1.1).hi;
          const pad = { top: 4, bottom: 18 };
          const h = height - pad.top - pad.bottom;
          const X = (p: number) => ((p - lo) / (hi - lo)) * width;
          const Y = (v: number) => pad.top + h - (v / ymax) * h;
          cx.strokeStyle = grid();
          cx.lineWidth = 1;
          for (let k = 1; k <= 3; k++) {
            cx.beginPath();
            cx.moveTo(0, pad.top + (h * k) / 4);
            cx.lineTo(width, pad.top + (h * k) / 4);
            cx.stroke();
          }
          const bx = X(b.bids[0].price), ax = X(b.asks[0].price);
          hatch(cx, bx, pad.top, ax - bx, h, colors.border, 4);
          // A side: a step line out from the best price, filled below.
          const side = (levels: Level[], sums: number[], color: string, dir: number) => {
            cx.beginPath();
            cx.moveTo(X(levels[0].price), pad.top + h);
            let y = Y(sums[0]);
            cx.lineTo(X(levels[0].price), y);
            for (let i = 1; i < levels.length; i++) {
              cx.lineTo(X(levels[i].price), y);
              y = Y(sums[i]);
              cx.lineTo(X(levels[i].price), y);
            }
            cx.lineTo(dir < 0 ? 0 : width, y);
            cx.lineTo(dir < 0 ? 0 : width, pad.top + h);
            cx.closePath();
            cx.fillStyle = alpha(color, 0.16);
            cx.fill();
            cx.strokeStyle = color;
            cx.lineWidth = 1.5;
            cx.stroke();
          };
          side(b.bids, bids, colors.up, -1);
          side(b.asks, asks, colors.down, 1);
          cx.strokeStyle = colors.muted;
          cx.setLineDash([2, 3]);
          cx.beginPath();
          cx.moveTo(X(mid), pad.top);
          cx.lineTo(X(mid), pad.top + h);
          cx.stroke();
          cx.setLineDash([]);
          cx.font = "11px system-ui";
          cx.fillStyle = colors.faint;
          cx.textBaseline = "top";
          cx.textAlign = "left";
          cx.fillText(price(lo, props.stock), 0, pad.top + h + 5);
          cx.textAlign = "right";
          cx.fillText(price(hi, props.stock), width, pad.top + h + 5);
          cx.textAlign = "center";
          cx.fillStyle = colors.text;
          cx.fillText(`mid ${price(mid, props.stock)}`, width / 2, pad.top + h + 5);
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 6 }}>
        <Legend color={colors.up} label="Bids" value={compact(totals().bids)} />
        <Legend color={colors.down} label="Asks" value={compact(totals().asks)} />
        <Legend color={colors.border} label="Imbalance" value={`${totals().imbalance >= 0 ? "+" : ""}${(totals().imbalance * 100).toFixed(0)}%`} />
      </View>
    </Block>
  );
}

/** One level: its label, price, size and running total, over a bar of
 * the running total from the right edge (a depth ladder). */
function LevelRow(props: { stock: Stock; level: () => Level | undefined; total: () => number; side: "bid" | "ask"; n: number; max: () => number }) {
  const tint = () => alpha(props.side === "bid" ? colors.up : colors.down, 0.1);
  const share = () => Math.min(1, props.total() / props.max());
  return (
    <View style={{ height: ROW, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View style={{ position: "absolute", right: 0, top: 1, bottom: 1, width: `${share() * 100}%`, backgroundColor: tint() }} />
      <Text style={{ width: 28, fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>
        {props.side === "bid" ? "B" : "A"}
        {props.n}
      </Text>
      <Text style={{ flex: 1, fontSize: 14, color: toneOf((props.level()?.price ?? 0) - props.stock.quote().prevClose), fontVariant: ["tabular-nums"] }}>
        {props.level() ? price(props.level()!.price, props.stock) : "–"}
      </Text>
      <Text style={{ width: 64, textAlign: "right", fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] }}>
        {props.level() ? compact(props.level()!.size) : ""}
      </Text>
      <Text style={{ width: 64, paddingRight: 6, textAlign: "right", fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{compact(props.total())}</Text>
    </View>
  );
}

/**
 * Asks above bids, five levels or ten (the change animates the layout),
 * the bid / ask balance springing natively on top.
 */
export function OrderBook(props: { market: Market; stock: Stock }) {
  const depth = signal(5);
  const book = () => props.market.book();
  const shown = computed(() => Array.from({ length: depth() }, (_, i) => i));
  const sums = computed(() => ({ bids: cumulative(book().bids), asks: cumulative(book().asks) }), { equals: false });
  // The bars' scale: the deeper side's total, eased like the depth chart's
  // (it runs every tick).
  const scale = calm(0.05);
  const max = computed(() => {
    const s = sums(), n = depth() - 1;
    return scale.fit(0, Math.max(1, s.bids[n] ?? 0, s.asks[n] ?? 0)).hi;
  });
  const share = () => {
    const s = sums(), n = depth() - 1;
    const bids = s.bids[n] ?? 0, asks = s.asks[n] ?? 0;
    return bids + asks ? bids / (bids + asks) : 0.5;
  };
  const spread = () => {
    const b = book();
    return b.asks[0] && b.bids[0] ? b.asks[0].price - b.bids[0].price : 0;
  };
  const toggle = () => {
    LayoutAnimation.configureNext({
      duration: 360,
      update: { type: "spring", springDamping: 0.85 },
      create: { type: "easeInEaseOut", property: "opacity" },
      delete: { type: "easeInEaseOut", property: "opacity" },
    });
    depth.set(depth() === 5 ? LEVELS : 5);
  };
  return (
    <Block
      title="Order book"
      right={
        <Press onPress={toggle} hitSlop={8} accessibilityLabel={depth() === 5 ? "Show ten levels" : "Show five levels"}>
          <View style={{ height: 30, paddingHorizontal: 12, borderRadius: radius.control, justifyContent: "center", backgroundColor: colors.raised }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{depth() === 5 ? "5 → 10" : "10 → 5"}</Text>
          </View>
        </Press>
      }
    >
      <View style={{ gap: 5 }}>
        <View style={{ height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.down }}>
          <SpringBar share={share} color={colors.up} height={6} radius={0} />
        </View>
        <View style={{ flexDirection: "row" }}>
          <Text style={{ flex: 1, fontSize: 12, color: colors.up, fontVariant: ["tabular-nums"] }}>BID {(share() * 100).toFixed(0)}%</Text>
          <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>spread {price(spread(), props.stock)}</Text>
          <Text style={{ flex: 1, textAlign: "right", fontSize: 12, color: colors.down, fontVariant: ["tabular-nums"] }}>{((1 - share()) * 100).toFixed(0)}% ASK</Text>
        </View>
      </View>
      <View>
        <View style={{ flexDirection: "row", gap: 10, paddingBottom: 4 }}>
          <Head label="LVL" width={28} />
          <Head label="PRICE" flex={1} />
          <Head label="SIZE" width={64} align="right" />
          <Head label="TOTAL" width={64} align="right" />
        </View>
        <Each of={shown()}>
          {(i) => {
            const k = () => depth() - 1 - i();
            return <LevelRow stock={props.stock} level={() => book().asks[k()]} total={() => sums().asks[k()] ?? 0} side="ask" n={depth() - i()} max={max} />;
          }}
        </Each>
        <View style={{ height: 1, marginVertical: 3, backgroundColor: colors.border }} />
        <Each of={shown()}>
          {(i) => <LevelRow stock={props.stock} level={() => book().bids[i()]} total={() => sums().bids[i()] ?? 0} side="bid" n={i() + 1} max={max} />}
        </Each>
      </View>
    </Block>
  );
}
