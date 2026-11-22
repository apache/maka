// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `fpsEnabled()` and `setFpsEnabled` on the headless runtime, which has no
// performance monitor: turning it on goes through and `fpsEnabled()` stays
// what the platform reports. Its script checks each.
import { fpsEnabled, setFpsEnabled, Text, View, signal } from "nsh";

function App() {
  const calls = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Fps enabled: ${fpsEnabled()}`}</Text>
      <Text>{`Calls: ${calls()}`}</Text>
      <View
        testID="toggle"
        onPress={() => {
          setFpsEnabled(true);
          setFpsEnabled(false);
          calls.set("done");
        }}
      >
        <Text>Toggle</Text>
      </View>
    </View>
  );
}

export default App;
