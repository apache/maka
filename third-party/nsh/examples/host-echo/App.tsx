import { mount, signal, Text, View } from "nsh";
import { host } from "nsh";

function App() {
  const result = signal("(not called)");
  const ticks = signal(0);
  host.on("tick", () => ticks.update((n) => n + 1));
  const noted = signal("(none)");
  host.on("noted", (data) => noted.set(JSON.stringify(data)));

  const call = () => {
    host.call("echo", { n: 1 }).then(
      (value) => result.set(JSON.stringify(value)),
      (err: Error) => result.set(`rejected: ${err.message}`),
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f4f5f7", padding: 24, paddingTop: 64, gap: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: "bold", color: "#1f2328" }}>nsh/host</Text>
      <Text style={{ fontSize: 16, color: "#1f2328" }}>available: {String(host.available())}</Text>
      <View
        onPress={call}
        accessibilityLabel="call"
        role="button"
        style={{ backgroundColor: "#1f883d", borderRadius: 12, paddingVertical: 12, alignItems: "center" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "bold" }}>call</Text>
      </View>
      <View
        onPress={() => host.post("note", { n: 2 })}
        accessibilityLabel="post"
        role="button"
        style={{ backgroundColor: "#0969da", borderRadius: 12, paddingVertical: 12, alignItems: "center" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "bold" }}>post</Text>
      </View>
      <Text style={{ fontSize: 16, color: "#1f2328" }}>{result()}</Text>
      <Text style={{ fontSize: 16, color: "#1f2328" }}>noted: {noted()}</Text>
      <Text style={{ fontSize: 16, color: "#1f2328" }}>ticks: {ticks()}</Text>
    </View>
  );
}

mount(App);
