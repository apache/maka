import { mount, signal, Text, View } from "nsh";
import { colorScheme, setColorScheme } from "nsh";
import { Button, Card, colors, Segmented, Toggle } from "..";

function App() {
  const presses = signal(0);
  const checked = signal(false);
  const mode = signal("first");
  return (
    <View style={{ flex: 1, padding: 20, gap: 12, backgroundColor: colors.background }}>
      <Text style={{ color: colors.text }}>{`appearance ${colorScheme()}`}</Text>
      <Button label={`Pressed ${presses()}`} onPress={() => presses.update((n) => n + 1)} />
      <Toggle label="Feature" value={checked()} onChange={(value) => checked.set(value)} />
      <Text>{`Feature ${checked()}`}</Text>
      <Segmented options={[{ value: "first", label: "First" }, { value: "second", label: "Second" }]} value={mode()} onChange={(value) => mode.set(value)} />
      <Text>{`Selected ${mode()}`}</Text>
      <Card title="Shared card"><Text>Inside the shared inset</Text></Card>
      <Button label="Change appearance" onPress={() => setColorScheme(colorScheme() === "dark" ? "light" : "dark")} />
    </View>
  );
}
mount(App);
