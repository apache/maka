import { Canvas, cleanup, type GestureResponderEvent, Image, signal, Text, View } from "nsh";
import { Animated, createAnimatedValue, Easing } from "nsh";
import { PanResponder } from "nsh";
import { Icon, type IconName } from "../icons";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, finish, hint, IconTile, isDark, mono, Press, radius, Row, Stat, tints } from "../ui";

/** A dot matrix behind a stage, drawn once. */
function Dots() {
  return (
    <Canvas
      pointerEvents="none"
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
      draw={(cx, { width, height }) => {
        cx.fillStyle = colors.line;
        for (let x = 8; x < width; x += 14) for (let y = 8; y < height; y += 14) cx.fillRect(x, y, 1.5, 1.5);
      }}
    />
  );
}

/** A stage: the darker surface a demo plays on (call in a reactive scope). */
const stage = () =>
  ({
    borderRadius: radius.control,
    borderCurve: "continuous",
    overflow: "hidden",
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.line,
    ...finish.track,
  }) as const;

/** The highlight and shadow of a small colored knob (call in a reactive scope). */
const knob = () => (isDark() ? { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 10px rgba(0,0,0,0.45)" } : finish.knob);

/** A plain label with the API it uses, in code type. */
function Api(props: { label: string; api: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{props.label}</Text>
      <Text style={{ fontSize: 12, fontFamily: mono, color: colors.faint }}>{props.api}</Text>
    </View>
  );
}

/** Drag, pinch and rotate one photo at the same time, all on the UI thread. */
function Transformable() {
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  const scale = createAnimatedValue(1);
  const angle = createAnimatedValue(0);
  const last = signal({ scale: 1, angle: 0, drag: 0 });
  const reset = () => {
    x.spring(0);
    y.spring(0);
    scale.spring(1);
    angle.spring(0);
    last.set({ scale: 1, angle: 0, drag: 0 });
  };
  return (
    <Card icon="gestures" title="Pan, pinch and rotation" subtitle="Three recognizers on one view, driven natively">
      <View style={{ ...stage(), height: 260, alignItems: "center", justifyContent: "center" }}>
        <Dots />
        <View
          pointerEvents="none"
          style={{ position: "absolute", width: 200, height: 150, borderRadius: 18, borderWidth: 1, borderColor: colors.faint, borderStyle: "dashed" }}
        />
        <View
          testID="photo"
          pan={{ x, y }}
          pinch={{ scale }}
          rotation={{ angle }}
          onPanEnd={(e) => last.set({ ...last(), drag: Math.round(Math.hypot(e.translationX, e.translationY)) })}
          onPinchEnd={(e) => last.set({ ...last(), scale: e.scale })}
          onRotationEnd={(e) => last.set({ ...last(), angle: e.rotation })}
          style={{
            width: 200,
            height: 150,
            borderRadius: 18,
            borderCurve: "continuous",
            overflow: "hidden",
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.raised,
            transform: [{ translateX: x }, { translateY: y }, { scale }, { rotate: angle }],
          }}
        >
          <Image src="https://picsum.photos/seed/nsh-card/400/300" style={{ flex: 1 }} />
        </View>
      </View>
      <View style={{ flexDirection: "row" }}>
        <Stat width="33%" label="Drag" value={`${last().drag} pt`} />
        <Stat width="33%" label="Scale" value={`${last().scale.toFixed(2)}×`} tone="accent" />
        <Stat width="34%" label="Angle" value={`${Math.round(last().angle)}°`} tone="info" />
      </View>
      <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>
        {hint("Pinch and rotate with two fingers (Option-drag in the simulator).", "Drag with the mouse; pinch and rotate on a touchpad or a touch screen.")}
      </Text>
      <Button label="Reset" variant="secondary" onPress={reset} />
    </Card>
  );
}

/** A ball dragged with a PanResponder (positions go through JS). Its
 * responder blocks the page from scrolling while it is dragged. */
function Ball() {
  const pos = signal({ x: 0, y: 0 });
  const state = signal<{ label: string; tone: "neutral" | "accent" | "info" | "warn" }>({ label: "Idle", tone: "neutral" });
  const grab = createAnimatedValue(0);
  let start = { x: 0, y: 0 };
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = pos();
      grab.spring(1, { stiffness: 420, damping: 24 });
      state.set({ label: "Dragging", tone: "accent" });
    },
    onPanResponderMove: (_, g) => pos.set({ x: start.x + g.dx, y: start.y + g.dy }),
    onPanResponderRelease: (_, g) => {
      grab.spring(0, { stiffness: 300, damping: 20 });
      state.set({ label: `${g.vx.toFixed(2)}, ${g.vy.toFixed(2)} pt/ms`, tone: "info" });
    },
    onPanResponderTerminate: () => {
      grab.spring(0);
      state.set({ label: "Taken over", tone: "warn" });
    },
  });
  return (
    <Card icon="scroll" title="PanResponder" subtitle="Positions go through JS; the page does not scroll" right={<Badge label={state().label} tone={state().tone} />}>
      <View style={{ ...stage(), height: 200 }}>
        <Dots />
        <View
          testID="ball"
          {...pan.panHandlers}
          style={{
            position: "absolute",
            left: "50%",
            top: 70,
            marginLeft: -30,
            width: 60,
            height: 60,
            borderRadius: 30,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: grab.interpolate({ inputRange: [0, 1], outputRange: [colors.info, colors.accentFill] }),
            ...knob(),
            transform: [{ translateX: pos().x }, { translateY: pos().y }, { scale: grab.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) }],
          }}
        >
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(19,22,12,0.35)" }} />
        </View>
      </View>
      <Caption label="Position" note={`${Math.round(pos().x)}, ${Math.round(pos().y)}`} />
      <Button label="Center" variant="secondary" onPress={() => pos.set({ x: 0, y: 0 })} />
    </Card>
  );
}

