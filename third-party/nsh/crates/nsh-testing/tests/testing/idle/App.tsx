import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function Press(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  const count = signal(0);
  const typed = signal("");
  const later = signal("not yet");
  const loaded = signal("nothing");
  const timer = signal("waiting");
  setTimeout(() => timer.set("fired"), 1000);
  // Work that comes due at the time of the press, a turn after another.
  const chain = async () => {
    await Promise.resolve();
    setTimeout(() => setTimeout(() => later.set("done"), 0), 0);
  };
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Count: ${count()}`}</Text>
      <Text>{`Typed: ${typed()}`}</Text>
      <Text>{`Later: ${later()}`}</Text>
      <Text>{`Loaded: ${loaded()}`}</Text>
      <Text>{`Timer: ${timer()}`}</Text>
      <Input testID="field" value={typed()} onChange={({ value }) => typed.set(value)} />
      <Press label="Add" onPress={() => count.set(count() + 1)} />
      <Press label="Later" onPress={chain} />
      <Press
        label="Load"
        onPress={() =>
          fetch("https://api.test/now")
            .then((r) => r.text())
            .then((t) => loaded.set(t))
        }
      />
    </View>
  );
}

mount(App);
