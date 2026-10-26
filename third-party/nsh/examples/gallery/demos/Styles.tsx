import { cleanup, Image, type JSX, List, Scroll, signal, Text, View, type ViewStyle } from "nsh";
import { Animated, createAnimatedValue, Easing } from "nsh";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, finish, hint, isDark, mono, Press, radius, Segmented, tints, Toggle } from "../ui";

/** The stage every specimen stands on: the card's light, without its drop shadow. */
const stage = () => ({
  height: 104,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: radius.control,
  borderCurve: "continuous",
  backgroundColor: colors.surface,
  borderWidth: 1,
  borderColor: colors.line,
  backgroundImage: finish.card.backgroundImage,
  boxShadow: isDark() ? "inset 0 1px 0 rgba(255,255,255,0.05)" : "inset 0 1px 0 #ffffff",
}) as const;

/** A specimen box: a raised surface the styles are tried on. */
const box = () =>
  ({
    width: 112,
    height: 76,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.raised,
  }) as const;

function Label(props: { children: string; color?: string }) {
  return <Text style={{ fontSize: 13, fontWeight: "600", color: props.color ?? colors.text }}>{props.children}</Text>;
}

/**
 * One cell of a two-column grid: the specimen on a stage, a label, the
 * style it shows (`code`, monospaced) and a plain note.
 */
function Tile(props: { label: string; code?: string; note?: string; onPress?: () => void; children: JSX.Element }) {
  return (
    <View style={{ flexBasis: "40%", flexGrow: 1, gap: 8 }}>
      <View onPress={props.onPress} style={stage()}>
        {props.children}
      </View>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text }}>{props.label}</Text>
        <If when={props.code}>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.muted, fontFamily: mono }}>
            {props.code}
          </Text>
        </If>
        <If when={props.note}>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>
            {props.note}
          </Text>
        </If>
      </View>
    </View>
  );
}

function Grid(props: { children: JSX.Element }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 16 }}>{props.children}</View>;
}

/** Circular and continuous corners side by side, at the same radius. */
function Corners() {
  const shapes: { label: string; style: () => ViewStyle }[] = [
    { label: "Circular", style: () => ({ width: 60, height: 60, borderRadius: 20, backgroundColor: colors.info }) },
    { label: "Continuous", style: () => ({ width: 60, height: 60, borderRadius: 20, borderCurve: "continuous", backgroundColor: colors.info }) },
    {
      label: "One corner",
      style: () => ({ width: 60, height: 60, borderRadius: 20, borderCurve: "continuous", borderWidth: 2.5, borderColor: colors.accent, borderTopLeftRadius: 4 }),
    },
    { label: "Pill", style: () => ({ width: 60, height: 28, borderRadius: 14, borderCurve: "continuous", backgroundColor: colors.up }) },
  ];
  return (
    <Card icon="styles" title="Corners" subtitle="borderRadius · borderCurve · per corner">
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Each of={shapes}>
          {(shape) => (
            <View style={{ alignItems: "center", gap: 10 }}>
              <View style={{ height: 64, justifyContent: "center" }}>
                <View style={shape().style()} />
              </View>
              <Text style={{ fontSize: 12, color: colors.muted }}>{shape().label}</Text>
            </View>
          )}
        </Each>
      </View>
      <Caption label="Continuous corners ease into the edges" note="Radius 20 pt" />
      <Grid>
        <Tile label="Top corners" code="borderTop*Radius" note="28 pt">
          <View style={{ ...box(), borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1.5, borderColor: colors.accent }}>
            <Label color={colors.accent}>28 pt</Label>
          </View>
        </Tile>
        <Tile label="Mixed radii" note="44 · 6 · 28 · 0 pt, clockwise">
          <View
            style={{
              ...box(),
              backgroundColor: tints.info,
              borderTopLeftRadius: 44,
              borderTopRightRadius: 6,
              borderBottomRightRadius: 28,
              borderWidth: 2,
              borderColor: colors.info,
            }}
          >
            <Label color={colors.info}>Mixed</Label>
          </View>
        </Tile>
      </Grid>
    </Card>
  );
}