/** Raw touch events, every finger drawn where it is. */
function TouchPad() {
  const log = signal<{ name: string; text: string }[]>([]);
  const fingers = signal<{ id: number; x: number; y: number }[]>([]);
  const note = (name: string) => (e: GestureResponderEvent) => {
    fingers.set(name === "cancel" ? [] : e.touches.map((t, id) => ({ id, x: t.locationX, y: t.locationY })));
    log.update((l) =>
      [
        {
          name,
          text: `${Math.round(e.locationX)}, ${Math.round(e.locationY)} · page ${Math.round(e.pageX)}, ${Math.round(e.pageY)} · ${e.touches.length} down`,
        },
        ...l,
      ].slice(0, 4),
    );
  };
  return (
    <Card icon="system" title="Touch events" subtitle={hint("Start, move, end and cancel, for every finger", "Start, move, end and cancel, for the mouse and every finger")} right={<Badge label={`${fingers().length} down`} tone={fingers().length ? "accent" : "neutral"} />}>
      <View
        onTouchStart={note("start")}
        onTouchMove={note("move")}
        onTouchEnd={note("end")}
        onTouchCancel={note("cancel")}
        style={{ ...stage(), height: 150, alignItems: "center", justifyContent: "center" }}
      >
        <Dots />
        <If when={fingers().length === 0}>
          <Text style={{ fontSize: 14, color: colors.muted }}>{hint("Touch here, try two fingers", "Press and drag here with the mouse")}</Text>
        </If>
        <Each of={fingers()} key={(f) => f.id}>
          {(f) => (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: f().x - 26,
                top: f().y - 26,
                width: 52,
                height: 52,
                borderRadius: 26,
                borderWidth: 2,
                borderColor: colors.accent,
                backgroundColor: tints.accent,
              }}
            />
          )}
        </Each>
      </View>
      <View style={{ gap: 4, minHeight: 4 * 18 }}>
        <If when={log().length > 0} else={<Text style={{ fontSize: 13, color: colors.faint }}>No touches yet</Text>}>
          <Each of={log()}>
            {(entry, i) => (
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <Text style={{ width: 52, fontSize: 12, fontFamily: mono, color: i() === 0 ? colors.accent : colors.faint }}>{entry().name}</Text>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: i() === 0 ? colors.text : colors.faint, fontVariant: ["tabular-nums"] }}>
                  {entry().text}
                </Text>
              </View>
            )}
          </Each>
        </If>
      </View>
    </Card>
  );
}

