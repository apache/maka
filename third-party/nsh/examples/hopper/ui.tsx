import { effect, type GestureResponderEvent, type JSX, signal, Text, View, type YNode } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { Button, Tab, Tabs } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { color, mono, radius } from "./theme";

/**
 * Responder props that follow one finger over a view: `move` gets its
 * position in the view from touch down (`first`) until it lifts (`end`),
 * whichever child the finger is over. The view keeps the touch, so the
 * scroll view around does not take it; `accept`, if given, decides whether
 * a finger going down at (`x`, `y`) starts the gesture (positions in the
 * view the finger went down on: use it on views without children).
 */
export function track(
  move: (x: number, y: number, first: boolean) => void,
  end?: () => void,
  accept?: (x: number, y: number) => boolean,
) {
  let node: YNode | undefined;
  // Touches give page positions; the view's own comes from measuring it
  // when a gesture starts (the page cannot scroll while the view holds the
  // touch). Moves before the answer only update `at`.
  let origin: { x: number; y: number } | null = null;
  let measured: Promise<void> = Promise.resolve();
  let at = { x: 0, y: 0 };
  let first = true;
  let gesture = 0;
  const send = () => {
    if (origin === null) return;
    move(at.x - origin.x, at.y - origin.y, first);
    first = false;
  };
  const lift = () => {
    const id = gesture;
    void measured.then(() => {
      if (id === gesture) end?.();
    });
  };
  const wants = (e: GestureResponderEvent) => accept?.(e.locationX, e.locationY) ?? true;
  return {
    ref: (n: YNode) => (node = n),
    onStartShouldSetResponder: wants,
    onMoveShouldSetResponder: wants,
    onResponderGrant: (e: GestureResponderEvent) => {
      const id = ++gesture;
      origin = null;
      first = true;
      at = { x: e.pageX, y: e.pageY };
      measured = (node?.measure() ?? Promise.resolve(null)).then((m) => {
        if (id !== gesture || m === null) return;
        origin = m.pagePosition;
        send();
      });
      return true;
    },
    onResponderMove: (e: GestureResponderEvent) => {
      at = { x: e.pageX, y: e.pageY };
      send();
    },
    onResponderRelease: lift,
    onResponderTerminate: lift,
    onResponderTerminationRequest: () => false,
  };
}

/** A panel: an icon tile, a title and a status line, an optional tag and
 * a details button, then its content on an inset surface. */
export function Panel(props: {
  icon: IconName;
  title: string;
  status: JSX.Element;
  tag?: string;
  onOpen?: () => void;
  children: JSX.Element;
}) {
  return (
    <View
      style={{
        backgroundColor: color.card,
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: color.line,
        padding: 5,
        shadowColor: "#000",
        shadowOpacity: 0.35,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 11, paddingTop: 11, paddingBottom: 13 }}>
        <View style={tile}>
          <Icon name={props.icon} size={19} tint={color.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: color.text, fontSize: 17, fontWeight: "600", letterSpacing: -0.2 }}>{props.title}</Text>
          <Text style={{ color: color.muted, fontSize: 13 }} numberOfLines={1}>
            {props.status}
          </Text>
        </View>
        <If when={props.tag}>
          <Pill label={props.tag ?? ""} />
        </If>
        <If when={props.onOpen}>
          <View
            onPress={props.onOpen}
            activeStyle={{ opacity: 0.5 }}
            hitSlop={6}
            role="button"
            accessibilityLabel={`${props.title} details`}
            style={tile}
          >
            <Icon name="chevron" size={18} tint={color.text} />
          </View>
        </If>
      </View>
      <View
        style={{
          backgroundColor: color.inset,
          borderRadius: radius.card - 5,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: color.line,
          padding: 16,
          gap: 18,
        }}
      >
        {props.children}
      </View>
    </View>
  );
}

/** A 38 pt square with a hairline border: icons and small buttons. */
const tile = {
  width: 38,
  height: 38,
  borderRadius: 11,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: color.lineStrong,
  backgroundColor: color.raised,
  alignItems: "center",
  justifyContent: "center",
} as const;

