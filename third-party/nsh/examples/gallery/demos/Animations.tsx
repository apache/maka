import { type Bounds, Canvas, type CanvasRenderingContext2D, cleanup, Scroll, signal, Text, View } from "nsh";
import { Animated, type AnimatedNode, type CompositeAnimation, createAnimatedValue, createMotion, Easing, LayoutAnimation, type LayoutAnimationConfig, type MotionName, type MotionPreset, type MotionSpec, motions } from "nsh";
import { Button as BaseButton, Tab, Tabs } from "nsh/base";
import { Icon } from "../icons";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, finish, isDark, Legend, mono, type Palette, radius, Segmented, tabPress, tints } from "../ui";

/** The tones of the demos' dots and tiles (call in a reactive scope). */
const tones = () => [colors.accent, colors.info, colors.warn, colors.danger, colors.up];
/** Text on a tone's fill. */
const onTone = () => (isDark() ? colors.onAccent : "#ffffff");

/** A plain label with the API it uses, in code type. */
function Api(props: { label: string; api: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{props.label}</Text>
      <Text style={{ fontSize: 12, fontFamily: mono, color: colors.faint }}>{props.api}</Text>
    </View>
  );
}

/** The width of a track, measured once laid out (the dots move by it). */
function useWidth() {
  const width = signal(0);
  return [width, (bounds: Bounds) => width.set(bounds.size.width)] as const;
}

// --- Hero -------------------------------------------------------------------

/** An orbit, pulsing rings and a breathing core: three loops, started once. */
function Hero() {
  const spin = createAnimatedValue(0);
  const rings = [0, 1, 2].map(() => createAnimatedValue(0));
  const breathe = createAnimatedValue(0);
  const all = Animated.parallel([
    Animated.loop(Animated.timing(spin, { toValue: 360, duration: 3200, easing: Easing.linear }), { resetBeforeIteration: true }),
    Animated.stagger(
      800,
      rings.map((r) => Animated.loop(Animated.timing(r, { toValue: 1, duration: 2400, easing: Easing.out(Easing.cubic) }), { resetBeforeIteration: true })),
    ),
    Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(breathe, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.sin) }),
      ]),
    ),
  ]);
  all.start();
  cleanup(() => all.stop());

  const S = 188;
  const orbit = (size: number, angle: AnimatedNode, color: string, dot: number) => (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (S - size) / 2,
        top: (S - size) / 2,
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1,
        borderColor: colors.line,
        transform: [{ rotate: angle }],
      }}
    >
      <View style={{ position: "absolute", left: size / 2 - dot / 2, top: -dot / 2, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color, ...finish.knob }} />
    </View>
  );
  return (
    <Card
      icon="animation"
      title="Native motion"
      subtitle="Three loops, started once, run on the UI thread"
    >
      <View style={{ height: S + 8, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: S, height: S }}>
          <Each of={rings}>
            {(r) => (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 34,
                  top: 34,
                  width: S - 68,
                  height: S - 68,
                  borderRadius: (S - 68) / 2,
                  borderWidth: 1.5,
                  borderColor: colors.accent,
                  opacity: r().interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.6, 0] }),
                  transform: [{ scale: r().interpolate({ inputRange: [0, 1], outputRange: [0.35, 1.45] }) }],
                }}
              />
            )}
          </Each>
          {orbit(S - 12, spin, colors.accent, 10)}
          {orbit(S - 64, spin.mul(-1.6), colors.info, 8)}
          <View
            style={{
              position: "absolute",
              left: S / 2 - 26,
              top: S / 2 - 26,
              width: 52,
              height: 52,
              borderRadius: 26,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: breathe.interpolate({ inputRange: [0, 1], outputRange: [colors.accentFill, colors.up] }),
              boxShadow: finish.accent.boxShadow,
              transform: [{ scale: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.08] }) }],
            }}
          >
            <Icon name="animation" size={22} tint={colors.onAccent} />
          </View>
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Api label="Orbits, one turn in 3.2 s" api="Animated.loop" />
        <Api label="Rings, 0.8 s apart" api="Animated.stagger" />
        <Api label="Core, in and out" api="Animated.sequence" />
      </View>
    </Card>
  );
}

// --- Motion presets ---------------------------------------------------------

type MotionKind = MotionPreset["kind"];

const kinds: { value: MotionKind; label: string }[] = [
  { value: "enter", label: "Enter" },
  { value: "exit", label: "Exit" },
  { value: "attention", label: "Attention" },
  { value: "loop", label: "Loop" },
];

/** Every preset, in the order `motions` lists them. */
const presetNames = Object.keys(motions) as MotionName[];

/** Resolves after `ms`. */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One preset on a little card of its own: a tap plays it. Exits come back
 * after a moment; loops play until tapped again. */
