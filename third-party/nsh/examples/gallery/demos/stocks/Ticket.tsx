import { effect, signal, Text, untracked, View } from "nsh";
import { Animated, createAnimatedValue, Easing, LayoutAnimation } from "nsh";
import { Icon } from "../../icons";
import { Button, colors, finish, isDark, Press, radius, Segmented, tints } from "../../ui";
import { grouped, type Stock, price } from "./market";

export type Side = "buy" | "sell";

/** Simulated buying power. */
const POWER = 250_000;
const quantities = [100, 500, 1000, 5000];
const sides = [
  { value: "buy" as const, label: "Buy" },
  { value: "sell" as const, label: "Sell" },
];

/** A confirmation that drops in from the top and leaves by itself. */
export function createBanner() {
  const t = createAnimatedValue(0);
  const message = signal({ title: "", detail: "", side: "buy" as Side });
  const show = (title: string, detail: string, side: Side) => {
    message.set({ title, detail, side });
    Animated.sequence([
      Animated.spring(t, { toValue: 1, stiffness: 260, damping: 22 }),
      Animated.delay(2200),
      Animated.timing(t, { toValue: 0, duration: 260, easing: Easing.in(Easing.cubic) }),
    ]).start();
  };
  const view = (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 10,
        left: 16,
        right: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: radius.inset + 3,
        borderCurve: "continuous",
        backgroundColor: colors.light,
        opacity: t.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 1] }),
        transform: [
          { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-90, 0] }) },
          { scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
        ],
      }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: message().side === "buy" ? colors.up : colors.down,
        }}
      >
        <Icon name="check" size={18} tint={isDark() ? "#111214" : "#ffffff"} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.onLight }}>{message().title}</Text>
        <Text numberOfLines={1} style={{ fontSize: 13, color: isDark() ? "#4a4e55" : "#a4a8ae" }}>
          {message().detail}
        </Text>
      </View>
    </View>
  );
  return { show, view };
}

/** A square 44 pt stepper button. */
function Step(props: { icon: "plus" | "minus"; label: string; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} accessibilityLabel={props.label}>
      <View style={{ width: 44, height: 44, borderRadius: radius.control, alignItems: "center", justifyContent: "center", ...finish.pill, borderWidth: 1 }}>
        <If when={props.icon === "plus"} else={<View style={{ width: 14, height: 2, borderRadius: 1, backgroundColor: colors.text }} />}>
          <Icon name="plus" size={18} tint={colors.text} />
        </If>
      </View>
    </Press>
  );
}

/** A line of the review: a label and a value. */
function Line(props: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", minHeight: 24 }}>
      <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>{props.label}</Text>
      <Text style={{ fontSize: props.strong ? 17 : 14, fontWeight: props.strong ? "600" : "400", color: colors.text, fontVariant: ["tabular-nums"] }}>{props.value}</Text>
    </View>
  );
}

/**
 * The order ticket (the content of a sheet): side, a limit price stepper,
 * quantity chips and the estimated cost; reviewing expands the ticket (a
 * layout animation) and placing calls `onPlaced`. Nothing is sent anywhere.
 */
