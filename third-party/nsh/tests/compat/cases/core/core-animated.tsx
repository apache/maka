// A case of the API's test suite (docs/dev/compatibility.md): `nsh/animated`.
// The animations themselves run on the UI thread, which a headless run has
// not, so the script checks what JS sees synchronously: the curves the
// native drivers run (`Easing.sample`, `Animated.sampleSpring` /
// `sampleDecay`), the nodes and values the graph builds, the layout
// animation configs, and that a layout animated with `LayoutAnimation`
// ends where its commit puts it. Its script checks
// each.
import { Text, View, signal } from "nsh";
import {
  Animated,
  AnimatedNode,
  AnimatedValue,
  Easing,
  LayoutAnimation,
  createAnimatedValue,
} from "nsh/animated";

const fixed = (values: number[]) => values.map((v) => v.toFixed(3)).join(" ");

function App() {
  const opacity = createAnimatedValue(0.5);
  const scale = new AnimatedValue(2);
  const sum = Animated.add(opacity, scale);
  const mapped = scale.interpolate({ inputRange: [0, 4], outputRange: [0, 100] });
  // A floating bar that settles shown or hidden when its scroll view rests.
  const bar = scale.diffClamp(0, 56, { snap: true });
  const fade = Animated.timing(opacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic) });
  const spring = Animated.sampleSpring({ toValue: 1, damping: 40 });
  const decay = Animated.sampleDecay({ velocity: 1000, from: 0 });
  const custom = LayoutAnimation.create(250, LayoutAnimation.Types.linear, LayoutAnimation.Properties.opacity);
  const keyboard = LayoutAnimation.create(250, LayoutAnimation.Types.keyboard);
  const width = signal(50);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Text>Linear: {fixed(Easing.sample(Easing.linear, 3))}</Text>
      <Text>Quad: {fixed(Easing.sample(Easing.quad, 3))}</Text>
      <Text>Quad out: {fixed(Easing.sample(Easing.out(Easing.quad), 3))}</Text>
      <Text>Bezier ends: {fixed(Easing.sample(Easing.bezier(0.25, 0.1, 0.25, 1), 2))}</Text>
      <Text>Spring rests at: {spring[spring.length - 1].toFixed(2)}</Text>
      <Text>Spring moves: {spring.length > 10 ? "yes" : "no"}</Text>
      <Text>Decay starts at: {decay[0].toFixed(1)}</Text>
      <Text>Decay moves forward: {decay[decay.length - 1] > 0 ? "yes" : "no"}</Text>
      <Text>Value is a node: {String(opacity instanceof AnimatedValue && opacity instanceof AnimatedNode)}</Text>
      <Text>Sum is a node: {String(sum instanceof AnimatedNode && !(sum instanceof AnimatedValue))}</Text>
      <Text>Interpolation is a node: {String(mapped instanceof AnimatedNode)}</Text>
      <Text>Composite: {typeof fade.start}/{typeof fade.stop}/{typeof fade.reset}</Text>
      <Text>Preset duration: {LayoutAnimation.Presets.easeInEaseOut.duration}</Text>
      <Text>
        Created: {custom.duration} {custom.create?.type} {custom.create?.property}
      </Text>
      <View testID="faded" style={{ width: 40, height: 40, opacity, transform: [{ translateX: mapped }] }} />
      <View
        testID="grow"
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.linear);
          width.set(150);
        }}
      >
        <Text>Grow</Text>
      </View>
      <View testID="box" style={{ width: width(), height: 20 }} />
      <Text>Keyboard: {keyboard.update?.type}</Text>
      <Text>
        Snapping diffClamp: {String(bar instanceof AnimatedNode)}{" "}
        {String(Animated.diffClamp(scale, 0, 56, { snap: true }) === bar)}{" "}
        {String(scale.diffClamp(0, 56) !== bar)}
      </Text>
    </View>
  );
}

export default App;
