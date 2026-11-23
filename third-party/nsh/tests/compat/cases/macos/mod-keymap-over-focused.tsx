import { keymap, Text, View, signal } from "nsh";

// `keymap.bind`'s `overFocused`: a binding that comes before a focused
// component's own (a query editor's mod+enter over the editor's). Here it
// is bound with the option and fires; how it orders against a focused
// component's binding is checked by the core's and the gallery's tests.
function App() {
  const runs = signal(0);
  keymap.bind("mod+enter", () => runs.set(runs() + 1), { when: "always", overFocused: true, scope: "app" });
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Runs: ${runs()}`}</Text>
    </View>
  );
}

export default App;