function Borders() {
  return (
    <Card icon="components" title="Borders" subtitle="per side · dashed · dotted">
      <Grid>
        <Tile label="Per-side borders" note="6 · 2 · 4 · 1 pt, clockwise">
          <View
            style={{
              ...box(),
              borderTopWidth: 6,
              borderTopColor: colors.danger,
              borderRightWidth: 2,
              borderRightColor: colors.up,
              borderBottomWidth: 4,
              borderBottomColor: colors.info,
              borderLeftWidth: 1,
              borderLeftColor: colors.warn,
            }}
          />
        </Tile>
        <Tile label="Dashed / dotted" code="borderStyle">
          <View style={{ gap: 8 }}>
            <View style={{ width: 112, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: colors.info, borderStyle: "dashed" }} />
            <View style={{ width: 112, height: 28, borderRadius: 8, borderWidth: 3, borderColor: colors.warn, borderStyle: "dotted" }} />
          </View>
        </Tile>
      </Grid>
    </Card>
  );
}

/** Shadows that read on a dark page: colored glows rather than black. */
function Shadows() {
  return (
    <Card icon="spark" title="Shadows and glow" subtitle="shadowColor · elevation · text shadow">
      <Grid>
        <Tile label="Glow" code="shadowColor" note="A colored shadow">
          <View
            style={{
              ...box(),
              borderRadius: 16,
              borderCurve: "continuous",
              backgroundColor: colors.accentFill,
              shadowColor: colors.accentFill,
              shadowOpacity: 0.55,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 6 },
            }}
          >
            <Label color={colors.onAccent}>Glow</Label>
          </View>
        </Tile>
        <Tile label="Offset shadow" code="shadowOffset" note="4, 8 pt · radius 10">
          <View
            style={{
              ...box(),
              backgroundColor: isDark() ? "#1d2740" : "#e7edfb",
              borderTopLeftRadius: 30,
              borderBottomRightRadius: 30,
              borderWidth: 1,
              borderColor: colors.info,
              shadowColor: colors.info,
              shadowOpacity: 0.45,
              shadowRadius: 10,
              shadowOffset: { width: 4, height: 8 },
            }}
          >
            <Label color={colors.info}>Offset</Label>
          </View>
        </Tile>
        <Tile label="Image corners" note="Two radii and a shadow">
          <Image
            src="https://picsum.photos/seed/nsh/300/220"
            style={{
              width: 112,
              height: 76,
              borderTopLeftRadius: 28,
              borderBottomRightRadius: 28,
              backgroundColor: colors.raised,
              shadowColor: "#000000",
              shadowOpacity: isDark() ? 0.6 : 0.22,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 8 },
            }}
          />
        </Tile>
        <Tile label="Text shadow" note="Shadow of the content">
          <View style={{ ...box(), backgroundColor: "transparent", shadowColor: colors.danger, shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } }}>
            <Text style={{ fontSize: 24, fontWeight: "800", color: colors.text, letterSpacing: -0.5 }}>Shadow</Text>
          </View>
        </Tile>
        <Tile label="Text corners" note="Radii on a Text">
          <Text
            style={{
              fontSize: 15,
              fontWeight: "600",
              color: colors.up,
              backgroundColor: tints.up,
              borderTopLeftRadius: 14,
              borderBottomRightRadius: 14,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            Text corners
          </Text>
        </Tile>
        <Tile label="Elevation" code="elevation: 10" note="Android">
          <View android={{ elevation: 10 }} style={{ ...box(), borderRadius: 16, backgroundColor: colors.raised, shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 6 } }}>
            <Label>Elevation</Label>
          </View>
        </Tile>
      </Grid>
    </Card>
  );
}