function PresetTile(props: { name: MotionName; tone: string; onPlay: (status: string) => void }) {
  const m = createMotion();
  const kind = motions[props.name].kind;
  const looping = signal(false);
  // The latest tap: an exit comes back only if no tap came after it.
  let turn = 0;
  cleanup(() => m.stop());
  const press = async () => {
    const mine = ++turn;
    if (kind === "loop") {
      looping.set(!looping());
      props.onPlay(looping() ? props.name : "stopped");
      if (looping()) m.play(props.name);
      else m.reset();
      return;
    }
    props.onPlay(props.name);
    const finished = await m.play(props.name);
    if (kind !== "exit" || !finished) return;
    await pause(450);
    if (mine !== turn) return;
    m.reset();
    m.play("fadeIn", { duration: 220 });
  };
  return (
    <BaseButton
      onPress={press}
      accessibilityLabel={props.name}
      style={{ flexBasis: "30%", flexGrow: 1, borderRadius: 14 }}
      activeStyle={{ transform: [{ scale: 0.97 }] }}
    >
      <View
        style={{
          height: 92,
          borderRadius: 14,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          backgroundColor: colors.raised,
          ...finish.raised,
          borderWidth: 1,
          borderColor: looping() ? props.tone : colors.border,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: props.tone,
            ...finish.knob,
            opacity: m.opacity,
            transform: [{ perspective: 300 }, ...m.transform],
          }}
        >
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: onTone(), opacity: 0.85 }} />
        </View>
        <Text numberOfLines={1} style={{ fontSize: 12, fontFamily: mono, color: looping() ? colors.text : colors.muted }}>
          {props.name}
        </Text>
      </View>
    </BaseButton>
  );
}

/** The ready-made motions by what they are for, each a tap away. */
function MotionPresets() {
  const kind = signal<MotionKind>("attention");
  const status = signal("tap a tile");
  const names = () => presetNames.filter((n) => motions[n].kind === kind());
  return (
    <Card icon="spark" title="Motion presets" subtitle={`${presetNames.length} ready-made motions, played natively`} right={<Badge label={status()} tone="accent" />}>
      <Scroll horizontal scrollbar={false}>
        <Tabs style={{ flexDirection: "row", gap: 8 }}>
          <Each of={kinds}>
            {(k) => (
              <Chip
                label={k().label}
                active={kind() === k().value}
                onPress={() => {
                  kind.set(k().value);
                  status.set("tap a tile");
                }}
              />
            )}
          </Each>
        </Tabs>
      </Scroll>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Each of={names()}>{(name, i) => <PresetTile name={name()} tone={tones()[i() % tones().length]} onPlay={(s) => status.set(s)} />}</Each>
      </View>
      <View style={{ gap: 8 }}>
        <Api label="Channels for a view" api="createMotion()" />
        <Api label="A preset by name" api='motion.play("shake")' />
      </View>
    </Card>
  );
}

// --- Staggered entrance -----------------------------------------------------

const BARS = [0.5, 0.78, 0.42, 1, 0.62, 0.88, 0.55];
type StaggerOrigin = "first" | "center" | "last";

/** How many steps item `i` of `count` waits, counted from `from` (as
 * `Animated.stagger` counts them: the middle pair of an even count together). */
const staggerSteps = (i: number, count: number, from: StaggerOrigin) =>
  from === "first" ? i : from === "last" ? count - 1 - i : Math.floor(Math.abs(i - (count - 1) / 2));

/** A bar and its cap, entering `delay` ms in. */
function StaggerBar(props: { height: number; tone: string; delay: number }) {
  const bar = createMotion({ enter: "fadeInUp", delay: props.delay, duration: 520 });
  const cap = createMotion({ enter: "popIn", delay: props.delay + 220 });
  cleanup(() => {
    bar.stop();
    cap.stop();
  });
  return (
    <View style={{ flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: props.tone, ...cap.style }} />
      <View
        style={{
          alignSelf: "stretch",
          height: `${props.height * 78}%`,
          borderRadius: 10,
          borderCurve: "continuous",
          backgroundImage: `linear-gradient(180deg, ${props.tone} 0%, ${alpha(props.tone, 0.35)} 100%)`,
          ...bar.style,
        }}
      />
    </View>
  );
}

/** Items entering one after another, from either end or the middle: a
 * motion per item, each with its own delay. */
