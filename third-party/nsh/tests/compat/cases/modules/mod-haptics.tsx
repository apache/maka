// A case of the API's test suite (docs/dev/compatibility.md): `nsh/mobile`'s
// `Haptics`, each call going through (the headless runtime plays nothing), and
// a name it does not know refused with a TypeError. Its script checks each.
import { Text, View, signal } from "nsh";
import { Haptics } from "nsh/mobile";

function App() {
  const calls = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Haptics: ${calls()}`}</Text>
      <View
        testID="play"
        onPress={() => {
          Haptics.selection();
          Haptics.impact();
          Haptics.impact("light");
          Haptics.impact("heavy");
          Haptics.notification("success");
          Haptics.notification("error");
          Haptics.notification();
          try {
            Haptics.impact("loud" as never);
            calls.set("accepted loud");
          } catch (e) {
            calls.set(`done, loud refused: ${(e as Error).name}`);
          }
        }}
      >
        <Text>Play them</Text>
      </View>
    </View>
  );
}

export default App;
