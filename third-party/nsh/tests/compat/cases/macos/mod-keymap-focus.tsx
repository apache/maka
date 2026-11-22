// A case of the API's test suite (docs/dev/compatibility.md): a plain Return
// of `nsh/keymap` bound outside text fields (a dialog's main action), run as
// on macOS (`platform macos`), where Tab moves the keyboard focus between
// views: with the focus on no control the binding hears Return; with it on a
// view that takes presses, Return and Space press that view and the binding
// stays quiet; Mod+Return still fires its own binding there.
import { keymap, Text, View, signal } from "nsh";

function App() {
  const allows = signal(0);
  const denies = signal(0);
  const sends = signal(0);
  keymap.bind("enter", () => allows.set(allows() + 1), { when: "notEditing" });
  keymap.bind("mod+enter", () => sends.set(sends() + 1));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Allows: ${allows()} Denies: ${denies()} Sends: ${sends()}`}</Text>
      <View testID="deny" onPress={() => denies.set(denies() + 1)} style={{ height: 40 }}>
        <Text>Deny</Text>
      </View>
    </View>
  );
}

export default App;