function StaggeredEntrance() {
  const from = signal<StaggerOrigin>("center");
  const wave = signal(0);
  // A new wave makes new items: each enters with a motion of its own.
  const items = () => BARS.map((height, i) => ({ key: `${wave()}-${i}`, height, i }));
  const replay = (origin: StaggerOrigin) => {
    from.set(origin);
    wave.set(wave() + 1);
  };
  return (
    <Card icon="lists" title="Staggered entrance" subtitle="createMotion({ enter, delay }) per item" right={<Badge label="70 ms apart" />}>
      <View style={{ height: 140, flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <Each of={items()} key={(it) => it.key}>
          {(it) => <StaggerBar height={it().height} tone={tones()[it().i % tones().length]} delay={staggerSteps(it().i, BARS.length, from()) * 70} />}
        </Each>
      </View>
      <Tabs style={{ flexDirection: "row", gap: 8 }}>
        <Chip label="From first" active={from() === "first"} onPress={() => replay("first")} />
        <Chip label="Center" active={from() === "center"} onPress={() => replay("center")} />
        <Chip label="Last" active={from() === "last"} onPress={() => replay("last")} />
      </Tabs>
      <Button label="Replay" variant="secondary" icon="play" onPress={() => replay(from())} />
    </Card>
  );
}

// --- Keyframes ----------------------------------------------------------------

const MOON = 52;
const PHASES = 8;

/** Where the shadow of phase `k` sits: it slides off to the right as the
 * moon waxes, then comes back from the left as it wanes. */
const shadowAt = (k: number) => (k <= PHASES / 2 ? (k / (PHASES / 2)) * MOON : -((PHASES - k) / (PHASES / 2)) * MOON);

/** Sprites and ticks with `steps()`, and a like made of chained motions. */
function Keyframes() {
  const sprite = createAnimatedValue(0);
  const tick = createAnimatedValue(0);
  const loops = Animated.parallel([
    Animated.keyframes(sprite, { keyframes: [0, -MOON * PHASES], duration: 1600, easing: Easing.steps(PHASES), iterations: "infinite" }),
    Animated.keyframes(tick, { keyframes: [0, 360], duration: 12000, easing: Easing.steps(12), iterations: "infinite" }),
  ]);
  loops.start();

  const heart = createMotion();
  const bubble = createMotion();
  bubble.opacity.set(0);
  const liked = signal(false);
  const count = signal(41);
  const like = async () => {
    const on = !liked();
    liked.set(on);
    count.set(count() + (on ? 1 : -1));
    if (!on) {
      heart.play("headShake");
      return;
    }
    bubble.play({
      keyframes: [
        { opacity: 0, translateY: 0, scale: 0.6 },
        { opacity: 1, translateY: -18, scale: 1, offset: 0.3, easing: Easing.out(Easing.back()) },
        { opacity: 0, translateY: -46, scale: 1 },
      ],
      duration: 900,
      easing: Easing.out(Easing.quad),
    });
    if (await heart.play("popIn", { duration: 360 })) heart.play("heartbeat");
  };

  const charge = createAnimatedValue(0);
  const [width, measure] = useWidth();
  const charging = () => {
    charge.set(0);
    charge.keyframes([0, 1], { duration: 1500, easing: Easing.steps(5) });
  };
  cleanup(() => {
    loops.stop();
    heart.stop();
    bubble.stop();
    charge.stop();
  });

  return (
    <Card icon="animation" title="Keyframes" subtitle="Steps, frames as the Web Animations API writes them, chained motions">
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-around" }}>
        <View style={{ alignItems: "center", gap: 8 }}>
          <View style={{ width: MOON, height: MOON, borderRadius: MOON / 2, overflow: "hidden", backgroundColor: colors.raised }}>
            <View style={{ flexDirection: "row", width: MOON * PHASES, transform: [{ translateX: sprite }] }}>
              <Each of={Array.from({ length: PHASES }, (_, k) => k)}>
                {(k) => (
                  <View style={{ width: MOON, height: MOON, borderRadius: MOON / 2, overflow: "hidden", backgroundColor: colors.warn }}>
                    <View
                      style={{
                        position: "absolute",
                        left: shadowAt(k()),
                        top: 0,
                        width: MOON,
                        height: MOON,
                        borderRadius: MOON / 2,
                        backgroundColor: colors.raised,
                      }}
                    />
                  </View>
                )}
              </Each>
            </View>
          </View>
          <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint }}>steps(8)</Text>
        </View>
        <View style={{ alignItems: "center", gap: 8 }}>
          <View style={{ width: MOON, height: MOON, borderRadius: MOON / 2, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.raised }}>
            <Each of={Array.from({ length: 12 }, (_, k) => k)}>
              {(k) => (
                <View
                  pointerEvents="none"
                  style={{ position: "absolute", left: MOON / 2 - 2.25, top: 2, width: 1.5, height: MOON - 7, transform: [{ rotate: `${k() * 30}deg` }] }}
                >
                  <View style={{ height: k() % 3 === 0 ? 6 : 3, backgroundColor: colors.faint }} />
                </View>
              )}
            </Each>
            <View
              pointerEvents="none"
              style={{ position: "absolute", left: MOON / 2 - 2.75, top: 7, width: 2.5, height: MOON - 17, transform: [{ rotate: tick }] }}
            >
              <View style={{ height: (MOON - 17) / 2, borderRadius: 1.25, backgroundColor: colors.accent }} />
            </View>
          </View>
          <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint }}>steps(12)</Text>
        </View>
        <View style={{ alignItems: "center", gap: 8 }}>
          <BaseButton onPress={like} accessibilityLabel={liked() ? "Unlike" : "Like"} style={{ borderRadius: MOON / 2 }}>
            <View
              style={{
                width: MOON,
                height: MOON,
                borderRadius: MOON / 2,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: liked() ? tints.warn : colors.raised,
                borderWidth: 1,
                borderColor: liked() ? colors.warn : colors.border,
              }}
            >
              <View style={heart.style}>
                <Icon name="star" size={24} tint={liked() ? colors.warn : colors.muted} />
              </View>
            </View>
          </BaseButton>
          <View pointerEvents="none" style={{ position: "absolute", top: -4, right: -10, ...bubble.style }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.warn }}>+1</Text>
          </View>
          <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint, fontVariant: ["tabular-nums"] }}>{count()} likes</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View onLayout={measure} style={{ flex: 1, height: 22, borderRadius: 7, overflow: "hidden", backgroundColor: colors.background, ...finish.track }}>
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: width(),
              backgroundImage: `linear-gradient(90deg, ${colors.up} 0%, ${colors.accent} 100%)`,
              transform: [{ translateX: charge.mul(width()).add(-width()) }],
            }}
          />
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row" }}>
            <Each of={[0, 1, 2, 3, 4]}>{(k) => <View style={{ flex: 1, borderLeftWidth: k() === 0 ? 0 : 2, borderColor: colors.surface }} />}</Each>
          </View>
        </View>
        <Button label="Charge" size="small" variant="secondary" onPress={charging} />
      </View>
      <View style={{ gap: 8 }}>
        <Api label="A sprite sheet, frame by frame" api="Easing.steps(8)" />
        <Api label="+1: three frames, one with its easing" api="play({ keyframes: [...] })" />
        <Api label="Like: pop in, then a heartbeat" api="await play(); play()" />
        <Api label="Charge in five jumps" api="value.keyframes([0, 1])" />
      </View>
    </Card>
  );
}

// --- Aurora -------------------------------------------------------------------

/** The blobs: where each rests, its colors in each appearance and the path it
 * drifts along, there and back. */
