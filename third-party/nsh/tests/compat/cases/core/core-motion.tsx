// A case of the API's test suite (docs/dev/compatibility.md): motions and
// keyframes of `nsh/animated`. The animations run on the UI thread, which a
// headless run has not, so the script checks what JS sees synchronously:
// the presets as data, the values a motion makes (and where `enter` starts
// them), the steps easing's curve, and that keyframes, motions and
// staggers build and start.
import { Text, View } from "nsh";
import { Animated, Easing, createAnimatedValue, createMotion, motions } from "nsh/animated";

function App() {
  const card = createMotion({ enter: "fadeInUp", delay: 40 });
  const plain = createMotion({ initial: { opacity: 0 } });
  const value = createAnimatedValue(0);
  const shake = card.play("shake", { duration: 300 });
  const own = plain.play({
    keyframes: [{ opacity: 0, rotate: "0deg" }, { opacity: 1, rotate: "0.5turn", easing: Easing.out(Easing.cubic) }],
    iterations: 2,
    direction: "alternate",
  });
  const keyed = value.keyframes([0, { value: 1, offset: 0.25 }, 0], { duration: 400, easing: Easing.steps(4, "jump-start") });
  const ripple = Animated.stagger(30, [0, 1, 2].map(() => Animated.keyframes(value, { keyframes: [0, 1], iterations: "infinite" })), { from: "center" });
  const wave = Animated.stagger(40, [card, plain].map((m) => m.animation("popIn")), { from: "last" });
  plain.stop();
  plain.reset();
  const kinds = Object.keys(motions).map((name) => motions[name as keyof typeof motions].kind);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Text>Presets: {kinds.length > 30 ? "many" : "few"}</Text>
      <Text>Kinds: {[...new Set(kinds)].sort().join(" ")}</Text>
      <Text>Shake moves: {Object.keys(motions.shake.keyframes).join(" ")}</Text>
      <Text>Fade in up from: {String((motions.fadeInUp.keyframes as any).translateY[0].value)}</Text>
      <Text>Steps: {Easing.sample(Easing.steps(4), 5).join(" ")}</Text>
      <Text>Transform steps: {card.style.transform.length}</Text>
      <Text>Bound: {String(card.style.opacity === card.opacity)}</Text>
      <Text>Started: {[shake, own, keyed].every((p) => p instanceof Promise) ? "yes" : "no"}</Text>
      <Text>Staggered: {typeof ripple.start} {typeof wave.start}</Text>
      <View testID="card" style={{ width: 40, height: 40, ...card.style }} />
      <View testID="spread" style={{ width: 40, height: 40, opacity: plain.opacity, transform: [{ perspective: 600 }, ...plain.transform] }} />
    </View>
  );
}

export default App;
