// A case of the API's test suite (docs/dev/compatibility.md): `nsh/keymap`'s
// `forFocus`, run as on macOS (`platform macos`). A tile that takes presses
// (Return opens it) binds Space as its own keys while it has the focus: with
// the focus on it, Space reaches that binding before the tile's press and
// Return still presses it; with the focus gone, Space flips nothing.
import { keymap, Text, View, signal } from "nsh";

function App() {
  const opens = signal(0);
  const flips = signal(0);
  let unbind: (() => void) | undefined;
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Opens: ${opens()} Flips: ${flips()}`}</Text>
      <View
        testID="tile"
        onPress={() => opens.set(opens() + 1)}
        onFocus={() => (unbind = keymap.bind("space", () => flips.set(flips() + 1), { forFocus: true }))}
        onBlur={() => unbind?.()}
        style={{ height: 40 }}
      >
        <Text>Tile</Text>
      </View>
      <View testID="other" onPress={() => {}} style={{ height: 40 }}>
        <Text>Other</Text>
      </View>
    </View>
  );
}

export default App;