const blobs: { left: `${number}%`; top: number; size: number; light: string; dark: string; duration: number; keyframes: MotionSpec["keyframes"] }[] = [
  { left: "-18%", top: -70, size: 250, light: "#ff5fa2", dark: "#d946ef", duration: 7000, keyframes: { translateX: [0, 90], translateY: [0, 50], scale: [1, 1.3] } },
  { left: "48%", top: -60, size: 230, light: "#38d9ff", dark: "#0ea5e9", duration: 9000, keyframes: { translateX: [0, -80], translateY: [0, 70], scale: [1.1, 0.85] } },
  { left: "8%", top: 90, size: 270, light: "#ffc93c", dark: "#6366f1", duration: 8000, keyframes: { translateX: [0, 70], translateY: [0, -60], scale: [0.9, 1.2] } },
  { left: "58%", top: 110, size: 210, light: "#7cf29a", dark: "#14b8a6", duration: 6000, keyframes: { translateX: [0, -60], translateY: [0, -40], rotate: [0, 40], scale: [1, 1.25] } },
];

/** A getgradients-style background: blurred radial gradients, each drifting
 * on a looping motion of its own, clipped in a card. */
function Aurora() {
  const drifts = blobs.map((b) => {
    const m = createMotion();
    m.play({ keyframes: b.keyframes, duration: b.duration, easing: Easing.inOut(Easing.sin), iterations: "infinite", direction: "alternate" });
    return m;
  });
  cleanup(() => drifts.forEach((m) => m.stop()));
  const ink = () => (isDark() ? "#ffffff" : "#1b1035");
  return (
    <Card icon="styles" title="Aurora" subtitle="Blurred gradients on looping motions" flush>
      <View
        style={{
          height: 260,
          borderRadius: radius.inset,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: isDark() ? "#0a0716" : "#fff8f3",
        }}
      >
        <Each of={blobs}>
          {(b, i) => {
            const color = () => (isDark() ? b().dark : b().light);
            return (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: b().left,
                  top: b().top,
                  width: b().size,
                  height: b().size,
                  borderRadius: b().size / 2,
                  backgroundImage: `radial-gradient(circle, ${color()}e6 0%, ${color()}80 40%, ${color()}00 70%)`,
                  filter: "blur(28px)",
                  mixBlendMode: isDark() ? "screen" : "multiply",
                  transform: drifts[i()].transform,
                }}
              />
            );
          }}
        </Each>
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, padding: 20, justifyContent: "flex-end", gap: 6 }}>
          <View
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 10,
              height: 24,
              borderRadius: 12,
              justifyContent: "center",
              backgroundColor: alpha("#ffffff", isDark() ? 0.12 : 0.55),
              borderWidth: 1,
              borderColor: alpha(ink(), 0.12),
            }}
          >
            <Text style={{ fontSize: 11, fontFamily: mono, color: ink() }}>4 × createMotion</Text>
          </View>
          <Text style={{ fontSize: 34, fontWeight: "700", letterSpacing: -0.8, color: ink() }}>Aurora</Text>
          <Text style={{ fontSize: 14, color: alpha(ink(), 0.7) }}>Each light drifts on its own loop, there and back</Text>
        </View>
      </View>
    </Card>
  );
}

// --- Easing -----------------------------------------------------------------

type Fn = (t: number) => number;
const out = (f: Fn): Fn => (t) => 1 - f(1 - t);
const inOut = (f: Fn): Fn => (t) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2);
const bezier = (x1: number, y1: number, x2: number, y2: number): Fn => {
  const b = (a: number, c: number, s: number) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * c + s * s * s;
  return (p) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (b(x1, x2, mid) < p) lo = mid;
      else hi = mid;
    }
    return b(y1, y2, (lo + hi) / 2);
  };
};
const bounce: Fn = (t) => {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) return 7.5625 * (t - 1.5 / 2.75) ** 2 + 0.75;
  if (t < 2.5 / 2.75) return 7.5625 * (t - 2.25 / 2.75) ** 2 + 0.9375;
  return 7.5625 * (t - 2.625 / 2.75) ** 2 + 0.984375;
};
const back: Fn = (t) => t * t * (2.70158 * t - 1.70158);
const elastic: Fn = (t) => 1 - Math.cos((t * Math.PI) / 2) ** 3 * Math.cos(t * Math.PI);

/** The curves, with a JS copy of each only to draw it (the animation uses the native one). */
const curves: { name: string; easing: Easing; f: Fn }[] = [
  { name: "linear", easing: Easing.linear, f: (t) => t },
  { name: "ease", easing: Easing.ease, f: bezier(0.25, 0.1, 0.25, 1) },
  { name: "quad out", easing: Easing.out(Easing.quad), f: out((t) => t * t) },
  { name: "cubic inOut", easing: Easing.inOut(Easing.cubic), f: inOut((t) => t ** 3) },
  { name: "sin in", easing: Easing.sin, f: (t) => 1 - Math.cos((t * Math.PI) / 2) },
  { name: "circle out", easing: Easing.out(Easing.circle), f: out((t) => 1 - Math.sqrt(Math.max(0, 1 - t * t))) },
  { name: "exp inOut", easing: Easing.inOut(Easing.exp), f: inOut((t) => 2 ** (10 * (t - 1))) },
  { name: "back out", easing: Easing.out(Easing.back()), f: out(back) },
  { name: "elastic out", easing: Easing.out(Easing.elastic(1)), f: out(elastic) },
  { name: "bounce out", easing: Easing.out(Easing.bounce), f: out(bounce) },
];

