import { Canvas, cleanup, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { Dialog, NavPage } from "nsh/base";
import { safeAreaInsets } from "nsh";
import { Icon } from "../../icons";
import { Button, colors, finish, header, PageHeader, Press, Sheet, Stat } from "../../ui";
import { Depth, OrderBook } from "./Book";
import { Chart } from "./Chart";
import { compact, type Market, percent, price, sectors, type Stock, signed, time, toneOf } from "./market";
import { Block, LiveDot } from "./parts";
import { Flow, Tape } from "./Tape";
import { createBanner, type Side, Ticket } from "./Ticket";

/**
 * Where the last price sits in the day, in one line: the low–high span
 * filled, the previous close marked, the last price a knob that springs
 * natively.
 */
function DayRange(props: { stock: Stock }) {
  const q = () => props.stock.quote();
  const x = createAnimatedValue(0);
  let width = 0;
  const span = () => {
    const lo = Math.min(q().low, q().prevClose), hi = Math.max(q().high, q().prevClose);
    return { lo, hi: hi > lo ? hi : lo + props.stock.tick };
  };
  const at = (v: number) => (v - span().lo) / (span().hi - span().lo);
  let placed = false;
  const place = () => {
    if (!width) return;
    const to = at(q().last) * width;
    if (placed) x.spring(to, { stiffness: 220, damping: 24 });
    else x.set(to);
    placed = true;
  };
  effect(() => {
    q();
    untracked(place);
  });
  const p = (v: number) => price(v, props.stock);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>L {p(q().low)}</Text>
      <View
        onLayout={(e) => {
          width = e.size.width;
          place();
        }}
        accessibilityLabel={`Day range ${p(q().low)} to ${p(q().high)}`}
        style={{ flex: 1, height: 16, justifyContent: "center" }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.raised }} />
        <View
          style={{
            position: "absolute",
            left: `${at(q().low) * 100}%`,
            width: `${(at(q().high) - at(q().low)) * 100}%`,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.border,
          }}
        />
        <View style={{ position: "absolute", left: `${at(q().prevClose) * 100}%`, width: 2, height: 12, marginLeft: -1, borderRadius: 1, backgroundColor: colors.muted }} />
        <View
          style={{
            position: "absolute",
            left: -7,
            width: 14,
            height: 14,
            borderRadius: 7,
            borderWidth: 3,
            borderColor: colors.background,
            backgroundColor: toneOf(q().last - q().prevClose),
            transform: [{ translateX: x }],
          }}
        />
      </View>
      <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>H {p(q().high)}</Text>
    </View>
  );
}

/** The quote: a big figure that flashes, a direction arrow that turns
 * natively, the day's range and figures. */
function Quote(props: { market: Market; stock: Stock }) {
  const q = () => props.stock.quote();
  const change = () => q().last - q().prevClose;
  // Price, arrow and change all follow the day's direction; the arrow
  // turns over natively when it flips.
  let down = change() < 0;
  const turn = createAnimatedValue(down ? 1 : 0);
  effect(() => {
    if (change() < 0 === down) return;
    down = !down;
    turn.spring(down ? 1 : 0, { stiffness: 300, damping: 18 });
  });
  const p = (v: number) => price(v, props.stock);
  const year = computed(() => {
    let lo = Infinity, hi = -Infinity;
    for (const d of props.stock.days) {
      lo = Math.min(lo, d.l);
      hi = Math.max(hi, d.h);
    }
    return { lo, hi };
  });
  const sector = sectors.find((s) => s.id === props.stock.sector)!.label;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, color: colors.muted }}>
          {props.stock.name}
        </Text>
        <Text style={{ fontSize: 13, color: colors.faint }}>{sector}</Text>
        <LiveDot running={() => props.market.running()} size={6} />
        <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>{time(props.market.clock())}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 36, fontWeight: "600", letterSpacing: -1, color: toneOf(change()), fontVariant: ["tabular-nums"] }}>{p(q().last)}</Text>
        <View style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) }] }}>
          <Icon name="arrow-up" size={20} tint={toneOf(change())} />
        </View>
        <View style={{ flex: 1, alignItems: "flex-end", gap: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"], color: toneOf(change()) }}>{signed(percent(q()))}%</Text>
          <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"], color: toneOf(change()) }}>{signed(change(), props.stock.tick < 0.01 ? 3 : 2)} today</Text>
        </View>
      </View>
      <DayRange stock={props.stock} />
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Stat width="25%" label="Open" value={p(q().open)} />
        <Stat width="25%" label="Prev close" value={p(q().prevClose)} />
        <Stat width="25%" label="Avg price" value={p(q().turnover / (q().volume || 1))} />
        <Stat width="25%" label="Amplitude" value={`${(((q().high - q().low) / q().prevClose) * 100).toFixed(2)}%`} />
        <Stat width="25%" label="Volume" value={compact(q().volume)} />
        <Stat width="25%" label="Turnover" value={compact(q().turnover)} />
        <Stat width="25%" label="120d high" value={p(year().hi)} />
        <Stat width="25%" label="120d low" value={p(year().lo)} />
      </View>
    </View>
  );
}