/** A small outlined status label ("NOMINAL", "Q3"), monospaced. */
export function Pill(props: { label: string; tone?: "neutral" | "accent" | "caution" | "alert"; width?: number }) {
  const tone = () => props.tone ?? "neutral";
  const ink = () => ({ neutral: color.muted, accent: color.accent, caution: color.caution, alert: color.alert })[tone()];
  const fill = () => ({ neutral: color.raised, accent: color.accentDim, caution: color.cautionDim, alert: color.alertDim })[tone()];
  return (
    <Text
      style={{
        fontFamily: mono,
        fontSize: 11,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        textAlign: "center",
        width: props.width,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: tone() === "neutral" ? color.lineStrong : ink(),
        overflow: "hidden",
        color: ink(),
        backgroundColor: fill(),
      }}
    >
      {props.label}
    </Text>
  );
}

/** A label and a value on one line. */
export function Caption(props: { label: JSX.Element; value?: JSX.Element; tint?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ fontSize: 14, color: color.muted }}>{props.label}</Text>
      <If when={props.value !== undefined}>
        <Text style={{ fontFamily: mono, fontSize: 14, color: props.tint ?? color.text }}>{props.value}</Text>
      </If>
    </View>
  );
}

/** A bar that grows to `value` (0…1) on the UI thread when it appears and
 * when the value changes; past `warnAbove` it turns amber. */
export function Gauge(props: { value: number; warnAbove?: number }) {
  const fill = createAnimatedValue(0);
  effect(() => {
    fill.timing(props.value, { duration: 650, easing: Easing.out(Easing.cubic) });
  });
  return (
    <View style={{ height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: color.raised }}>
      <View
        style={{
          flex: 1,
          borderRadius: 4,
          backgroundColor: props.value > (props.warnAbove ?? 2) ? color.caution : color.accent,
          transformOrigin: "left",
          transform: [{ scaleX: fill }],
        }}
      />
    </View>
  );
}

/** A tinted inset box for summaries. */
export function Inset(props: { children: JSX.Element }) {
  return (
    <View
      style={{
        backgroundColor: color.card,
        borderRadius: radius.control + 2,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: color.line,
        padding: 16,
        gap: 12,
      }}
    >
      {props.children}
    </View>
  );
}

/** A list row with a hairline above all but the first. */
export function Line(props: { first?: boolean; selected?: boolean; children: JSX.Element }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 50,
        paddingHorizontal: 8,
        marginHorizontal: -8,
        borderRadius: 10,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: color.line,
        backgroundColor: props.selected ? color.raised : "transparent",
      }}
    >
      {props.children}
    </View>
  );
}

/** An on / off switch; a disabled one is dimmed and ignores presses. */
export function Switch(props: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  const on = createAnimatedValue(props.value ? 1 : 0);
  effect(() => {
    on.spring(props.value ? 1 : 0, { stiffness: 380, damping: 28 });
  });
  return (
    <View
      onPress={() => props.onChange(!props.value)}
      disabled={props.disabled}
      hitSlop={8}
      role="switch"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.value, disabled: props.disabled }}
      style={{
        width: 46,
        height: 28,
        borderRadius: 14,
        padding: 3,
        opacity: props.disabled ? 0.4 : 1,
        backgroundColor: on.interpolate({ inputRange: [0, 1], outputRange: [color.lineStrong, color.accent] }),
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 3,
          borderColor: on.interpolate({ inputRange: [0, 1], outputRange: [color.muted, color.ink] }),
          backgroundColor: color.ink,
          transform: [{ translateX: on.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) }],
        }}
      />
    </View>
  );
}

/** A segmented control on a bordered track: `Tabs` of `Tab`s, the selected
 * one raised. The classes spell `color` (theme.ts) out as arbitrary values,
 * because a state variant (`selected:`) takes classes. */
