// A case of the API's test suite (docs/dev/compatibility.md): layout
// direction. Right to left, rows run from the right, the start of a column's
// cross axis is the right edge, the inline start / end keys (insets,
// margins, paddings) take the side their direction gives them and `left` /
// `right` keys keep their sides (as in CSS); `direction` is inherited
// unless a view sets its own. Every test lays its boxes out in a frame of
// its own, and the script checks each box's frame relative to it.
import { Text, View } from "nsh";

type Style = Record<string, unknown>;

// A 50 × 20 box (or as `style` says), named by its testID.
function Box(props: { id: string; style?: Style }) {
  return <View testID={props.id} style={{ width: 50, height: 20, ...props.style }} />;
}

// The frame of one test, 300 × 100 unless `style` says otherwise.
function Frame(props: { id: string; style?: Style; children?: JSX.Element | JSX.Element[] }) {
  return (
    <View testID={props.id} style={{ width: 300, height: 100, ...props.style }}>
      {props.children}
    </View>
  );
}

function App() {
  return (
    <View>
      <Text>Layout direction</Text>
      {/* rows and columns right to left, and left to right for comparison */}
      <Frame id="rtl-row" style={{ direction: "rtl", flexDirection: "row" }}>
        <Box id="rtl-row-a" />
        <Box id="rtl-row-b" />
      </Frame>
      <Frame id="ltr-row" style={{ direction: "ltr", flexDirection: "row" }}>
        <Box id="ltr-row-a" />
        <Box id="ltr-row-b" />
      </Frame>
      <Frame id="rtl-column" style={{ direction: "rtl" }}>
        <Box id="rtl-column-a" />
        <View testID="rtl-column-b" style={{ height: 20 }} />
      </Frame>
      <Frame id="rtl-justify" style={{ direction: "rtl", flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
        <Box id="rtl-justify-a" />
        <Box id="rtl-justify-b" />
      </Frame>
      <Frame id="rtl-wrap" style={{ direction: "rtl", width: 120, flexDirection: "row", flexWrap: "wrap" }}>
        <Box id="rtl-wrap-a" />
        <Box id="rtl-wrap-b" />
        <Box id="rtl-wrap-c" />
      </Frame>
      {/* inherited, set again, and inherited explicitly */}
      <Frame id="inherit" style={{ direction: "rtl" }}>
        <View testID="inherit-row" style={{ height: 20, flexDirection: "row" }}>
          <Box id="inherit-row-a" />
        </View>
        <View testID="inherit-ltr" style={{ height: 20, flexDirection: "row", direction: "ltr" }}>
          <Box id="inherit-ltr-a" />
        </View>
        <View testID="inherit-explicit" style={{ height: 20, flexDirection: "row", direction: "inherit" }}>
          <Box id="inherit-explicit-a" />
        </View>
      </Frame>
      {/* inline start and end insets */}
      <Frame id="ltr-inset" style={{ direction: "ltr" }}>
        <Box id="ltr-inset-start" style={{ position: "absolute", start: 10 }} />
        <Box id="ltr-inset-end" style={{ position: "absolute", end: 10, top: 30 }} />
        <View testID="ltr-inset-both" style={{ position: "absolute", start: 20, end: 40, top: 60, height: 20 }} />
      </Frame>
      <Frame id="rtl-inset" style={{ direction: "rtl" }}>
        <Box id="rtl-inset-start" style={{ position: "absolute", start: 10 }} />
        <Box id="rtl-inset-end" style={{ position: "absolute", end: 10, top: 30 }} />
        <View testID="rtl-inset-both" style={{ position: "absolute", start: 20, end: 40, top: 60, height: 20 }} />
      </Frame>
      <Frame id="rtl-inset-percent" style={{ direction: "rtl" }}>
        <Box id="rtl-inset-percent-a" style={{ position: "absolute", start: "10%" }} />
      </Frame>
      {/* left and right right to left, and the inline start over left */}
      <Frame id="rtl-sides" style={{ direction: "rtl" }}>
        <Box id="rtl-sides-left" style={{ position: "absolute", left: 10 }} />
        <Box id="rtl-sides-right" style={{ position: "absolute", right: 10, top: 30 }} />
      </Frame>
      <Frame id="start-wins">
        <Box id="start-wins-a" style={{ position: "absolute", left: 5, start: 20 }} />
      </Frame>
      {/* marginStart and marginEnd */}
      <Frame id="ltr-margin" style={{ direction: "ltr", flexDirection: "row" }}>
        <Box id="ltr-margin-a" style={{ marginStart: 10, marginEnd: 15 }} />
        <Box id="ltr-margin-b" />
      </Frame>
      <Frame id="rtl-margin" style={{ direction: "rtl", flexDirection: "row" }}>
        <Box id="rtl-margin-a" style={{ marginStart: 10, marginEnd: 15 }} />
        <Box id="rtl-margin-b" />
      </Frame>
      <Frame id="rtl-margin-right" style={{ direction: "rtl", flexDirection: "row" }}>
        <Box id="rtl-margin-right-a" style={{ marginRight: 15 }} />
        <Box id="rtl-margin-right-b" />
      </Frame>
      {/* paddingStart and paddingEnd */}
      <Frame id="ltr-padding" style={{ direction: "ltr", paddingStart: 12, paddingEnd: 30 }}>
        <View testID="ltr-padding-a" style={{ height: 20 }} />
      </Frame>
      <Frame id="rtl-padding" style={{ direction: "rtl", paddingStart: 12, paddingEnd: 30 }}>
        <View testID="rtl-padding-a" style={{ height: 20 }} />
      </Frame>
      <Frame id="rtl-padding-sides" style={{ direction: "rtl", paddingLeft: 12, paddingRight: 30 }}>
        <View testID="rtl-padding-sides-a" style={{ height: 20 }} />
      </Frame>
    </View>
  );
}

export default App;
