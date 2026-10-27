import { mount, signal, Text, View } from "nsh";
import { Animated, createAnimatedValue } from "nsh";

function Press(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  const saved = signal("not yet");
  const ticks = signal(0);
  const moved = signal("still");
  const loaded = signal("nothing");
  const today = signal(new Date().toISOString());
  const x = createAnimatedValue(0);
  // An autosave ten seconds after the start, and a clock ticking each second.
  setTimeout(() => saved.set(`at ${new Date().toISOString()}`), 10_000);
  setInterval(() => ticks.set(ticks() + 1), 1000);
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Saved: ${saved()}`}</Text>
      <Text>{`Ticks: ${ticks()}`}</Text>
      <Text>{`Moved: ${moved()}`}</Text>
      <Text>{`Loaded: ${loaded()}`}</Text>
      <Text>{`Today: ${today()}`}</Text>
      <Press label="Move" onPress={() => Animated.timing(x, { toValue: 100, duration: 1500 }).start(() => moved.set("done"))} />
      <Press label="Load" onPress={() => fetch("https://api.test/slow").then((r) => r.text()).then((t) => loaded.set(t))} />
      <Press label="Now" onPress={() => today.set(new Date().toISOString())} />
    </View>
  );
}

mount(App);