const horizons = [5, 20, 60, 120];

/**
 * Ranges over 5 to 120 days as dumbbells (low → high), the last price a
 * line across them and the previous close dashed.
 */
function Ranges(props: { market: Market; stock: Stock }) {
  const rows = computed(() => {
    props.market.pulse();
    const q = untracked(() => props.stock.quote());
    return horizons.map((n) => {
      let lo = q.low, hi = q.high;
      for (const d of props.stock.days.slice(-n)) {
        lo = Math.min(lo, d.l);
        hi = Math.max(hi, d.h);
      }
      return { n, lo, hi };
    });
  });
  return (
    <Block title="Ranges" note="low → high · each second">
      <Canvas
        style={{ height: horizons.length * 34 + 16 }}
        accessibilityLabel="Price ranges"
        draw={(cx, { width }) => {
          const r = rows();
          const q = untracked(() => props.stock.quote());
          const lo = Math.min(...r.map((x) => x.lo)), hi = Math.max(...r.map((x) => x.hi));
          const left = 40, right = 6;
          const X = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (width - left - right);
          cx.font = "11px system-ui";
          cx.textBaseline = "middle";
          r.forEach((row, i) => {
            const y = 10 + i * 34;
            cx.fillStyle = colors.muted;
            cx.textAlign = "left";
            cx.fillText(`${row.n}d`, 0, y);
            cx.strokeStyle = colors.border;
            cx.lineWidth = 3;
            cx.lineCap = "round";
            cx.beginPath();
            cx.moveTo(X(row.lo), y);
            cx.lineTo(X(row.hi), y);
            cx.stroke();
            for (const [v, c] of [[row.lo, colors.down], [row.hi, colors.up]] as const) {
              cx.fillStyle = c;
              cx.beginPath();
              cx.arc(X(v), y, 4.5, 0, Math.PI * 2);
              cx.fill();
            }
            cx.fillStyle = colors.faint;
            cx.textAlign = "left";
            cx.fillText(price(row.lo, props.stock), X(row.lo) - 4, y + 13);
            cx.textAlign = "right";
            cx.fillText(price(row.hi, props.stock), X(row.hi) + 4, y + 13);
          });
          const bottom = horizons.length * 34;
          cx.strokeStyle = colors.faint;
          cx.lineWidth = 1;
          cx.setLineDash([3, 4]);
          cx.beginPath();
          cx.moveTo(X(q.prevClose), 0);
          cx.lineTo(X(q.prevClose), bottom);
          cx.stroke();
          cx.setLineDash([]);
          cx.strokeStyle = colors.accent;
          cx.lineWidth = 2;
          cx.beginPath();
          cx.moveTo(X(q.last), 0);
          cx.lineTo(X(q.last), bottom);
          cx.stroke();
          cx.fillStyle = colors.accent;
          cx.textAlign = "center";
          cx.fillText(`last ${price(q.last, props.stock)}`, Math.max(left + 30, Math.min(width - 40, X(q.last))), bottom + 8);
        }}
      />
    </Block>
  );
}