/** Diagonal hatching inside a rectangle. */
function hatch(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  cx.save();
  cx.beginPath();
  cx.rect(x, y, w, h);
  cx.clip();
  cx.strokeStyle = alpha(colors.text, 0.06);
  cx.lineWidth = 1;
  cx.beginPath();
  for (let i = -h; i < w; i += 7) {
    cx.moveTo(x + i, y + h);
    cx.lineTo(x + i + h, y);
  }
  cx.stroke();
  cx.restore();
}

/** One curve plotted, with a dot that rides it: x runs linearly, y with the curve, both native. */
function EasingPlot() {
  const selected = signal(curves.length - 3);
  const px = createAnimatedValue(0);
  const py = createAnimatedValue(0);
  let running: CompositeAnimation | undefined;
  const play = () => {
    running?.stop();
    px.set(0);
    py.set(0);
    const c = curves[selected()];
    running = Animated.sequence([
      Animated.delay(120),
      Animated.parallel([
        Animated.timing(px, { toValue: 1, duration: 1100, easing: Easing.linear }),
        Animated.timing(py, { toValue: 1, duration: 1100, easing: c.easing }),
      ]),
    ]);
    running.start();
  };
  const lo = -0.18;
  const hi = 1.24;
  return (
    <Card icon="spark" title="Easing" subtitle="Curves are data, evaluated natively">
      <Canvas
        style={{ height: 196 }}
        draw={(cx, { width, height }) => {
          const l = 30;
          const r = width - 12;
          const t = 8;
          const b = height - 8;
          const y = (v: number) => b - ((v - lo) / (hi - lo)) * (b - t);
          const x = (v: number) => l + v * (r - l);
          // Zones outside 0..1: where a curve overshoots.
          hatch(cx, l, t, r - l, y(1) - t);
          hatch(cx, l, y(0), r - l, b - y(0));
          cx.strokeStyle = colors.line;
          cx.lineWidth = 1;
          for (const q of [0.25, 0.5, 0.75]) {
            cx.beginPath();
            cx.moveTo(x(q), t);
            cx.lineTo(x(q), b);
            cx.stroke();
          }
          cx.setLineDash([3, 4]);
          cx.strokeStyle = colors.faint;
          for (const v of [0, 1]) {
            cx.beginPath();
            cx.moveTo(l, y(v));
            cx.lineTo(r, y(v));
            cx.stroke();
          }
          cx.setLineDash([]);
          cx.font = "11px system-ui";
          cx.fillStyle = colors.faint;
          cx.textBaseline = "middle";
          cx.fillText("1.0", 2, y(1));
          cx.fillText("0", 2, y(0));
          // The curve, filled faintly beneath.
          const f = curves[selected()].f;
          const n = 96;
          cx.beginPath();
          cx.moveTo(x(0), y(0));
          for (let i = 0; i <= n; i++) cx.lineTo(x(i / n), y(f(i / n)));
          cx.lineTo(x(1), y(0));
          cx.closePath();
          cx.fillStyle = tints.accent;
          cx.globalAlpha = 0.6;
          cx.fill();
          cx.globalAlpha = 1;
          cx.beginPath();
          cx.moveTo(x(0), y(f(0)));
          for (let i = 1; i <= n; i++) cx.lineTo(x(i / n), y(f(i / n)));
          cx.strokeStyle = colors.accent;
          cx.lineWidth = 2;
          cx.lineJoin = "round";
          cx.stroke();
          // The playhead and the dot, from animated values.
          const hx = px.mul(r - l).add(l);
          const hy = py.mul(-(b - t) / (hi - lo)).add(b + (lo * (b - t)) / (hi - lo));
          cx.strokeStyle = alpha(colors.text, 0.22);
          cx.lineWidth = 1;
          cx.beginPath();
          cx.moveTo(hx, t);
          cx.lineTo(hx, b);
          cx.stroke();
          cx.beginPath();
          cx.moveTo(l, hy);
          cx.lineTo(hx, hy);
          cx.setLineDash([2, 3]);
          cx.stroke();
          cx.setLineDash([]);
          cx.fillStyle = colors.light;
          cx.beginPath();
          cx.arc(hx, hy, 5, 0, Math.PI * 2);
          cx.fill();
          cx.strokeStyle = colors.accent;
          cx.beginPath();
          cx.arc(hx, hy, 9, 0, Math.PI * 2);
          cx.stroke();
          cx.fillStyle = colors.accent;
          cx.beginPath();
          cx.arc(l, hy, 3.5, 0, Math.PI * 2);
          cx.fill();
        }}
      />
      <Scroll horizontal scrollbar={false}>
        <Tabs style={{ flexDirection: "row", gap: 8 }}>
          <Each of={curves}>
            {(c, i) => (
              <Chip
                label={c().name}
                active={selected() === i()}
                onPress={() => {
                  selected.set(i());
                  play();
                }}
              />
            )}
          </Each>
        </Tabs>
      </Scroll>
      <Button label="Play" icon="play" onPress={play} />
    </Card>
  );
}

