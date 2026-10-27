import { mount, signal, Text, View } from "nsh";
import { Animated, createAnimatedValue, Easing } from "nsh";
import { button, buttonText, desktop, Panel, Split, ui, wide } from "./palette";

const TRACK = 240;
const curves: [string, Easing][] = [
  ["linear", Easing.linear],
  ["quad out", Easing.out(Easing.quad)],
  ["cubic inOut", Easing.inOut(Easing.cubic)],
  ["back out", Easing.out(Easing.back())],
  ["elastic out", Easing.out(Easing.elastic(1))],
  ["bounce out", Easing.out(Easing.bounce)],
];

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button()}>
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

function App() {
  const dots = curves.map(() => createAnimatedValue(0));
  const spin = createAnimatedValue(0);
  const status = signal(desktop ? "Click a button" : "Tap a button");
  let there = false;

  const race = () => {
    there = !there;
    status.set("running…");
    Animated.parallel(
      dots.map((x, i) => Animated.timing(x, { toValue: there ? TRACK : 0, duration: 1000, easing: curves[i][1] })),
    )
      .start()
      .then((finished) => status.set(finished ? "finished" : "stopped"));
  };

  const turn = () => {
    spin.timing(0);
    spin.timing(1, { duration: 900, easing: Easing.inOut(Easing.cubic) });
  };

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>Native animation</Text>
      <Split
        gap={16}
        width={360}
        inspector={
          wide() ? (
            <>
              <Panel title="Animated.parallel · six easings">
                <View style={{ gap: 10 }}>
                  <Text style={{ fontSize: 13, color: ui().text }}>{status()}</Text>
                  <Button label="Race" onPress={race} />
                </View>
              </Panel>
              <Panel title="timing · interpolate">
                <View style={{ paddingTop: 6 }}>
                  <Button label="Spin" onPress={turn} />
                </View>
              </Panel>
            </>
          ) : (
            <>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Button label="Race" onPress={race} />
                <Button label="Spin" onPress={turn} />
              </View>
              <Text style={{ color: ui().muted }}>{status()}</Text>
            </>
          )
        }
      >
      <View style={{ gap: 8 }}>
        <Each of={curves}>
          {(c, i) => (
            <View style={{ gap: 2 }}>
              <Text style={{ fontSize: 12, color: ui().muted }}>{c()[0]}</Text>
              <View style={{ width: TRACK + 16, height: 16, borderRadius: 8, backgroundColor: ui().inset.backgroundColor, boxShadow: ui().inset.boxShadow }}>
                <View
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    ...ui().accentFill,
                    borderWidth: 0,
                    transform: [{ translateX: dots[i()] }],
                  }}
                />
              </View>
            </View>
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 14,
            backgroundColor: spin.interpolate({ inputRange: [0, 0.5, 1], outputRange: [ui().up, ui().warn, ui().up] }),
            transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
          }}
        />
        <Text style={{ flex: 1, color: ui().muted, fontSize: 13 }}>
          Rotation and color are interpolated from one animated value.
        </Text>
      </View>
      </Split>
    </View>
  );
}

mount(App);