/** Pauses and resumes the market. */
function PauseButton(props: { market: Market }) {
  return (
    <Press
      onPress={() => (props.market.running() ? props.market.stop() : props.market.start())}
      hitSlop={6}
      accessibilityLabel={props.market.running() ? "Pause the market" : "Resume the market"}
    >
      <View style={[{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" }, props.market.running() ? { ...finish.pill, borderWidth: 1 } : finish.accent]}>
        <Icon name={props.market.running() ? "pause" : "play"} size={13} tint={props.market.running() ? colors.muted : colors.onAccent} />
      </View>
    </Press>
  );
}

/** A stock, pushed: its view under a header with the pause button. */
export function Detail(props: { market: Market; stock: Stock }) {
  return (
    <NavPage
      title={props.stock.code}
      {...header}
      headerRight={<PauseButton market={props.market} />}
      header={<PageHeader title={props.stock.code} right={<PauseButton market={props.market} />} />}
    >
      <StockView market={props.market} stock={props.stock} />
    </NavPage>
  );
}

/**
 * A stock: quote and chart on the first screen, then the book, depth, the
 * tape, the flow and the ranges, all live. Buy / Sell at the bottom open
 * the order ticket in a sheet. `wide` (the desktop layout, beside the
 * watchlist, whose strip has the pause button) heads it with the code,
 * draws the chart taller and, while `split` holds, puts the book, the
 * tape, depth and flow in a column right of the quote, chart and ranges.
 */
export function StockView(props: { market: Market; stock: Stock; wide?: boolean; split?: () => boolean }) {
  props.market.focus(props.stock);
  cleanup(() => props.market.focus(null));
  const side = signal<Side>("buy");
  const ticket = signal(false);
  const banner = createBanner();
  const insets = safeAreaInsets();
  const trade = (s: Side) => {
    side.set(s);
    ticket.set(true);
  };
  const stats = () => props.market.stats();
  const footer = (
    <Text style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 96 + insets().bottom, fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>
      simulated · {stats().ms.toFixed(2)} ms JS/tick · {stats().updates} quotes/s
    </Text>
  );
  const split = () => props.split?.() ?? false;
  const ticketView = (
    <Ticket
      open={ticket}
      stock={props.stock}
      side={side}
      onSide={(s) => side.set(s)}
      onPlaced={(title, detail, s) => {
        ticket.set(false);
        banner.show(title, detail, s);
      }}
    />
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <If
        when={props.wide}
        else={
          <Scroll style={{ flex: 1 }}>
            <Quote market={props.market} stock={props.stock} />
            <Block>
              <Chart stock={props.stock} running={() => props.market.running()} />
            </Block>
            <OrderBook market={props.market} stock={props.stock} />
            <Tape market={props.market} stock={props.stock} />
            <Depth market={props.market} stock={props.stock} />
            <Flow market={props.market} />
            <Ranges market={props.market} stock={props.stock} />
            {footer}
          </Scroll>
        }
      >
        <Scroll style={{ flex: 1 }}>
          <Text style={{ paddingHorizontal: 16, paddingTop: 14, fontSize: 22, fontWeight: "700", letterSpacing: -0.3, color: colors.text }}>{props.stock.code}</Text>
          <View style={{ flexDirection: split() ? "row" : "column", alignItems: split() ? "flex-start" : "stretch" }}>
            <View style={{ flex: split() ? 1 : undefined, minWidth: 0 }}>
              <Quote market={props.market} stock={props.stock} />
              <Block>
                <Chart stock={props.stock} running={() => props.market.running()} height={340} />
              </Block>
              <Ranges market={props.market} stock={props.stock} />
            </View>
            <View style={{ width: split() ? 380 : undefined, borderLeftWidth: split() ? 1 : 0, borderLeftColor: colors.line }}>
              <OrderBook market={props.market} stock={props.stock} />
              <Tape market={props.market} stock={props.stock} />
              <Depth market={props.market} stock={props.stock} />
              <Flow market={props.market} />
            </View>
          </View>
          {footer}
        </Scroll>
      </If>
      {/* The trade bar, over the content. */}
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 10 + insets().bottom,
          // Glass: the page shows through, blurred, as it scrolls under.
          ...finish.glass,
          borderTopWidth: 1,
          borderTopColor: finish.glass.borderColor,
        }}
      >
        <View style={{ width: 92, gap: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{price(props.stock.quote().last, props.stock)}</Text>
          <Text style={{ fontSize: 12, fontVariant: ["tabular-nums"], color: toneOf(percent(props.stock.quote())) }}>{signed(percent(props.stock.quote()))}%</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Sell" variant="secondary" onPress={() => trade("sell")} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Buy" onPress={() => trade("buy")} />
        </View>
      </View>
      {banner.view}
      {/* The ticket: a bottom sheet on phones, a card in the window on
          desktops (Escape or a click outside closes it). */}
      <If
        when={props.wide}
        else={
          <Sheet open={ticket()} onClose={() => ticket.set(false)}>
            {ticketView}
          </Sheet>
        }
      >
        <Dialog open={ticket()} presentation="formSheet" onOpenChange={(open) => ticket.set(open)} style={{ flex: 1 }}>
          <View style={{ flex: 1, padding: 20, backgroundColor: colors.surface }}>{ticketView}</View>
        </Dialog>
      </If>
    </View>
  );
}
