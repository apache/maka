import { mount, signal, Text, View } from "nsh";

function Button(props: { label: string; color: string; onPress: () => void }) {
  return (
    <View
      onPress={props.onPress}
      style={{
        backgroundColor: props.color,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 24,
        alignItems: "center",
      }}
    >
      <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "bold" }}>{props.label}</Text>
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
    <View style={{ flex: 1, backgroundColor: "#f4f5f7", padding: 24, paddingTop: 64, gap: 24 }}>
      <Text style={{ fontSize: 28, fontWeight: "bold", color: "#1f2328" }}>nsh counter</Text>
      <View
        style={{
          backgroundColor: "#ffffff",
          borderRadius: 16,
          padding: 24,
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text style={{ fontSize: 14, color: "#6e7781" }}>Current value</Text>
        <Text style={{ fontSize: 64, fontWeight: "bold", color: count() < 0 ? "#cf222e" : "#1f2328" }}>
          {count()}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 12, justifyContent: "center" }}>
        <Button label="−1" color="#cf222e" onPress={() => change(-1)} />
        <Button label="+1" color="#1f883d" onPress={() => change(1)} />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 14, color: "#6e7781" }}>
          Recent values: <Text style={{ fontWeight: "bold", color: "#1f2328" }}>{history().length}</Text>
        </Text>
        <Each of={history()}>{(value) => <Text style={{ fontSize: 16, color: "#1f2328" }}>• {value()}</Text>}</Each>
      </View>
    </View>
  );
}

mount(App);