/** Clipping, stacking order and opacity, each one tap away. */
function Layers() {
  const clip = signal(true);
  const front = signal(0);
  const opacity = createAnimatedValue(0.45);
  const level = signal<"0.2" | "0.45" | "1">("0.45");
  const stack = ["danger", "info", "up"] as const;
  return (
    <Card icon="lists" title="Clipping and layers" subtitle="overflow · zIndex · opacity" right={<Toggle value={clip()} onChange={(v) => clip.set(v)} label="Clip" />}>
      <Grid>
        <Tile label={clip() ? "Clipped" : "Visible"} code={`overflow: ${clip() ? "hidden" : "visible"}`} note={hint("Tap to switch", "Click to switch")} onPress={() => clip.set(!clip())}>
          <View
            style={{
              ...box(),
              backgroundColor: tints.warn,
              borderRadius: 22,
              borderWidth: 1.5,
              borderColor: colors.warn,
              overflow: clip() ? "hidden" : "visible",
            }}
          >
            <View style={{ position: "absolute", left: -26, top: -26, width: 72, height: 72, borderRadius: 36, backgroundColor: colors.danger }} />
            <Label color={colors.warn}>{hint("Tap", "Click")}</Label>
          </View>
        </Tile>
        <Tile label="Stacking order" code="zIndex" note={`Front: ${front() + 1} of 3 · tap`} onPress={() => front.set((front() + 1) % 3)}>
          <View style={{ width: 130, height: 84 }}>
            <Each of={stack}>
              {(color, i) => (
                <View
                  style={{
                    position: "absolute",
                    left: 4 + i() * 28,
                    top: 2 + i() * 14,
                    width: 64,
                    height: 52,
                    borderRadius: 12,
                    borderCurve: "continuous",
                    backgroundColor: colors[color()],
                    borderWidth: front() === i() ? 2 : 0,
                    borderColor: colors.text,
                    zIndex: front() === i() ? 10 : 0,
                    shadowColor: "#000000",
                    shadowOpacity: isDark() ? 0.5 : 0.18,
                    shadowRadius: 6,
                    shadowOffset: { width: 0, height: 3 },
                  }}
                />
              )}
            </Each>
          </View>
        </Tile>
      </Grid>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ width: 64, height: 64, borderRadius: 14, borderCurve: "continuous", backgroundColor: colors.info, opacity, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: isDark() ? "#0c1020" : "#ffffff", fontVariant: ["tabular-nums"] }}>{level()}</Text>
        </View>
        <View style={{ flex: 1, gap: 8 }}>
          <Caption label="Opacity" note="Animated natively" />
          <Segmented
            options={[
              { value: "0.2", label: "0.2" },
              { value: "0.45", label: "0.45" },
              { value: "1", label: "1" },
            ]}
            value={level()}
            onChange={(v) => {
              level.set(v);
              opacity.timing(Number(v), { duration: 260, easing: Easing.out(Easing.cubic) });
            }}
          />
        </View>
      </View>
    </Card>
  );
}

