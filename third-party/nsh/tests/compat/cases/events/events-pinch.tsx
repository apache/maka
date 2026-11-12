// A case of the API's test suite (docs/dev/compatibility.md): a view that
// listens to `onPinch` asks the platform for touchpad pinches over it
// (macOS, Linux, GPUI, Safari), with their `delta` and `phase`, which the
// handler shows as text. Its script checks the platform is asked.
import { Text, View, signal } from "nsh";

function App() {
  const pinch = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="canvas"
        style={{ height: 120, marginLeft: 20 }}
        onPinch={(e) => pinch.set(`${e.delta} ${e.phase} at ${e.position.x},${e.pagePosition.y}`)}
      />
      <Text>Pinch: {pinch()}</Text>
    </View>
  );
}

export default App;
