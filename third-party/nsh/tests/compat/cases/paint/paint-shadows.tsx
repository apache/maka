// A case of the API's test suite (docs/dev/compatibility.md): shadows as
// the platform receives them: CSS box shadows (offsets, blur, spread,
// inset, colors in several notations, several at once, `none`) and CSS
// text shadows (offsets, blur, colors, the widest of several layers,
// `none`).
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Shadows</Text>
      <View testID="shadow" style={{ height: 8, boxShadow: "2px 4px 6px #0000004d" }} />
      <View testID="shadow-red" style={{ height: 8, boxShadow: "-1px 0 0 rgba(255, 0, 0, 0.5)" }} />
      <View testID="box" style={{ height: 8, boxShadow: "2px 4px 6px 1px #00000080" }} />
      <View testID="box-two" style={{ height: 8, boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2), inset 0 0 0 1px red" }} />
      <View testID="box-offsets" style={{ height: 8, boxShadow: "3px 3px blue" }} />
      {/* The layers as numbers: the same shadows as the strings above */}
      <View
        testID="box-layers"
        style={{
          height: 8,
          boxShadow: [
            { x: 0, y: 1, blur: 2, color: "rgba(0, 0, 0, 0.2)" },
            { x: 0, y: 0, spread: 1, inset: true, color: "red" },
          ],
        }}
      />
      <View testID="box-first" style={{ height: 8, boxShadow: "hsl(0, 100%, 50%) -2px -3px 5px" }} />
      <View testID="box-inset" style={{ height: 8, boxShadow: "inset 1px 2px 3px 4px #0f08" }} />
      <View testID="box-none" style={{ height: 8, boxShadow: "none" }} />
      <Text testID="text-shadow" style={{ textShadow: "1px 2px 3px #336699" }}>
        Shadowed
      </Text>
      <Text testID="text-shadow-layers-numbers" style={{ textShadow: [{ x: 1, y: 2, blur: 3, color: "#336699" }] }}>
        Numbers
      </Text>
      <Text testID="text-shadow-alpha" style={{ textShadow: "rgba(0, 0, 0, 0.5) -2px 0" }}>
        Faint
      </Text>
      <Text testID="text-shadow-layers" style={{ textShadow: "0 1px 1px red, 3px 4px 5px blue" }}>
        Layered
      </Text>
      <Text testID="text-shadow-none" style={{ textShadow: "none" }}>
        Plain text
      </Text>
    </View>
  );
}

export default App;
