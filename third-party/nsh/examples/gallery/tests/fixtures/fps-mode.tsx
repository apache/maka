import { fpsEnabled, mount, setFpsEnabled, setFpsMode, signal, Text, View } from "nsh";

// The performance monitor turned on by the app and shown as it says: its
// whole panel, collapsed to the frame rate, or hidden while it measures.
function App() {
  const last = signal("none");
  const button = (id: string, label: string, onPress: () => void) => (
    // At the left: the panel, at the top right, takes the clicks on it.
    <View role="button" testID={id} onPress={onPress} style={{ alignSelf: "flex-start" }}>
      <Text class="text-foreground">{label}</Text>
    </View>
  );
  return (
    <View class="flex-1 bg-background" style={{ padding: 12, gap: 8 }}>
      {button("measure", "Measure", () => setFpsEnabled(true))}
      {button("collapse", "Collapse", () => (setFpsMode("collapsed"), last.set("collapsed")))}
      {button("expand", "Expand", () => (setFpsMode("expanded"), last.set("expanded")))}
      {button("hide", "Hide", () => (setFpsMode("hidden"), last.set("hidden")))}
      <Text class="text-foreground">{`Enabled ${fpsEnabled()}`}</Text>
      <Text class="text-foreground">{`Mode ${last()}`}</Text>
    </View>
  );
}

mount(App);