/** Two faces back to back: each hides while turned away. */
function FlipCard() {
  const angle = createAnimatedValue(0);
  const flipped = signal(false);
  const flip = () => {
    flipped.set(!flipped());
    angle.spring(flipped() ? 180 : 0, { stiffness: 140, damping: 16 });
  };
  const face = {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    borderRadius: radius.card,
    borderCurve: "continuous",
    borderWidth: 1,
    padding: 16,
    justifyContent: "space-between",
    backfaceVisibility: "hidden",
  } as const;
  return (
    <Press onPress={flip} scale={0.98} accessibilityLabel="Flip the card">
      <View style={{ height: 132 }}>
        <View
          style={{
            ...face,
            ...(isDark()
              ? {
                  backgroundColor: "#1a2134",
                  backgroundImage: "linear-gradient(180deg, #1e263b 0%, #1a2134 100%)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 10px 24px rgba(0,0,0,0.4)",
                  borderColor: "#2b3a5c",
                }
              : {
                  backgroundColor: "#eef2fc",
                  backgroundImage: "linear-gradient(180deg, #f0f4fd 0%, #ebf0fb 100%)",
                  boxShadow: "inset 0 1px 0 #ffffff, 0 8px 20px rgba(20,20,10,0.10)",
                  borderColor: "#cdd8f3",
                }),
            transform: [{ perspective: 800 }, { rotateY: angle }],
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Badge label="front" tone="info" />
            <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>0°</Text>
          </View>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 20, fontWeight: "600", color: colors.text }}>{hint("Tap to flip", "Click to flip")}</Text>
            <Text style={{ fontSize: 13, color: colors.muted }}>A spring turns it on the UI thread</Text>
          </View>
        </View>
        <View
          style={{
            ...face,
            ...(isDark()
              ? {
                  backgroundColor: "#202814",
                  backgroundImage: "linear-gradient(180deg, #242d16 0%, #1f2714 100%)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 10px 24px rgba(0,0,0,0.4)",
                  borderColor: "#3b4a22",
                }
              : {
                  backgroundColor: "#f1f7e2",
                  backgroundImage: "linear-gradient(180deg, #f2f8e4 0%, #eef5da 100%)",
                  boxShadow: "inset 0 1px 0 #ffffff, 0 8px 20px rgba(20,20,10,0.10)",
                  borderColor: "#d3e3a8",
                }),
            transform: [{ perspective: 800 }, { rotateY: angle.interpolate({ inputRange: [0, 180], outputRange: [180, 360] }) }],
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Badge label="back" tone="accent" />
            <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>180°</Text>
          </View>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 20, fontWeight: "600", color: colors.text }}>backfaceVisibility</Text>
            <Text style={{ fontSize: 13, color: colors.muted }}>hidden: each face hides while turned away</Text>
          </View>
        </View>
      </View>
    </Press>
  );
}

function Transforms() {
  // A slow native sway, so the perspective reads as depth.
  const sway = createAnimatedValue(-30);
  const loop = Animated.loop(
    Animated.sequence([
      Animated.timing(sway, { toValue: 30, duration: 2200, easing: Easing.inOut(Easing.sin) }),
      Animated.timing(sway, { toValue: -30, duration: 2200, easing: Easing.inOut(Easing.sin) }),
    ]),
  );
  loop.start();
  cleanup(() => loop.stop());
  return (
    <Card icon="physics" title="3D transforms" subtitle="perspective · rotateX/Y · skew · origin">
      <FlipCard />
      <Grid>
        <Tile label="Perspective" code="rotateY" note="Swaying, driven natively">
          <View style={{ ...box(), borderRadius: 14, backgroundColor: tints.info, borderWidth: 1, borderColor: colors.info, transform: [{ perspective: 400 }, { rotateY: sway }] }}>
            <Label color={colors.info}>Y axis</Label>
          </View>
        </Tile>
        <Tile label="Tilt" code="rotateX: 40deg">
          <View style={{ ...box(), borderRadius: 14, backgroundColor: tints.accent, borderWidth: 1, borderColor: colors.accent, transform: [{ perspective: 400 }, { rotateX: "40deg" }] }}>
            <Label color={colors.accent}>X axis</Label>
          </View>
        </Tile>
        <Tile label="Skew" code="skewX: -12deg" note="iOS">
          <View style={{ ...box(), borderRadius: 10, backgroundColor: tints.warn, borderWidth: 1, borderColor: colors.warn, transform: [{ skewX: "-12deg" }] }}>
            <Label color={colors.warn}>Skew</Label>
          </View>
        </Tile>
        <Tile label="Origin" code="transformOrigin" note="Top left · rotated 30°">
          <View style={{ width: 112, height: 84 }}>
            <View style={{ position: "absolute", left: 30, top: 14, width: 54, height: 54, borderRadius: 6, borderWidth: 1, borderColor: colors.faint, borderStyle: "dashed" }} />
            <View
              style={{
                position: "absolute",
                left: 30,
                top: 14,
                width: 54,
                height: 54,
                borderRadius: 6,
                backgroundColor: alpha(colors.danger, 0.55),
                transformOrigin: "top left",
                transform: [{ rotate: "30deg" }],
              }}
            />
            <View style={{ position: "absolute", left: 26, top: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.text }} />
          </View>
        </Tile>
      </Grid>
    </Card>
  );
}

