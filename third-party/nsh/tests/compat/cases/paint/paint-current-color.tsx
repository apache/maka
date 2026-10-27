// A case of the API's test suite (docs/dev/compatibility.md): CSS's
// `currentColor`, the text color, written out in a style and in classes:
// a color property set to it, inside a `color-mix()` and a gradient, a
// `drop-shadow()` without a color (CSS's default), and the classes'
// arbitrary values.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64, color: "#00ff00" }}>
      <Text>Current color</Text>
      <View testID="current" style={{ height: 8, borderWidth: 1, borderColor: "currentColor", backgroundColor: "currentColor" }} />
      <View testID="current-mix" style={{ height: 8, backgroundColor: "color-mix(in srgb, currentColor 50%, #0000ff)" }} />
      <View testID="current-gradient" style={{ height: 8, backgroundImage: "linear-gradient(currentColor, #0000ff)" }} />
      <View testID="current-drop" style={{ height: 8, filter: "drop-shadow(0 1px 2px)" }} />
      <View testID="current-class" class="h-2 bg-[currentColor] border border-[currentColor]/50" />
      <View testID="current-class-mix" class="h-2 bg-[color-mix(in_srgb,currentColor_50%,#0000ff)]" />
    </View>
  );
}

export default App;