export function Segmented<T extends string>(props: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <Tabs
      class="flex-row rounded-[12px] border border-[#242b34] bg-[#151a20] p-[3px]"
      style={{ borderCurve: "continuous" }}
    >
      <Each of={props.options}>
        {(option) => (
          <Tab
            selected={props.value === option()}
            onPress={() => props.onChange(option())}
            class="group flex-1 items-center rounded-[9px] border border-transparent py-[9px] selected:border-[#323b46] selected:bg-[#1d232b]"
          >
            <Text class="text-[14px] font-normal text-[#8794a3] group-selected:font-semibold group-selected:text-[#e8edf2]">
              {option()}
            </Text>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}

/** A value between − / + buttons on a bordered track; holding a button
 * repeats. */
export function Counter(props: {
  value: number;
  format: (v: number) => string;
  step: number;
  min: number;
  max: number;
  label: string;
  onChange: (v: number) => void;
}) {
  let repeat: ReturnType<typeof setInterval> | undefined;
  const nudge = (d: number) => props.onChange(Math.min(props.max, Math.max(props.min, props.value + d * props.step)));
  const stop = () => {
    if (repeat !== undefined) clearInterval(repeat);
    repeat = undefined;
  };
  const button = (d: number, glyph: string, name: string) => (
    <View
      onPress={() => nudge(d)}
      onLongPress={() => {
        stop();
        repeat = setInterval(() => nudge(d), 90);
      }}
      onPressUp={stop}
      disabled={d < 0 ? props.value <= props.min : props.value >= props.max}
      activeStyle={{ opacity: 0.5 }}
      hitSlop={6}
      role="button"
      accessibilityLabel={`${name} ${props.label}`}
      style={{
        width: 34,
        height: 34,
        borderRadius: 9,
        backgroundColor: color.raised,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: color.text, fontSize: 19, fontWeight: "300" }}>{glyph}</Text>
    </View>
  );
  return (
    <View
      accessibilityLabel={props.label}
      accessibilityValue={{ text: props.format(props.value) }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        padding: 3,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: color.line,
        backgroundColor: color.card,
      }}
    >
      {button(-1, "−", "Decrease")}
      <Text style={{ minWidth: 62, textAlign: "center", fontFamily: mono, fontSize: 15, color: color.text }}>
        {props.format(props.value)}
      </Text>
      {button(1, "+", "Increase")}
    </View>
  );
}

/** A slider (whole numbers) whose track turns amber below `floor`, with the
 * floor marked. Drag anywhere on it. */
export function Slider(props: {
  min: number;
  max: number;
  value: number;
  floor: number;
  unit: string;
  label: string;
  onChange: (v: number) => void;
}) {
  const width = signal(0);
  const knob = 22;
  const at = (v: number) => ((v - props.min) / (props.max - props.min)) * (width() - knob) + knob / 2;
  const pick = (x: number) => {
    const w = width() - knob;
    if (w <= 0) return;
    const k = Math.min(1, Math.max(0, (x - knob / 2) / w));
    props.onChange(Math.round(props.min + k * (props.max - props.min)));
  };
  const low = () => props.value < props.floor;
  return (
    <View
      onLayout={(e) => width.set(e.size.width)}
      {...track((x) => pick(x))}
      role="adjustable"
      accessibilityLabel={props.label}
      accessibilityValue={{ min: props.min, max: props.max, now: props.value }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) =>
        props.onChange(Math.min(props.max, Math.max(props.min, props.value + (e.actionName === "increment" ? 1 : -1))))
      }
      style={{ height: 52 }}
    >
      <View
        style={{
          position: "absolute",
          left: knob / 2,
          right: knob / 2,
          top: 9,
          height: 4,
          borderRadius: 2,
          backgroundColor: color.raised,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: knob / 2,
          top: 9,
          height: 4,
          borderRadius: 2,
          width: Math.max(0, at(props.value) - knob / 2),
          backgroundColor: low() ? color.caution : color.accent,
        }}
      />
      <View style={{ position: "absolute", top: 3, left: at(props.floor) - 1, width: 2, height: 16, borderRadius: 1, backgroundColor: color.caution }} />
      <View
        style={{
          position: "absolute",
          top: 0,
          left: at(props.value) - knob / 2,
          width: knob,
          height: knob,
          borderRadius: knob / 2,
          borderWidth: 3,
          borderColor: low() ? color.caution : color.accent,
          backgroundColor: color.ink,
        }}
      />
      <Text style={{ position: "absolute", top: 32, left: 0, fontFamily: mono, fontSize: 12, color: color.faint }}>
        {props.min}
        {props.unit}
      </Text>
      <Text
        style={{
          position: "absolute",
          top: 32,
          left: at(props.floor) - 50,
          width: 100,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 12,
          color: color.caution,
        }}
      >
        hover {props.floor}
        {props.unit}
      </Text>
      <Text style={{ position: "absolute", top: 32, right: 0, fontFamily: mono, fontSize: 12, color: color.faint }}>
        {props.max}
        {props.unit}
      </Text>
    </View>
  );
}

/** A full-width button; `primary` is filled with the accent. */
export function Action(props: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      activeStyle={{ opacity: 0.7 }}
      disabledStyle={{ opacity: 0.5 }}
      style={{
        flex: 1,
        height: 50,
        borderRadius: radius.control + 2,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: props.primary ? color.accent : color.lineStrong,
        backgroundColor: props.primary ? color.accent : color.raised,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: "600", color: props.primary ? color.ink : color.text }}>{props.label}</Text>
    </Button>
  );
}
