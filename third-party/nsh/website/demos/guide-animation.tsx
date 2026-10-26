import { mount, signal, Text, View } from "nsh";
import { reduceMotion } from "nsh";
import { Animated, createAnimatedValue, Easing, LayoutAnimation } from "nsh";
import { button, buttonText, desktop, focusRing, Inspector, Panel, size, Stage, ui, wide } from "./palette";

const TRACK = 250;
// Read when they render, so they follow the theme.
const palette = () => [ui().down, ui().warn, ui().accent, ui().up, ui().info];
const SWATCHES = 5;

function Chip(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button()}>
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

function App() {
  // 1. A style transition: change the style, the platform animates it.
  const on = signal(false);

  // 2. Animated values: timing and spring, driven on the UI thread.
  const timed = createAnimatedValue(0);
  const sprung = createAnimatedValue(0);
  let there = false;
  const run = () => {
    there = !there;
    timed.timing(there ? TRACK : 0, { duration: 700, easing: Easing.inOut(Easing.cubic) });
    sprung.spring(there ? TRACK : 0, { stiffness: 180, damping: 9 });
  };

  // 3. A composite: a staggered hop, then all of them spin; runs natively end to end.
  const ys = Array.from({ length: SWATCHES }, () => createAnimatedValue(0));
  const spin = createAnimatedValue(0);
  const status = signal("idle");
  const show = Animated.sequence([
    Animated.stagger(
      70,
      ys.map((y) =>
        Animated.sequence([
          Animated.timing(y, { toValue: -30, duration: 200, easing: Easing.out(Easing.quad) }),
          Animated.spring(y, { toValue: 0, stiffness: 300, damping: 12 }),
        ]),
      ),
    ),
    Animated.timing(spin, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.cubic) }),
  ]);
  const play = () => {
    status.set("running…");
    show.reset();
    show.start(({ finished }) => status.set(finished ? "finished" : "stopped"));
  };

  // 4. Layout animation: the next commit's frame changes animate.
  const stacked = signal(false);

  const heading = (title: string) => <Text style={{ fontWeight: "600", color: ui().text }}>{title}</Text>;
  const transition = () => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          onPress={() => on.set(!on())}
          style={{
            width: 64,
            height: 64,
            borderRadius: on() ? 32 : 12,
            backgroundColor: on() ? ui().info : ui().accent,
            opacity: on() ? 0.6 : 1,
            transform: [{ rotate: on() ? "45deg" : "0deg" }],
            transitionProperty: "all",
            transitionDuration: reduceMotion() ? 0 : 400,
            transitionTimingFunction: "ease-in-out",
          }}
          hoverStyle={{ opacity: 0.88 }}
          focusStyle={focusRing()}
          activeStyle={{ opacity: 0.7 }}
        />
        <View class="size-10 rounded-full border-4 animate-spin motion-reduce:animate-none" style={{ borderColor: ui().border, borderTopColor: ui().accent }} />
        <View class="size-10 rounded-full animate-pulse motion-reduce:animate-none" style={{ backgroundColor: ui().up }} />
        <Text style={{ flex: 1, color: ui().muted, fontSize: 13 }}>
          {desktop ? "Click the square." : "Tap the square."} animate-spin / animate-pulse run natively.
        </Text>
      </View>
  );
  const tracks = () => (
      <>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: ui().accent, transform: [{ translateX: timed }] }} />
        <View style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: ui().info, transform: [{ translateX: sprung }] }} />
        <View
          style={{
            height: 8,
            borderRadius: 4,
            // One value, interpolated into a color and a width fraction.
            backgroundColor: timed.interpolate({ inputRange: [0, TRACK], outputRange: [ui().border, ui().up] }),
            transform: [{ scaleX: timed.interpolate({ inputRange: [0, TRACK], outputRange: [0.1, 1] }) }],
            transformOrigin: "left",
            width: wide() ? TRACK + 20 : undefined,
          }}
        />
      </>
  );
  const move = () => <Chip label="Move" onPress={run} />;
  const swatches = () => (
      <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "flex-end", gap: 10, height: 64 }}>
        <Each of={palette()}>
          {(color, i) => (
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                backgroundColor: color(),
                transform: [
                  { translateY: ys[i()] },
                  { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) },
                ],
              }}
            />
          )}
        </Each>
      </View>
  );
  const playback = () => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Chip label="Play" onPress={play} />
        <Chip label="Stop" onPress={() => show.stop()} />
        <Text style={{ color: ui().muted, fontSize: desktop ? 13 : undefined }}>{status()}</Text>
      </View>
  );
  const bars = () => (
      <View style={{ flexDirection: stacked() ? "column" : "row", gap: 8 }}>
        <Each of={palette()}>
          {(color) => <View style={{ height: stacked() ? 18 : 40, flex: stacked() ? undefined : 1, borderRadius: 6, backgroundColor: color() }} />}
        </Each>
      </View>
  );
  const stack = () => (
      <Chip
        label={stacked() ? "Back to a row" : "Stack them"}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
          stacked.set(!stacked());
        }}
      />
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 16, paddingTop: 24, gap: 14 }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <Stage width={520} gap={14}>
              {heading("Transition (style changes animate)")}
              {transition()}
              {heading("timing and spring")}
              <View style={{ gap: 8 }}>{tracks()}</View>
              {heading("Animated.sequence / stagger")}
              {swatches()}
              {heading("LayoutAnimation")}
              {bars()}
            </Stage>
            <Inspector>
              <Panel title="timing · spring">
                <View style={{ paddingTop: 6 }}>{move()}</View>
              </Panel>
              <Panel title="Animated.sequence · stagger">
                <View style={{ paddingTop: 6 }}>{playback()}</View>
              </Panel>
              <Panel title="LayoutAnimation.configureNext">
                <View style={{ paddingTop: 6 }}>{stack()}</View>
              </Panel>
            </Inspector>
          </View>
        ) : (
          <>
            {heading("Transition (style changes animate)")}
            {transition()}
            {heading("timing and spring")}
            <View style={{ gap: 8 }}>
              {tracks()}
              {move()}
            </View>
            {heading("Animated.sequence / stagger")}
            {swatches()}
            {playback()}
            {heading("LayoutAnimation")}
            {bars()}
            {stack()}
          </>
        )
      }
    </View>
  );
}

mount(App);
