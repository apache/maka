// A case of the API's test suite (docs/dev/compatibility.md): the border
// keys as the platform receives them: widths and colors per side and all
// at once, colors in every notation, border styles, corner radii (each
// corner, the shorthand under them) and the curve, the logical inline
// start / end keys left to right and right to left, and the left / right
// keys, which keep their sides right to left, as in CSS.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Borders</Text>
      <View testID="all" style={{ height: 8, borderWidth: 2, borderColor: "#f00" }} />
      <View
        testID="sides"
        style={{
          height: 8,
          borderTopWidth: 1,
          borderRightWidth: 2,
          borderBottomWidth: 3,
          borderLeftWidth: 4,
          borderTopColor: "#00ff00",
          borderRightColor: "#0000ff80",
          borderBottomColor: "rgb(255, 128, 0)",
          borderLeftColor: "hsl(120, 100%, 25%)",
        }}
      />
      <View testID="over" style={{ height: 8, borderWidth: 2, borderTopWidth: 5, borderColor: "red", borderLeftColor: "blue" }} />
      <View testID="rgba" style={{ height: 8, borderWidth: 1, borderColor: "rgba(0, 0, 255, 0.5)" }} />
      <View testID="hsla" style={{ height: 8, borderWidth: 1, borderColor: "hsla(240, 100%, 50%, 0.25)" }} />
      <View testID="named" style={{ height: 8, borderWidth: 1, borderColor: "rebeccapurple" }} />
      <View testID="clear" style={{ height: 8, borderWidth: 1, borderColor: "transparent" }} />
      <View testID="hex4" style={{ height: 8, borderWidth: 1, borderColor: "#abcd" }} />
      <View testID="modern" style={{ height: 8, borderWidth: 1, borderColor: "rgb(10 20 30 / 50%)" }} />
      <View testID="upper" style={{ height: 8, borderWidth: 1, borderColor: "#AbCdEf" }} />
      <View testID="solid" style={{ height: 8, borderWidth: 1, borderStyle: "solid" }} />
      <View testID="dashed" style={{ height: 8, borderWidth: 1, borderStyle: "dashed" }} />
      <View testID="dotted" style={{ height: 8, borderWidth: 1, borderStyle: "dotted" }} />
      <View
        testID="corners"
        style={{
          height: 8,
          borderTopLeftRadius: 1,
          borderTopRightRadius: 2,
          borderBottomRightRadius: 3,
          borderBottomLeftRadius: 4,
        }}
      />
      <View
        testID="corner-over"
        style={{ height: 8, borderTopLeftRadius: 2, borderRadius: 10, borderBottomRightRadius: 6 }}
      />
      <View testID="circular" style={{ height: 8, borderRadius: 4, borderCurve: "circular" }} />
      <View testID="continuous" style={{ height: 8, borderRadius: 4, borderCurve: "continuous" }} />
      <View style={{ direction: "ltr" }}>
        <View
          testID="ltr"
          style={{
            height: 8,
            borderStartWidth: 3,
            borderEndWidth: 5,
            borderStartColor: "#112233",
            borderEndColor: "#445566",
            borderTopStartRadius: 1,
            borderTopEndRadius: 2,
            borderBottomEndRadius: 3,
            borderBottomStartRadius: 4,
          }}
        />
      </View>
      <View style={{ direction: "rtl" }}>
        <View
          testID="rtl"
          style={{
            height: 8,
            borderStartWidth: 3,
            borderEndWidth: 5,
            borderStartColor: "#112233",
            borderEndColor: "#445566",
            borderTopStartRadius: 1,
            borderTopEndRadius: 2,
            borderBottomEndRadius: 3,
            borderBottomStartRadius: 4,
          }}
        />
        <View
          testID="rtl-sides"
          style={{ height: 8, borderLeftWidth: 1, borderRightWidth: 2, borderLeftColor: "#123", borderTopLeftRadius: 6 }}
        />
      </View>
    </View>
  );
}

export default App;
