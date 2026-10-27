// A case of the API's test suite (docs/dev/compatibility.md): the other
// paint keys as the platform receives them: outlines, visibility,
// overflow, every pointer cursor, an image's tint, the transform's origin
// in keywords, percentages, lengths and a list, and backface visibility.
//
import { Text, View } from "nsh";
import { Image } from "nsh";

const CURSORS = [
  "auto",
  "default",
  "pointer",
  "text",
  "wait",
  "progress",
  "help",
  "crosshair",
  "move",
  "grab",
  "grabbing",
  "not-allowed",
  "zoom-in",
  "zoom-out",
  "col-resize",
  "row-resize",
  "none",
] as const;

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Misc</Text>
      <View
        testID="outline"
        style={{ height: 4, outlineWidth: 2, outlineColor: "#0a84ff", outlineStyle: "solid", outlineOffset: 3 }}
      />
      <View
        testID="outline-dashed"
        style={{ height: 4, outlineWidth: 1, outlineColor: "rgb(255, 0, 0)", outlineStyle: "dashed", outlineOffset: -2 }}
      />
      <View testID="outline-dotted" style={{ height: 4, outlineWidth: 3, outlineColor: "green", outlineStyle: "dotted" }} />
      <View testID="outline-none" style={{ height: 4, outlineWidth: 3, outlineColor: "green", outlineStyle: "none" }} />
      <View testID="outline-hidden" style={{ height: 4, outlineWidth: 3, outlineColor: "green", outlineStyle: "hidden" }} />
      <View testID="visible" style={{ height: 4, visibility: "visible" }} />
      <View testID="hidden" style={{ height: 4, visibility: "hidden" }} />
      <View testID="collapse" style={{ height: 4, visibility: "collapse" }} />
      <View testID="after-hidden" style={{ height: 4 }} />
      <View testID="overflow-visible" style={{ height: 4, overflow: "visible" }} />
      <View testID="overflow-hidden" style={{ height: 4, overflow: "hidden" }} />
      {CURSORS.map((cursor) => (
        <View testID={`cursor-${cursor}`} style={{ height: 2, cursor }} />
      ))}
      <Image
        testID="tinted"
        src={{ uri: "https://example.com/compat.png" }}
        style={{ width: 16, height: 16, tintColor: "#ff9500" }}
      />
      <Image
        testID="tinted-hsl"
        src={{ uri: "https://example.com/compat.png" }}
        style={{ width: 16, height: 16, tintColor: "hsl(210, 100%, 50%)" }}
      />
      <View testID="origin-center" style={{ height: 4, transformOrigin: "center" }} />
      <View testID="origin-keywords" style={{ height: 4, transformOrigin: "top left" }} />
      <View testID="origin-keywords-swapped" style={{ height: 4, transformOrigin: "bottom right" }} />
      <View testID="origin-percent" style={{ height: 4, transformOrigin: "50% 0" }} />
      <View testID="origin-lengths" style={{ height: 4, transformOrigin: "10px 20px 30px" }} />
      <View testID="origin-list" style={{ height: 4, transformOrigin: [10, "25%"] }} />
      <View testID="backface-visible" style={{ height: 4, backfaceVisibility: "visible" }} />
      <View testID="backface-hidden" style={{ height: 4, backfaceVisibility: "hidden" }} />
    </View>
  );
}

export default App;
