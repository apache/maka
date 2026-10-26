import { mount, signal, Text, View } from "nsh";
import { button, buttonText, ui } from "./palette";

function Button(props: { label: string; accent?: boolean; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button(props.accent ? "accent" : "secondary", { align: "center", style: { minWidth: 96 } })}>
      <Text style={buttonText(props.accent ? "accent" : "secondary")}>{props.label}</Text>
    </View>
  );
}

function App() {
  const count = signal(0);
  const history = signal<number[]>([]);

  const change = (delta: number) => {
    const next = count() + delta;
    count.set(next);
    history.update((h) => [next, ...h].slice(0, 5));
  };

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 24, paddingTop: 64, gap: 24 }}>
      <Text style={{ fontSize: 28, fontWeight: "bold", color: ui().text }}>nsh counter</Text>
      <View style={{ ...ui().card, borderRadius: 16, padding: 24, alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 14, color: ui().muted }}>Current value</Text>
        <Text style={{ fontSize: 64, fontWeight: "bold", fontVariant: ["tabular-nums"], color: count() < 0 ? ui().down : ui().text }}>
          {count()}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 12, justifyContent: "center" }}>
        <Button label="−1" onPress={() => change(-1)} />
        <Button label="+1" accent onPress={() => change(1)} />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 14, color: ui().muted }}>
          Recent values: <Text style={{ fontWeight: "bold", color: ui().text }}>{history().length}</Text>
        </Text>
        <Each of={history()}>{(value) => <Text style={{ fontSize: 16, color: ui().text }}>• {value()}</Text>}</Each>
      </View>
    </View>
  );
}

mount(App);
