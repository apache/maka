// A case of the API's test suite (docs/dev/compatibility.md): the frame
// rate animations ask for. `frameRate` in the options of `timing`,
// `spring`, `decay`, `Animated.*`, keyframes and motions, and the style key
// `animationFrameRate` of a keyframe `animation`, are the highest rate each
// needs; a platform that can lower its frame rate honors them, and the
// animations end where they would at the screen's rate. The script checks
// that they run to their ends and that the style key reaches the platform.
import { Text, View } from "nsh";
import { Animated, Easing, createAnimatedValue, createMotion } from "nsh";

function App() {
  const fade = createAnimatedValue(0);
  const slide = createAnimatedValue(40);
  const glide = createAnimatedValue(0);
  const pulse = createAnimatedValue(0);
  const tint = createMotion({ initial: { opacity: 0 } });
  const faded = fade.timing(1, { duration: 200, easing: Easing.linear, frameRate: 30 });
  const sprung = slide.spring(0, { stiffness: 400, damping: 40, frameRate: 60 });
  const glided = glide.decay({ velocity: 600, deceleration: 0.99, clamp: [0, 20], frameRate: 24 });
  const played = Animated.sequence([
    Animated.timing(pulse, { toValue: 0.5, duration: 100, frameRate: 30 }),
    Animated.keyframes(pulse, { keyframes: [0.5, 0.2, 1], duration: 200, frameRate: 20 }),
  ]).start();
  const motion = tint.play("fadeIn", { duration: 200, frameRate: 15 });
  const started = [faded, sprung, glided, played, motion].every((p) => p instanceof Promise);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Text>Frame rates started: {started ? "yes" : "no"}</Text>
      <View testID="fade" style={{ width: 20, height: 20, opacity: fade }} />
      <View testID="slide" style={{ width: 20, height: 20, transform: [{ translateX: slide }] }} />
      <View testID="glide" style={{ width: 20, height: 20, transform: [{ translateX: glide }] }} />
      <View testID="pulse" style={{ width: 20, height: 20, opacity: pulse }} />
      <View testID="tint" style={{ width: 20, height: 20, ...tint.style }} />
      <View
        testID="spinner"
        style={{
          width: 16,
          height: 16,
          animationName: "spin",
          animationDuration: 1000,
          animationTimingFunction: "linear",
          animationFrameRate: 30,
        }}
      />
      <View testID="uncapped" style={{ width: 16, height: 16, animationName: "pulse" }} />
    </View>
  );
}

export default App;
