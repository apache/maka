// A case of the API's test suite (docs/dev/compatibility.md): the text
// keys as the platform receives them, on a text and on the nested texts
// (spans) inside one, and the layout the size keys make: font family,
// size, style and variants, letter spacing, line height, alignment (across,
// `start` and `end` following the direction, and down), decorations, transforms and the writing direction.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text testID="plain" style={{ alignSelf: "flex-start" }}>
        Plain
      </Text>
      <Text testID="big" style={{ alignSelf: "flex-start", fontSize: 32 }}>
        Big
      </Text>
      <Text testID="tall" style={{ alignSelf: "flex-start", fontSize: 10, lineHeight: 30 }}>
        Tall
      </Text>
      <Text testID="tall-two" style={{ width: 40, fontSize: 10, lineHeight: 20 }}>
        Two lines here
      </Text>
      <Text testID="wide" style={{ alignSelf: "flex-start", letterSpacing: 4 }}>
        Wide
      </Text>
      <Text testID="wide-em" style={{ alignSelf: "flex-start", fontSize: 20, letterSpacing: "0.1em" }}>
        Em spaced
      </Text>
      <Text testID="family" style={{ fontFamily: "Georgia" }}>
        Serif
      </Text>
      <Text testID="italic" style={{ fontStyle: "italic" }}>
        Leaning
      </Text>
      <Text testID="upright" style={{ fontStyle: "normal" }}>
        Upright
      </Text>
      <Text testID="variant" style={{ fontVariant: ["small-caps", "tabular-nums"] }}>
        Variants
      </Text>
      <Text testID="variant-old" style={{ fontVariant: ["oldstyle-nums", "proportional-nums"] }}>
        Old figures
      </Text>
      {/* CSS's names in a string */}
      <Text testID="variant-lining" style={{ fontVariant: "lining-nums" }}>
        Lining figures
      </Text>
      <Text testID="underline" style={{ textDecorationLine: "underline", textDecorationColor: "#ff3b30" }}>
        Underlined
      </Text>
      <Text
        testID="struck"
        style={{ textDecorationLine: "line-through", textDecorationStyle: "double", textDecorationThickness: 2 }}
      >
        Struck
      </Text>
      <Text
        testID="both"
        style={{
          textDecorationLine: "underline line-through",
          textDecorationStyle: "wavy",
          textDecorationColor: "rgba(0, 0, 255, 0.5)",
          textUnderlineOffset: 3,
        }}
      >
        Both lines
      </Text>
      <Text testID="dotted" style={{ textDecorationLine: "underline", textDecorationStyle: "dotted" }}>
        Dotted line
      </Text>
      <Text testID="dashed" style={{ textDecorationLine: "underline", textDecorationStyle: "dashed" }}>
        Dashed line
      </Text>
      <Text testID="solid" style={{ textDecorationLine: "underline", textDecorationStyle: "solid" }}>
        Solid line
      </Text>
      <Text testID="undecorated" style={{ textDecorationLine: "none" }}>
        No line
      </Text>
      <Text testID="upper" style={{ textTransform: "uppercase" }}>
        Upper case
      </Text>
      <Text testID="lower" style={{ textTransform: "lowercase" }}>
        LOWER CASE
      </Text>
      <Text testID="capital" style={{ textTransform: "capitalize" }}>
        capital words
      </Text>
      <Text testID="untransformed" style={{ textTransform: "none" }}>
        As written
      </Text>
      <Text testID="align-auto" style={{ textAlign: "auto" }}>
        Auto aligned
      </Text>
      <Text testID="align-left" style={{ textAlign: "left" }}>
        Left aligned
      </Text>
      <Text testID="align-center" style={{ textAlign: "center" }}>
        Centered
      </Text>
      <Text testID="align-right" style={{ textAlign: "right" }}>
        Right aligned
      </Text>
      <Text testID="align-justify" style={{ textAlign: "justify" }}>
        Justified
      </Text>
      <Text testID="align-start" style={{ textAlign: "start" }}>
        Start aligned
      </Text>
      <Text testID="align-end" style={{ textAlign: "end" }}>
        End aligned
      </Text>
      <Text testID="dir-auto" style={{ writingDirection: "auto" }}>
        Direction auto
      </Text>
      <Text testID="dir-ltr" style={{ writingDirection: "ltr" }}>
        Direction ltr
      </Text>
      <Text testID="dir-rtl" style={{ writingDirection: "rtl" }}>
        Direction rtl
      </Text>
      <Text testID="valign-top" style={{ height: 60, textAlignVertical: "top" }}>
        Top<View testID="mark-top" style={{ width: 4, height: 4 }} />
      </Text>
      <Text testID="valign-center" style={{ height: 60, textAlignVertical: "center" }}>
        Middle<View testID="mark-center" style={{ width: 4, height: 4 }} />
      </Text>
      <Text testID="valign-bottom" style={{ height: 60, textAlignVertical: "bottom" }}>
        Bottom<View testID="mark-bottom" style={{ width: 4, height: 4 }} />
      </Text>
      <Text testID="valign-auto" style={{ height: 60, textAlignVertical: "auto" }}>
        Auto<View testID="mark-auto" style={{ width: 4, height: 4 }} />
      </Text>
      <Text testID="overrides" style={{ fontStyle: "italic", textTransform: "uppercase" }}>
        Loud <Text style={{ fontStyle: "normal", textTransform: "none" }}>quiet</Text>
      </Text>
      <Text testID="spans" style={{ fontSize: 12 }}>
        Base{" "}
        <Text style={{ fontFamily: "Menlo" }}>mono</Text>{" "}
        <Text style={{ fontSize: 20 }}>large</Text>{" "}
        <Text style={{ fontStyle: "italic" }}>slanted</Text>{" "}
        <Text style={{ letterSpacing: 2 }}>spaced</Text>{" "}
        <Text style={{ lineHeight: 24 }}>leading</Text>{" "}
        <Text style={{ fontVariant: ["tabular-nums"] }}>figures</Text>{" "}
        <Text style={{ textDecorationLine: "underline", textDecorationColor: "green", textDecorationStyle: "dashed" }}>
          marked
        </Text>{" "}
        <Text style={{ textDecorationLine: "line-through", textDecorationThickness: 1.5, textUnderlineOffset: 2 }}>
          gone
        </Text>{" "}
        <Text style={{ textTransform: "uppercase" }}>shout</Text>{" "}
        <Text style={{ color: "#007aff" }}>
          outer <Text style={{ fontSize: 16 }}>inner</Text>
        </Text>
      </Text>
    </View>
  );
}

export default App;