export function Ticket(props: { open: () => boolean; stock: Stock; side: () => Side; onSide: (side: Side) => void; onPlaced: (title: string, detail: string, side: Side) => void }) {
  const limit = signal(props.stock.quote().last);
  const quantity = signal(500);
  const review = signal(false);
  // Each opening starts from the last price, not reviewing.
  effect(() => {
    if (!props.open()) return;
    untracked(() => {
      limit.set(props.stock.quote().last);
      review.set(false);
    });
  });
  const p = (v: number) => price(v, props.stock);
  const cost = () => limit() * quantity();
  const fee = () => Math.max(1, cost() * 0.0003);
  const expand = (open: boolean) => {
    LayoutAnimation.configureNext({ duration: 380, update: { type: "spring", springDamping: 0.86 }, create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    review.set(open);
  };
  const nudge = (steps: number) => limit.set(Math.max(props.stock.tick, Math.round(limit() / props.stock.tick + steps) * props.stock.tick));
  const tone = () => (props.side() === "buy" ? colors.up : colors.down);
  const verb = () => (props.side() === "buy" ? "Buy" : "Sell");
  return (
    <View style={{ gap: 16, paddingTop: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 20, fontWeight: "600", color: colors.text }}>
          {verb()} {props.stock.code}
        </Text>
        <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>simulated · nothing is sent</Text>
      </View>
      <Segmented options={sides} value={props.side()} onChange={(s) => props.onSide(s)} />
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>Limit price</Text>
          <Text
            onPress={() => limit.set(props.stock.quote().last)}
            role="button"
            hitSlop={10}
            style={{ fontSize: 13, color: colors.accent, fontVariant: ["tabular-nums"] }}
          >
            use last {p(props.stock.quote().last)}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Step icon="minus" label="Lower the price" onPress={() => nudge(-1)} />
          <View style={{ flex: 1, height: 44, borderRadius: radius.control, alignItems: "center", justifyContent: "center", backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.border }}>
            <Text style={{ fontSize: 20, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{p(limit())}</Text>
          </View>
          <Step icon="plus" label="Raise the price" onPress={() => nudge(1)} />
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>Quantity</Text>
          <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{grouped(quantity(), 0)} sh</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Each of={quantities}>
            {(q) => (
              <View style={{ flex: 1 }}>
                <Press onPress={() => quantity.set(q())} accessibilityLabel={`${q()} shares`} accessibilityState={{ selected: quantity() === q() }}>
                  <View
                    style={{
                      height: 44,
                      borderRadius: radius.control,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: quantity() === q() ? tints.accent : colors.raised,
                      borderWidth: 1,
                      borderColor: quantity() === q() ? colors.accent : colors.border,
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"], color: quantity() === q() ? colors.accent : colors.text }}>
                      {q() >= 1000 ? `${q() / 1000}K` : `${q()}`}
                    </Text>
                  </View>
                </Press>
              </View>
            )}
          </Each>
        </View>
      </View>
      <View style={{ gap: 6, paddingTop: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>Estimated {props.side() === "buy" ? "cost" : "proceeds"}</Text>
          <Text style={{ fontSize: 22, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{grouped(cost())}</Text>
        </View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.raised, overflow: "hidden" }}>
          <View style={{ width: `${Math.min(100, (cost() / POWER) * 100)}%`, height: 6, borderRadius: 3, backgroundColor: cost() > POWER ? colors.danger : tone() }} />
        </View>
        <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>
          {((cost() / POWER) * 100).toFixed(1)}% of {grouped(POWER, 0)} buying power
        </Text>
      </View>
      <If
        when={review()}
        else={<Button label={`Review ${verb().toLowerCase()}`} onPress={() => expand(true)} />}
      >
        <View style={{ gap: 12, padding: 14, borderRadius: radius.inset, borderCurve: "continuous", borderWidth: 1, borderColor: tone(), backgroundColor: props.side() === "buy" ? tints.up : tints.down }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: tone() }}>
              {verb()} {grouped(quantity(), 0)} {props.stock.code}
            </Text>
            <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>LIMIT · DAY</Text>
          </View>
          <View style={{ gap: 2 }}>
            <Line label="Limit" value={p(limit())} />
            <Line label="Fees (est.)" value={grouped(fee())} />
            <Line label="Total" value={grouped(props.side() === "buy" ? cost() + fee() : cost() - fee())} strong />
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button label="Edit" variant="secondary" onPress={() => expand(false)} />
            </View>
            <View style={{ flex: 2 }}>
              <Button
                label={`Place ${verb().toLowerCase()} order`}
                onPress={() => {
                  props.onPlaced(`${verb()} order placed`, `${grouped(quantity(), 0)} ${props.stock.code} at ${p(limit())} · simulated`, props.side());
                  expand(false);
                }}
              />
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}
