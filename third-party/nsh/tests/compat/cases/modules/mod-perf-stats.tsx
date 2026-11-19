// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `perfStats()`, what the performance monitor measured: `null` while it
// does not measure, as at launch. Its script checks it.
import { perfStats, Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Fps: ${perfStats()?.fps ?? "none"}`}</Text>
    </View>
  );
}

export default App;
