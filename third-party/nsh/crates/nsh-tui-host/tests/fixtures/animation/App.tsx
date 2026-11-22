import { Animated, Canvas, Text, View, createAnimatedValue, mount, signal } from "nsh";

function App() {
  const progress = createAnimatedValue(0);
  const finished = signal(0);
  const x = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 16] });
  const color = progress.interpolate({ inputRange: [0, 1], outputRange: ["#ff0000", "#00ff00"] });
  const run = () => {
    progress.set(0);
    Animated.timing(progress, { toValue: 1, duration: 80 }).start(result => {
      if (result.finished) finished.set(finished() + 1);
    });
  };
  return (
    <View>
      <View testID="run" onPress={run}><Text>Run</Text></View>
      <View testID="again" onPress={run} style={{ width: 80, height: 16, opacity: progress, translate: [x, 0] }}>
        <Text style={{ color }}>Again</Text>
      </View>
      <Canvas accessibilityLabel="Progress" style={{ width: 80, height: 16 }} draw={cx => {
        cx.fillStyle = color;
        cx.translate(x, 0);
        cx.fillRect(0, 0, 16, 16);
      }} />
      <Text>Finished {finished()}</Text>
    </View>
  );
}

mount(App);
