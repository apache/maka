import { Canvas, computed, effect, signal, Text, untracked, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { colors, Legend, tints } from "../../ui";
import { BLOCK, buckets, compact, type Market, price, type Stock, type Trade, time } from "./market";
import { Block, grid, Head, SpringBar } from "./parts";

const SHOWN = 8;

const ROW = 28;
/** Trades the canvas holds: the rows shown and four more that slide out. */
const HELD = SHOWN + 4;

/**
 * The tape: the newest trades on top, blocks highlighted. It is one canvas
 * redrawn four times a second; the new rows slide in by a native offset
 * (the canvas redraws itself as the value moves, without JS).
 */
export function Tape(props: { market: Market; stock: Stock }) {
  const shown = signal<Trade[]>([]);
  const offset = createAnimatedValue(0);
  let top = -1;
  // Four times a second: what came in since, and the slide that shows it.
  effect(() => {
    if (props.market.ticks() % 5) return;
    untracked(() => {
      const trades = props.market.trades();
      const fresh = top < 0 ? 0 : trades.findIndex((t) => t.id <= top);
      top = trades[0]?.id ?? top;
      shown.set(trades.slice(0, HELD));
      const k = fresh < 0 ? HELD : Math.min(4, fresh);
      if (k) {
        offset.set(-k * ROW);
        offset.timing(0, { duration: 220, easing: Easing.out(Easing.cubic) });
      }
    });
  });
  const stats = computed(() => {
    let buys = 0, sells = 0, blocks = 0;
    for (const t of props.market.trades()) {
      if (t.side > 0) buys += t.size;
      else sells += t.size;
      if (t.size >= BLOCK) blocks++;
    }
    return { buys, sells, blocks };
  });
  return (
    <Block title="Time & sales" note={`blocks ≥ ${compact(BLOCK)}`}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 6 }}>
        <Legend color={colors.up} label="At ask" value={compact(stats().buys)} />
        <Legend color={colors.down} label="At bid" value={compact(stats().sells)} />
        <Legend color={colors.accent} label="Blocks" value={`${stats().blocks}`} />
      </View>
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 8 }}>
        <Head label="TIME" width={80} />
        <Head label="PRICE" flex={1} />
        <Head label="SIZE" align="right" />
      </View>
      <Canvas
        style={{ height: SHOWN * ROW }}
        accessibilityLabel="Recent trades"
        draw={(cx, { width, height }) => {
          const trades = shown();
          cx.save();
          cx.beginPath();
          cx.rect(0, 0, width, height);
          cx.clip();
          cx.translate(0, offset);
          cx.textBaseline = "middle";
          trades.forEach((t, i) => {
            const y = i * ROW + ROW / 2;
            const block = t.size >= BLOCK;
            const color = t.side > 0 ? colors.up : colors.down;
            if (block) {
              cx.fillStyle = tints.accent;
              cx.beginPath();
              cx.roundRect(0, i * ROW + 2, width, ROW - 4, 8);
              cx.fill();
            } else if (i) {
              cx.strokeStyle = grid();
              cx.lineWidth = 1;
              cx.beginPath();
              cx.moveTo(0, i * ROW);
              cx.lineTo(width, i * ROW);
              cx.stroke();
            }
            cx.font = "12px system-ui";
            cx.textAlign = "left";
            cx.fillStyle = colors.faint;
            cx.fillText(time(t.t), 8, y);
            cx.fillStyle = color;
            cx.beginPath();
            cx.arc(84, y, 3, 0, Math.PI * 2);
            cx.fill();
            cx.font = "14px system-ui";
            cx.fillText(price(t.price, props.stock), 96, y);
            cx.textAlign = "right";
            cx.font = block ? "600 14px system-ui" : "14px system-ui";
            cx.fillStyle = block ? colors.accent : colors.text;
            cx.fillText(compact(t.size), width - 8, y);
            if (block) {
              cx.font = "600 10px system-ui";
              cx.fillText("BLOCK", width - 70, y);
            }
          });
          cx.restore();
        }}
      />
    </Block>
  );
}

/** One bucket: sold to the left of the middle, bought to the right. */
function FlowRow(props: { label: string; note: string; buy: () => number; sell: () => number; max: () => number }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
          {props.label}
          <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}> {props.note}</Text>
        </Text>
        <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"], color: colors.down }}>{compact(props.sell())}</Text>
        <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"], color: colors.faint }}>/</Text>
        <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"], color: colors.up }}>{compact(props.buy())}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <SpringBar share={() => props.sell() / props.max()} color={colors.down} from="right" height={10} radius={3} />
        </View>
        <View style={{ width: 2, height: 18, marginHorizontal: 2, borderRadius: 1, backgroundColor: colors.border }} />
        <View style={{ flex: 1 }}>
          <SpringBar share={() => props.buy() / props.max()} color={colors.up} height={10} radius={3} />
        </View>
      </View>
    </View>
  );
}

/** Bought vs sold volume by order size: who is moving the price. */
export function Flow(props: { market: Market }) {
  const flow = () => props.market.flow();
  const max = () => Math.max(1, ...flow().buy, ...flow().sell);
  const net = () => flow().buy.reduce((s, v) => s + v, 0) - flow().sell.reduce((s, v) => s + v, 0);
  const big = () => flow().buy[2] + flow().buy[3] - flow().sell[2] - flow().sell[3];
  return (
    <Block title="Trade flow" note="sold ← · → bought">
      <Text style={{ fontSize: 22, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>
        {net() >= 0 ? "+" : ""}
        {compact(net())}
        <Text style={{ fontSize: 13, fontWeight: "400", fontVariant: ["tabular-nums"], color: big() >= 0 ? colors.up : colors.down }}>
          {" "}
          net · {big() >= 0 ? "+" : ""}
          {compact(big())} large orders
        </Text>
      </Text>
      <View style={{ gap: 10 }}>
        <Each of={buckets}>
          {(b, i) => <FlowRow label={b().label} note={b().note} buy={() => flow().buy[i()]} sell={() => flow().sell[i()]} max={max} />}
        </Each>
      </View>
    </Block>
  );
}