/** Every curve at once: ten timings in one `Animated.parallel`. */
function EasingRace() {
  const dots = curves.map(() => createAnimatedValue(0));
  const [width, measure] = useWidth();
  const there = signal(false);
  const play = () => {
    there.set(!there());
    Animated.parallel(dots.map((d, i) => Animated.timing(d, { toValue: there() ? 1 : 0, duration: 1200, easing: curves[i].easing }))).start();
  };
  return (
    <Card icon="lists" title="Side by side" subtitle="Ten timings started together" right={<Badge label="1.2 s" />}>
      <View style={{ gap: 2 }}>
        <Each of={curves}>
          {(c, i) => (
            <View style={{ flexDirection: "row", alignItems: "center", height: 26, gap: 10 }}>
              <Text numberOfLines={1} style={{ width: 84, fontSize: 13, color: colors.muted }}>
                {c().name}
              </Text>
              <View onLayout={i() === 0 ? measure : undefined} style={{ flex: 1, height: 12, justifyContent: "center" }}>
                <View style={{ height: 2, borderRadius: 1, backgroundColor: colors.raised }} />
                <View
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: tones()[i() % tones().length],
                    ...finish.knob,
                    transform: [{ translateX: dots[i()].mul(Math.max(0, width() - 12)) }],
                  }}
                />
              </View>
            </View>
          )}
        </Each>
      </View>
      <Api label="One group, one start" api="Animated.parallel" />
      <Button label={there() ? "Reverse" : "Play"} variant="secondary" icon="play" onPress={play} />
    </Card>
  );
}

/** A selectable capsule, a tab of the curves (36 pt, with hit slop up to 44). */
function Chip(props: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Tab selected={props.active} onPress={props.onPress} style={tabPress.style} activeStyle={tabPress.activeStyle}>
      <View
        style={{
          height: 36,
          paddingHorizontal: 14,
          borderRadius: 18,
          justifyContent: "center",
          backgroundColor: props.active ? colors.light : colors.raised,
          ...(props.active ? finish.light : finish.raised),
          borderWidth: props.active ? 0 : 1,
          borderColor: colors.border,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "500", color: props.active ? colors.onLight : colors.text }}>{props.label}</Text>
      </View>
    </Tab>
  );
}

// --- Composition -------------------------------------------------------------