/** Each press event lights up its chip as it arrives. */
function PressEvents() {
  const names = ["pressIn", "press", "longPress", "pressOut"] as const;
  const flashes = names.map(() => createAnimatedValue(0));
  const count = signal(0);
  const log = signal<string[]>([]);
  const fire = (name: string) => {
    count.set(count() + 1);
    log.update((l) => [name, ...l].slice(0, 6));
    const i = names.indexOf(name as (typeof names)[number]);
    if (i >= 0) {
      flashes[i].set(1);
      flashes[i].timing(0, { duration: 700, easing: Easing.out(Easing.quad) });
    }
  };
  return (
    <Card icon="components" title="Press events" subtitle="In, press, long press and out; native feedback" right={<Badge label={`${count()}`} />}>
      <View
        onPressDown={() => fire("pressIn")}
        onPressUp={() => fire("pressOut")}
        onPress={() => fire("press")}
        onLongPress={() => fire("longPress")}
        activeStyle={{ opacity: 0.55 }}
        role="button"
        style={{
          height: 64,
          borderRadius: radius.control,
          borderCurve: "continuous",
          backgroundColor: colors.light,
          ...finish.light,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.onLight }}>{hint("Tap, hold, or slide off", "Click, hold, or slide off")}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Each of={[...names]}>
          {(name, i) => (
            <View
              style={{
                flex: 1,
                height: 30,
                borderRadius: 15,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: flashes[i()].interpolate({ inputRange: [0, 1], outputRange: [colors.raised, colors.accentFill] }),
                boxShadow: finish.raised.boxShadow,
              }}
            >
              <Text style={{ fontSize: 11, fontFamily: mono, color: colors.text }}>{name()}</Text>
            </View>
          )}
        </Each>
      </View>
      <Text numberOfLines={1} style={{ fontSize: 12, fontFamily: mono, color: colors.faint }}>
        {log().join(" · ") || "No events yet"}
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View
          onPress={() => fire("ripple")}
          onLongPress={() => fire("fast long press")}
          delayLongPress={250}
          activeStyle={{ backgroundColor: colors.border }}
          android={{ ripple: { color: alpha(colors.accentFill, 0.25) } }}
          style={{
            flex: 1,
            height: 56,
            borderRadius: radius.control,
            borderCurve: "continuous",
            backgroundColor: colors.raised,
            ...finish.raised,
            borderWidth: 1,
            borderColor: colors.border,
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <Text style={{ fontSize: 14, color: colors.text }}>Ripple</Text>
          <Text style={{ fontSize: 12, color: colors.faint }}>Long press after 250 ms</Text>
        </View>
        <View
          onPress={() => fire("borderless")}
          android={{ ripple: { borderless: true, radius: 40 } }}
          activeStyle={{ opacity: 0.4 }}
          role="button"
          accessibilityLabel="Star"
          style={{ width: 56, height: 56, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="star" size={24} tint={colors.warn} />
        </View>
      </View>
      <Text onPress={() => fire("text")} activeStyle={{ opacity: 0.3 }} style={{ alignSelf: "flex-start", fontSize: 15, color: colors.accent, paddingVertical: 12 }}>
        Pressable text, dimmed while pressed
      </Text>
    </Card>
  );
}

/** A tiny dot with a ring showing the 30 pt around it that also takes taps. */
function HitSlop() {
  const taps = signal(0);
  const ring = createAnimatedValue(0);
  const breathe = Animated.loop(
    Animated.sequence([
      Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.sin) }),
      Animated.timing(ring, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.sin) }),
    ]),
  );
  breathe.start();
  cleanup(() => breathe.stop());
  return (
    <Card icon="search" title="Hit slop" subtitle={hint("A 12 pt dot that takes taps 30 pt around it", "A 12 pt dot that takes clicks 30 pt around it")} right={<Badge label={`${taps()} taps`} tone={taps() ? "accent" : "neutral"} />}>
      <View style={{ ...stage(), height: 140, alignItems: "center", justifyContent: "center" }}>
        <Dots />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: 72,
            height: 72,
            borderRadius: 36,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: colors.danger,
            backgroundColor: tints.danger,
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.04] }) }],
          }}
        />
        <Press hitSlop={30} scale={0.8} onPress={() => taps.set(taps() + 1)} accessibilityLabel="Tiny dot">
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.danger, ...knob() }} />
        </Press>
      </View>
      <Api label={hint("The dashed ring is the touch area", "The dashed ring is the click area")} api="hitSlop={30}" />
    </Card>
  );
}

