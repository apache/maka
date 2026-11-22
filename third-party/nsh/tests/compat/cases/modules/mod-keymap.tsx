// A case of the API's test suite (docs/dev/compatibility.md): `nsh/keymap`
// on the headless runtime (iOS, an Apple platform): the labels of keystrokes,
// bindings made and removed in both forms, and the keystrokes `bind`
// refuses. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { keymap } from "nsh";

function refused(keystroke: string): string {
  try {
    keymap.bind(keystroke, () => {});
    return "bound";
  } catch {
    return "refused";
  }
}

function App() {
  const bound = signal("not bound");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Label: ${keymap.label("mod+shift+l")}`}</Text>
      <Text>{`Label F5: ${keymap.label("f5")}`}</Text>
      <Text>{`Label alt: ${keymap.label("alt+enter")}`}</Text>
      <Text>{`Invalid: ${refused("mod+nonsense")}`}</Text>
      <Text>{`Kept: ${refused("mod+q")}`}</Text>
      <Text>{`Bound: ${bound()}`}</Text>
      <View
        testID="bind"
        onPress={() => {
          const one = keymap.bind("mod+k", () => {}, { when: "always", repeat: true });
          const many = keymap.bind({ "mod+1": () => {}, "ctrl+shift+p": () => {} }, { when: "notEditing" });
          one();
          many();
          bound.set(`${typeof one} ${typeof many}`);
        }}
      >
        <Text>Bind</Text>
      </View>
    </View>
  );
}

export default App;
