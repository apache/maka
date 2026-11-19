// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `setFpsMode`, how the performance monitor shows: every mode goes through
// (a platform without a panel ignores it). Its script checks it.
import { setFpsMode, Text, View, signal } from "nsh";

function App() {
  const calls = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Modes: ${calls()}`}</Text>
      <View
        testID="modes"
        onPress={() => {
          setFpsMode("collapsed");
          setFpsMode("hidden");
          setFpsMode("expanded");
          calls.set("done");
        }}
      >
        <Text>Modes</Text>
      </View>
    </View>
  );
}

export default App;
