// A case of the API's test suite (docs/dev/compatibility.md): a binding of
// `nsh/keymap` with `passThrough`, run as on macOS (`platform macos`), where
// Tab moves the keyboard focus between views: the binding hears Tab, and
// the key goes on, so the focus still moves to the next view.
import { keymap, Text, View, signal } from "nsh";

function App() {
  const passed = signal(0);
  const focused = signal("none");
  keymap.bind("tab", () => passed.set(passed() + 1), { passThrough: true });
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Passed: ${passed()} Focus: ${focused()}`}</Text>
      <View testID="first" onPress={() => {}} onFocus={() => focused.set("first")} style={{ height: 40 }}>
        <Text>First</Text>
      </View>
      <View testID="second" onPress={() => {}} onFocus={() => focused.set("second")} style={{ height: 40 }}>
        <Text>Second</Text>
      </View>
    </View>
  );
}

export default App;
