// Hardware keys while a selectable view holds a selection (#2934): its
// internal responder answers Copy and Select All, and the other keys go
// through the area's raw key path, so the ancestors hear them and a
// capture rule decides their default.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const down = signal("none");
  const up = signal("none");
  const prevented = signal("none");
  const selected = signal("");
  return (
    <View
      style={{ flex: 1, padding: 24, gap: 12 }}
      onKeyDown={(e) => {
        down.set(e.key);
        prevented.set(String(e.defaultPrevented));
      }}
      onKeyUp={(e) => up.set(e.key)}
    >
      <View captureKeys={["x"]}>
        <View selectable focusable onSelectionChange={({ text }) => selected.set(text)}>
          <Text>Select these words then type</Text>
        </View>
      </View>
      <Text>{`down:${down()}`}</Text>
      <Text>{`up:${up()}`}</Text>
      <Text>{`prevented:${prevented()}`}</Text>
      <Text>{`selected:${selected()}`}</Text>
      <Input testID="paste" style={{ height: 44, width: 240 }} />
    </View>
  );
}

mount(App);