/** An overlay that lets taps through to the button under it. */
function PointerEvents() {
  const through = signal(0);
  return (
    <Card icon="nav" title="Pointer events" subtitle={hint("An overlay that lets taps through", "An overlay that lets clicks through")} right={<Badge label={`${through()}`} tone="up" />}>
      <View style={{ height: 88 }}>
        <Press onPress={() => through.set(through() + 1)} scale={0.98} style={{ flex: 1 }}>
          <View
            style={{
              flex: 1,
              borderRadius: radius.control,
              borderCurve: "continuous",
              backgroundColor: tints.up,
              borderWidth: 1,
              borderColor: colors.up,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.up }}>Button under an overlay</Text>
          </View>
        </Press>
        <Canvas
          pointerEvents="none"
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          draw={(cx, { width, height }) => {
            // A hatched band across the middle, framed with dashes.
            cx.save();
            cx.beginPath();
            cx.rect(width * 0.18, 0, width * 0.64, height);
            cx.clip();
            cx.strokeStyle = alpha(colors.warn, 0.28);
            cx.lineWidth = 1;
            cx.beginPath();
            for (let i = -height; i < width; i += 8) {
              cx.moveTo(i, height);
              cx.lineTo(i + height, 0);
            }
            cx.stroke();
            cx.restore();
            cx.setLineDash([4, 4]);
            cx.strokeStyle = colors.warn;
            cx.beginPath();
            cx.roundRect(width * 0.18 + 0.5, 0.5, width * 0.64 - 1, height - 1, 10);
            cx.stroke();
          }}
        />
      </View>
      <Api label={hint("Taps on the hatched band reach the button", "Clicks on the hatched band reach the button")} api={'pointerEvents="none"'} />
    </Card>
  );
}

/** The mouse over a view: it comes in, moves and leaves (desktops). */
function Hover() {
  const over = signal(false);
  const at = signal({ x: 0, y: 0 });
  return (
    <Card icon="gestures" title="Hover" subtitle={hint("A pointer over a view: iPad, desktops", "The mouse over a view")} right={<Badge label={over() ? "Over" : "Away"} tone={over() ? "accent" : "neutral"} />}>
      <View
        testID="hover-pad"
        onHoverIn={() => over.set(true)}
        onHoverOut={() => over.set(false)}
        onHoverMove={(e) => at.set({ x: Math.round(e.position.x), y: Math.round(e.position.y) })}
        class="hover:bg-card"
        style={{ ...stage(), height: 100, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ fontSize: 14, color: colors.muted }}>{over() ? `Pointer at ${at().x}, ${at().y}` : "Pointer away"}</Text>
      </View>
      <Api label="In, move and out" api="onHoverIn · onHoverMove · onHoverOut" />
    </Card>
  );
}

/** Elements labelled for VoiceOver / TalkBack. */
function Accessibility() {
  const last = signal("");
  const items: { label: string; hint: string; icon: IconName }[] = [
    { label: "Play", hint: "Starts the song", icon: "play" },
    { label: "Like", hint: "Adds to favorites", icon: "star" },
    { label: "Notify", hint: "Turns on alerts", icon: "bell" },
  ];
  return (
    <Card icon="text" title="Accessibility" subtitle="Roles, labels and hints for screen readers" right={<If when={last()}><Badge label={last()} tone="info" /></If>}>
      <Each of={items}>
        {(item, i) => (
          <View
            accessible
            role="button"
            accessibilityLabel={item().label}
            accessibilityHint={item().hint}
            onPress={() => last.set(item().label)}
          >
            <Row first={i() === 0}>
              <IconTile name={item().icon} size={34} tint={last() === item().label ? colors.accent : colors.text} />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ fontSize: 15, color: colors.text }}>{item().label}</Text>
                <Text style={{ fontSize: 12, color: colors.muted }}>{item().hint}</Text>
              </View>
              <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint }}>button</Text>
            </Row>
          </View>
        )}
      </Each>
    </Card>
  );
}

export function Gestures() {
  return <DemoPage cards={[Transformable, Ball, Hover, TouchPad, PressEvents, HitSlop, PointerEvents, Accessibility]} />;
}
