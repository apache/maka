// A case of the API's test suite (docs/dev/compatibility.md): the layout
// events the core raises: a view's frame relative to its parent, again
// when a press changes it, and a text's laid-out lines (reported as an
// array; the tests' text engine has no lines to report). Each handler shows
// what it gets as text. Its script checks
// each.
import { Text, View, signal } from "nsh";

function App() {
  const wide = signal(false);
  const layout = signal("none");
  const lines = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View style={{ paddingLeft: 12 }}>
        <View
          testID="box"
          style={{ marginTop: 8, width: wide() ? 200 : 100, height: 30 }}
          onLayout={({ bounds: b }) => layout.set(`${b.origin.x},${b.origin.y} ${b.size.width}x${b.size.height}`)}
        />
      </View>
      <Text>Layout: {layout()}</Text>
      <View testID="widen" onPress={() => wide.set(true)}>
        <Text>Widen</Text>
      </View>
      <Text
        onTextLayout={(e) => lines.set(Array.isArray(e.lines) ? "reported, an array" : typeof e.lines)}
      >
        Laid out
      </Text>
      <Text>Lines: {lines()}</Text>
    </View>
  );
}

export default App;