function Numerals() {
  const figure = () => ({ fontSize: 22, color: colors.text, fontWeight: "500" }) as const;
  return (
    <Card icon="text" title="Numerals" subtitle="fontVariant">
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 12, color: colors.muted }}>Proportional</Text>
          <Text style={figure()}>1,111.11</Text>
          <Text style={figure()}>8,888.88</Text>
        </View>
        <View style={{ width: 1, backgroundColor: colors.line }} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 12, color: colors.accent, fontFamily: mono }}>tabular-nums</Text>
          <Text style={[figure(), { fontVariant: ["tabular-nums"] }]}>1,111.11</Text>
          <Text style={[figure(), { fontVariant: ["tabular-nums"] }]}>8,888.88</Text>
        </View>
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <Caption label={<Text style={{ fontSize: 18, color: colors.text, fontVariant: ["small-caps"] }}>Small Caps</Text>} note={<Text style={{ fontFamily: mono }}>small-caps</Text>} />
      <Caption label={<Text style={{ fontSize: 18, color: colors.text, fontVariant: ["oldstyle-nums"] }}>Oldstyle 1234567890</Text>} note={<Text style={{ fontFamily: mono }}>oldstyle-nums</Text>} />
    </Card>
  );
}

/** Rows, `marginStart` and text under a right-to-left layout: the app's
 * language decides it, and `direction` sets a view's own. */
function RightToLeft() {
  const rtl = signal(false);
  const tones = ["danger", "info", "up"] as const;
  const chip = { width: 40, height: 40, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" } as const;
  return (
    <Card
      icon="nav"
      title="Right to left"
      subtitle={rtl() ? "direction: rtl" : "direction: ltr"}
      right={<Button label="Flip" variant="secondary" onPress={() => rtl.set(!rtl())} />}
    >
      <View style={{ direction: rtl() ? "rtl" : "ltr", gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Each of={["1", "2", "3"]}>
          {(n, i) => (
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors[tones[i()]],
                marginStart: i() === 0 ? 16 : 0,
                borderTopStartRadius: 22,
              }}
            >
              <Text style={{ color: isDark() ? "#0c0d0f" : "#ffffff", fontWeight: "700", fontSize: 15 }}>{n()}</Text>
            </View>
          )}
        </Each>
      </View>
      <Text style={{ fontSize: 15, lineHeight: 21, color: colors.text }}>
        Text aligns to the start side; the first box has marginStart 16 and a round top-start corner.
      </Text>
      <Caption label="Horizontal scroll view" note={<Text style={{ fontFamily: mono }}>Scroll</Text>} />
      <Scroll horizontal scrollbar={false} style={{ height: 40 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Each of={Array.from({ length: 12 }, (_, i) => i + 1)}>
            {(n) => (
              <View style={{ ...chip, backgroundColor: tints.info }}>
                <Text style={{ fontSize: 13, color: colors.info, fontVariant: ["tabular-nums"] }}>{String(n())}</Text>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <Caption label="Horizontal list" note={<Text style={{ fontFamily: mono }}>List</Text>} />
      <List each={Array.from({ length: 30 }, (_, i) => i + 1)} horizontal estimatedItemSize={46} scrollbar={false} style={{ height: 40 }}>
        {(n) => (
          <View style={{ ...chip, marginEnd: 6, backgroundColor: tints.accent }}>
            <Text style={{ fontSize: 13, color: colors.accent, fontVariant: ["tabular-nums"] }}>{String(n())}</Text>
          </View>
        )}
      </List>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <Text style={{ fontSize: 13, textAlign: "left", color: colors.muted }}>textAlign left (the start side right to left)</Text>
      <Text style={{ fontSize: 13, writingDirection: "rtl", color: colors.muted }}>مرحبا بالعالم — writingDirection rtl</Text>
      </View>
    </Card>
  );
}

export function Styles() {
  const sections = [Corners, Borders, Shadows, Layers, Transforms, Numerals, RightToLeft];
  return <DemoPage cards={sections} />;
}