/** sequence, parallel, stagger and loop, with stop and reset. */
function Composition() {
  const ys = tones().map(() => createAnimatedValue(0));
  const spin = createAnimatedValue(0);
  const fade = createAnimatedValue(1);
  const state = signal<{ label: string; tone: "neutral" | "accent" | "warn" | "info" }>({ label: "idle", tone: "neutral" });

  const stagger = Animated.stagger(
    70,
    ys.map((y) =>
      Animated.sequence([
        Animated.timing(y, { toValue: -46, duration: 220, easing: Easing.out(Easing.quad) }),
        Animated.spring(y, { toValue: 0, stiffness: 320, damping: 11 }),
      ]),
    ),
  );
  const sequence = Animated.sequence([
    Animated.timing(spin, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.cubic) }),
    Animated.delay(200),
    Animated.parallel([
      Animated.timing(fade, { toValue: 0.25, duration: 300 }),
      Animated.timing(spin, { toValue: 0, duration: 640, easing: Easing.out(Easing.back()) }),
    ]),
    Animated.timing(fade, { toValue: 1, duration: 300 }),
  ]);
  const pulse = Animated.loop(
    Animated.sequence([
      Animated.timing(fade, { toValue: 0.3, duration: 420, easing: Easing.inOut(Easing.sin) }),
      Animated.timing(fade, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.sin) }),
    ]),
  );
  const all = [stagger, sequence, pulse];
  cleanup(() => all.forEach((a) => a.stop()));
  const run = (name: string, a: CompositeAnimation) => () => {
    state.set({ label: `${name} running`, tone: "info" });
    a.start().then((finished) => state.set({ label: `${name} ${finished ? "finished" : "stopped"}`, tone: finished ? "accent" : "warn" }));
  };
  return (
    <Card icon="components" title="Composition" subtitle="Each step starts as the last one ends" right={<Badge label={state().label} tone={state().tone} />}>
      <View style={{ height: 116, flexDirection: "row", justifyContent: "center", alignItems: "flex-end", gap: 12, paddingBottom: 14 }}>
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 14, borderTopWidth: 1, borderColor: colors.border, borderStyle: "dashed" }}
        />
        <Each of={tones()}>
          {(color, i) => (
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                borderCurve: "continuous",
                backgroundColor: color(),
                ...finish.knob,
                opacity: fade,
                transform: [
                  { translateY: ys[i()] },
                  { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${(i() + 1) * 36}deg`] }) },
                ],
              }}
            />
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label="Stagger" variant="secondary" onPress={run("stagger", stagger)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Sequence" variant="secondary" onPress={run("sequence", sequence)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Loop" variant="secondary" onPress={run("loop", pulse)} />
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label="Stop" variant="ghost" icon="pause" onPress={() => all.forEach((a) => a.stop())} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Reset" variant="ghost" onPress={() => all.forEach((a) => a.reset())} />
        </View>
      </View>
    </Card>
  );
}

// --- Springs ----------------------------------------------------------------

const springs: { label: string; stiffness: number; damping: number; tone: keyof Palette }[] = [
  { label: "Gentle", stiffness: 120, damping: 14, tone: "info" },
  { label: "Wobbly", stiffness: 180, damping: 8, tone: "warn" },
  { label: "Stiff", stiffness: 400, damping: 30, tone: "accent" },
];
const SPRING_MS = 1800;

/** The response of a unit spring from 0 to 1 (mass 1), sampled. */
function response(stiffness: number, damping: number, n: number) {
  const out: number[] = [];
  let x = -1;
  let v = 0;
  const dt = 1 / 600;
  const per = SPRING_MS / 1000 / n;
  let next = 0;
  for (let t = 0; out.length <= n; t += dt) {
    if (t >= next) {
      out.push(1 + x);
      next += per;
    }
    v += (-stiffness * x - damping * v) * dt;
    x += v * dt;
  }
  return out;
}

/** Springs with different settings, released together; the plot's dots are the springs themselves. */
function Springs() {
  const xs = springs.map(() => createAnimatedValue(0));
  const clock = createAnimatedValue(0);
  const [width, measure] = useWidth();
  const there = signal(false);
  const play = () => {
    there.set(!there());
    const w = Math.max(1, width() - 28);
    clock.set(0);
    Animated.parallel([
      Animated.timing(clock, { toValue: 1, duration: SPRING_MS, easing: Easing.linear }),
      ...xs.map((x, i) => Animated.spring(x, { toValue: there() ? w : 0, stiffness: springs[i].stiffness, damping: springs[i].damping })),
    ]).start();
  };
  return (
    <Card icon="physics" title="Springs" subtitle="Stiffness and damping, mass 1">
      <Canvas
        style={{ height: 150 }}
        draw={(cx, { width: cw, height }) => {
          const l = 4;
          const r = cw - 4;
          const t = 10;
          const b = height - 10;
          const y = (v: number) => b - (v / 1.5) * (b - t);
          // A dot matrix behind, then the target.
          cx.fillStyle = colors.line;
          for (let gx = l; gx <= r; gx += 12) for (let gy = t; gy <= b; gy += 12) cx.fillRect(gx, gy, 1.5, 1.5);
          cx.setLineDash([3, 4]);
          cx.strokeStyle = colors.faint;
          cx.beginPath();
          cx.moveTo(l, y(1));
          cx.lineTo(r, y(1));
          cx.stroke();
          cx.setLineDash([]);
          const n = 120;
          const w = Math.max(1, width() - 28);
          const fromEnd = !there();
          springs.forEach((s, i) => {
            const pts = response(s.stiffness, s.damping, n);
            cx.strokeStyle = colors[s.tone];
            cx.lineWidth = 1.75;
            cx.beginPath();
            pts.forEach((p, k) => {
              const v = fromEnd ? 1 - p : p;
              const px = l + (k / n) * (r - l);
              if (k === 0) cx.moveTo(px, y(v));
              else cx.lineTo(px, y(v));
            });
            cx.stroke();
            // The live spring value, at the clock's x.
            cx.fillStyle = colors[s.tone];
            cx.beginPath();
            cx.arc(clock.mul(r - l).add(l), xs[i].div(w).mul(-(b - t) / 1.5).add(b), 4, 0, Math.PI * 2);
            cx.fill();
          });
        }}
      />
      <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
        <Each of={springs}>{(s) => <Legend color={colors[s().tone]} label={s().label} value={`${s().stiffness} / ${s().damping}`} />}</Each>
      </View>
      <View style={{ gap: 8 }}>
        <Each of={springs}>
          {(s, i) => (
            <View onLayout={i() === 0 ? measure : undefined} style={{ height: 28, justifyContent: "center", borderRadius: 14, backgroundColor: colors.background, ...finish.track }}>
              <View
                style={{
                  position: "absolute",
                  left: 2,
                  top: 2,
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: colors[s().tone],
                  ...finish.knob,
                  transform: [{ translateX: xs[i()] }],
                }}
              />
            </View>
          )}
        </Each>
      </View>
      <Button label="Release" onPress={play} />
    </Card>
  );
}

// --- Interpolation ----------------------------------------------------------

/** A dial's ticks and labels, drawn once. */
function DialFace(props: { size: number }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx, { width }) => {
        const c = width / 2;
        for (let i = 0; i <= 40; i++) {
          const a = ((-120 + i * 6) * Math.PI) / 180 - Math.PI / 2;
          const major = i % 10 === 0;
          const r0 = c - (major ? 12 : 7);
          cx.strokeStyle = major ? colors.muted : colors.border;
          cx.lineWidth = major ? 1.5 : 1;
          cx.beginPath();
          cx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
          cx.lineTo(c + Math.cos(a) * (c - 2), c + Math.sin(a) * (c - 2));
          cx.stroke();
        }
        cx.font = "11px system-ui";
        cx.fillStyle = colors.faint;
        cx.textAlign = "center";
        cx.textBaseline = "middle";
        ["0", "1", "2"].forEach((label, i) => {
          const a = ((-120 + i * 120) * Math.PI) / 180 - Math.PI / 2;
          cx.fillText(label, c + Math.cos(a) * (c - 24), c + Math.sin(a) * (c - 24));
        });
      }}
    />
  );
}

/** Colors, angles and scales from one value; outside the range they extend or clamp. */
function Interpolations() {
  const t = createAnimatedValue(0);
  const at = signal<"0" | "1" | "2">("0");
  const go = (to: "0" | "1" | "2") => {
    at.set(to);
    t.spring(Number(to), { stiffness: 140, damping: 16 });
  };
  const D = 128;
  return (
    <Card icon="styles" title="Interpolation" subtitle="One value drives color, angle and scale" right={<Badge label={`t = ${at()}`} tone="accent" />}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ width: D, height: D }}>
          <DialFace size={D} />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: D / 2 - 1.5,
              top: 14,
              width: 3,
              height: D - 28,
              transform: [{ rotate: t.interpolate({ inputRange: [0, 2], outputRange: ["-120deg", "120deg"] }) }],
            }}
          >
            <View style={{ height: D / 2 - 22, borderRadius: 1.5, backgroundColor: colors.accent }} />
          </View>
          <View style={{ position: "absolute", left: D / 2 - 6, top: D / 2 - 6, width: 12, height: 12, borderRadius: 6, backgroundColor: colors.light, ...finish.light }} />
        </View>
        <View style={{ alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              borderCurve: "continuous",
              backgroundColor: t.interpolate({ inputRange: [0, 1, 2], outputRange: [colors.info, colors.accent, colors.danger] }),
              transform: [{ rotate: t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"], extrapolateRight: "extend" }) }],
            }}
          />
          <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint }}>extend</Text>
        </View>
        <View style={{ alignItems: "center", gap: 8 }}>
          <View style={{ width: 64, height: 64, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 26,
                backgroundColor: colors.up,
                transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.2], extrapolate: "clamp" }) }],
              }}
            />
          </View>
          <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint }}>clamp</Text>
        </View>
      </View>
      <Segmented
        options={[
          { value: "0", label: "t = 0" },
          { value: "1", label: "t = 1" },
          { value: "2", label: "t = 2" },
        ]}
        value={at()}
        onChange={go}
      />
      <View style={{ gap: 6 }}>
        <Caption label="Color through three stops" note="at 0, 1 and 2" />
        <Caption label="Rotation keeps going past 1" note="360° at 2" />
        <Caption label="Scale stops at 1.2" note="clamp" />
      </View>
    </Card>
  );
}

// --- diffClamp --------------------------------------------------------------

/** A header that hides while the list scrolls up and comes back as it
 * scrolls down: `diffClamp` of the scroll offset, natively. */
function HidingHeader() {
  const scroll = createAnimatedValue(0);
  const H = 52;
  const header = scroll.diffClamp(0, H);
  return (
    <Card icon="scroll" title="Hiding header" subtitle="Hides as the list scrolls up, returns as it scrolls down">
      <View style={{ height: 300, borderRadius: radius.control, overflow: "hidden", backgroundColor: colors.background, ...finish.track }}>
        <Scroll style={{ flex: 1 }} scrollValue={scroll}>
          <View style={{ paddingTop: H + 8, paddingHorizontal: 8, paddingBottom: 8, gap: 6 }}>
            <Each of={Array.from({ length: 30 }, (_, i) => i + 1)}>
              {(n) => (
                <View
                  style={{
                    height: 48,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.line,
                  }}
                >
                  <Text style={{ width: 24, fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(n()).padStart(2, "0")}</Text>
                  <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>Row {n()}</Text>
                  <View style={{ width: 40 + ((n() * 37) % 50), height: 4, borderRadius: 2, backgroundColor: n() % 3 === 0 ? colors.accent : colors.raised }} />
                </View>
              )}
            </Each>
          </View>
        </Scroll>
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: H,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 14,
            backgroundColor: colors.raised,
            ...finish.raised,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            transform: [{ translateY: header.mul(-1) }],
            opacity: header.interpolate({ inputRange: [0, H], outputRange: [1, 0], easing: Easing.in(Easing.quad) }),
          }}
        >
          <Icon name="search" size={16} tint={colors.muted} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>Search</Text>
          <Text style={{ fontSize: 12, fontFamily: mono, color: colors.faint }}>diffClamp(0, {H})</Text>
        </View>
      </View>
    </Card>
  );
}

// --- Layout animation -------------------------------------------------------

const presets: Record<"spring" | "ease" | "linear", LayoutAnimationConfig> = {
  spring: LayoutAnimation.Presets.spring,
  ease: LayoutAnimation.Presets.easeInEaseOut,
  linear: LayoutAnimation.Presets.linear,
};

/** Layout changes animated natively by the next commit: moves, inserts and removals. */
function Layout() {
  const column = signal(false);
  const preset = signal<keyof typeof presets>("spring");
  let next = 6;
  const items = signal([1, 2, 3, 4, 5]);
  const change = (fn: () => void) => {
    LayoutAnimation.configureNext(preset() === "spring" ? LayoutAnimation.create(420, "spring") : presets[preset()]);
    fn();
  };
  return (
    <Card icon="mobile" title="Layout animation" subtitle="Frames, inserts and removals of the next commit" right={<Badge label={`${items().length} views`} />}>
      <Segmented
        size="small"
        options={[
          { value: "spring", label: "Spring" },
          { value: "ease", label: "Ease in out" },
          { value: "linear", label: "Linear" },
        ]}
        value={preset()}
        onChange={(v) => preset.set(v)}
      />
      <View style={{ minHeight: 64, flexDirection: column() ? "column" : "row", flexWrap: "wrap", gap: 8 }}>
        <Each of={items()}>
          {(id) => (
            <View
              style={{
                height: column() ? 30 : 64,
                width: column() ? undefined : 50,
                flexGrow: column() ? 0 : 1,
                borderRadius: 12,
                borderCurve: "continuous",
                paddingHorizontal: 10,
                justifyContent: "center",
                backgroundColor: tones()[id() % tones().length],
                ...finish.knob,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: onTone(), fontVariant: ["tabular-nums"] }}>{id()}</Text>
            </View>
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label={column() ? "Row" : "Column"} onPress={() => change(() => column.set(!column()))} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label="Shuffle"
            variant="secondary"
            onPress={() => change(() => items.set([...items()].sort(() => Math.random() - 0.5)))}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label="Add" variant="secondary" icon="plus" disabled={items().length >= 8} onPress={() => change(() => items.set([...items(), next++]))} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Remove" variant="ghost" disabled={items().length <= 1} onPress={() => change(() => items.set(items().slice(1)))} />
        </View>
      </View>
    </Card>
  );
}

export function Animations() {
  return <DemoPage cards={[Hero, MotionPresets, StaggeredEntrance, Keyframes, Aurora, EasingPlot, EasingRace, Composition, Springs, Interpolations, HidingHeader, Layout]} />;
}
