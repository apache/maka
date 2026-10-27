// A case of the API's test suite (docs/dev/compatibility.md): the box of a
// view: margins and paddings (each side, the shorthands, points, percents
// and `auto`), minimum and maximum sizes clamping what a view asks for,
// aspect ratios, absolute and relative positioning with insets in points
// and percents, `display`, the order `zIndex` gives siblings and clipping.
// Every test lays its boxes out in a frame of its own, and the script checks
// each box's frame relative to it.
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
      <Text>Box layout</Text>
      {/* padding: the content box of a frame, its children stretched across it */}
      <Frame id="padding" style={{ padding: 10 }}>
        <View testID="padding-a" style={{ height: 20 }} />
      </Frame>
      <Frame id="padding-axes" style={{ paddingHorizontal: 20, paddingVertical: 5 }}>
        <View testID="padding-axes-a" style={{ height: 20 }} />
      </Frame>
      <Frame id="padding-sides" style={{ paddingLeft: 7, paddingRight: 9, paddingBottom: 30, justifyContent: "flex-end" }}>
        <View testID="padding-sides-a" style={{ height: 20 }} />
      </Frame>
      <Frame id="padding-override" style={{ padding: 10, paddingHorizontal: 2, paddingLeft: 6 }}>
        <View testID="padding-override-a" style={{ height: 20 }} />
      </Frame>
      <Frame id="padding-percent" style={{ padding: "10%" }}>
        <View testID="padding-percent-a" style={{ height: 20 }} />
      </Frame>
      {/* a frame sized by its content and padding */}
      <Frame id="padding-hug-frame" style={{ alignItems: "flex-start" }}>
        <View testID="padding-hug" style={{ paddingTop: 3, paddingBottom: 15, paddingRight: 11 }}>
          <Box id="padding-hug-a" />
        </View>
      </Frame>
      {/* margin */}
      <Frame id="margin">
        <View testID="margin-a" style={{ height: 20, margin: 10 }} />
      </Frame>
      <Frame id="margin-axes">
        <View testID="margin-axes-a" style={{ height: 20, marginHorizontal: 20, marginVertical: 6 }} />
      </Frame>
      <Frame id="margin-sides" style={{ flexDirection: "row" }}>
        <Box id="margin-sides-a" style={{ marginRight: 15 }} />
        <Box id="margin-sides-b" />
      </Frame>
      <Frame id="margin-bottom">
        <Box id="margin-bottom-a" style={{ marginBottom: 12 }} />
        <Box id="margin-bottom-b" />
      </Frame>
      <Frame id="margin-override">
        <View testID="margin-override-a" style={{ height: 20, margin: 10, marginHorizontal: 4, marginRight: 30 }} />
      </Frame>
      <Frame id="margin-percent">
        <Box id="margin-percent-a" style={{ margin: "5%" }} />
      </Frame>
      <Frame id="margin-auto">
        <Box id="margin-auto-a" style={{ marginHorizontal: "auto" }} />
        <Box id="margin-auto-b" style={{ margin: "auto" }} />
      </Frame>
      <Frame id="margin-negative" style={{ flexDirection: "row" }}>
        <Box id="margin-negative-a" />
        <Box id="margin-negative-b" style={{ marginLeft: -20, marginVertical: -5 }} />
      </Frame>
      {/* minimum and maximum sizes */}
      <Frame id="min" style={{ alignItems: "flex-start" }}>
        <View testID="min-a" style={{ width: 20, height: 10, minWidth: 60, minHeight: 30 }} />
        <View testID="min-b" style={{ minWidth: "50%", minHeight: 8 }} />
      </Frame>
      <Frame id="max" style={{ alignItems: "flex-start" }}>
        <View testID="max-a" style={{ width: 200, height: 90, maxWidth: 80, maxHeight: 40 }} />
        <View testID="max-b" style={{ width: 280, height: 10, maxWidth: "50%" }} />
      </Frame>
      <Frame id="max-stretch">
        <View testID="max-stretch-a" style={{ height: 20, maxWidth: 120 }} />
      </Frame>
      <Frame id="min-max" style={{ alignItems: "flex-start" }}>
        <View testID="min-max-a" style={{ width: 70, height: 20, minWidth: 100, maxWidth: 50 }} />
      </Frame>
      <Frame id="max-grow" style={{ flexDirection: "row" }}>
        <View testID="max-grow-a" style={{ height: 20, flexGrow: 1, maxWidth: 100 }} />
        <View testID="max-grow-b" style={{ height: 20, flexGrow: 1 }} />
      </Frame>
      <Frame id="min-shrink" style={{ flexDirection: "row" }}>
        <View testID="min-shrink-a" style={{ width: 200, height: 20, flexShrink: 1, minWidth: 180 }} />
        <View testID="min-shrink-b" style={{ width: 200, height: 20, flexShrink: 1 }} />
      </Frame>
      {/* `minWidth: "auto"`: CSS's automatic minimum, the content's width;
          unset, a shrinking item's minimum is 0 (Yoga's) */}
      <Frame id="min-auto" style={{ flexDirection: "row" }}>
        <View testID="min-auto-a" style={{ flexShrink: 1, minWidth: "auto" }}>
          <View style={{ width: 200, height: 20 }} />
        </View>
        <View testID="min-auto-b" style={{ width: 200, height: 20 }} />
      </Frame>
      <Frame id="min-unset" style={{ flexDirection: "row" }}>
        <View testID="min-unset-a" style={{ flexShrink: 1 }}>
          <View style={{ width: 200, height: 20 }} />
        </View>
        <View testID="min-unset-b" style={{ width: 200, height: 20 }} />
      </Frame>
      {/* aspectRatio: from the width, from the height (CSS's ratio), from a stretched width */}
      <Frame id="ratio" style={{ height: 160, alignItems: "flex-start" }}>
        <View testID="ratio-a" style={{ width: 100, aspectRatio: 2 }} />
        <View testID="ratio-b" style={{ height: 60, aspectRatio: "3 / 2" }} />
      </Frame>
      <Frame id="ratio-stretch" style={{ height: 160 }}>
        <View testID="ratio-stretch-a" style={{ aspectRatio: 3 }} />
      </Frame>
      {/* position: absolute boxes leave the flow, inset from the frame's edges */}
      <Frame id="absolute" style={{ padding: 4 }}>
        <Box id="absolute-tl" style={{ position: "absolute", top: 10, left: 20 }} />
        <Box id="absolute-br" style={{ position: "absolute", right: 10, bottom: 5 }} />
        <View testID="absolute-fill" style={{ position: "absolute", left: 10, right: 30, top: 0, bottom: 0 }} />
        <Box id="absolute-percent" style={{ position: "absolute", top: "50%", left: "25%" }} />
        <View testID="absolute-size" style={{ position: "absolute", width: "50%", height: "10%" }} />
        <Box id="absolute-flow" />
      </Frame>
      <Frame id="absolute-align" style={{ alignItems: "center", justifyContent: "flex-end" }}>
        <Box id="absolute-align-a" style={{ position: "absolute" }} />
      </Frame>
      <Frame id="relative">
        <Box id="relative-a" style={{ position: "relative", top: 5, left: 7 }} />
        <Box id="relative-b" style={{ position: "relative", bottom: 5, right: 7 }} />
        <Box id="relative-c" />
      </Frame>
      {/* display */}
      <Frame id="display">
        <Box id="display-none" style={{ display: "none" }} />
        <Box id="display-a" />
      </Frame>
      <Frame id="display-flex" style={{ display: "flex", flexDirection: "row" }}>
        <Box id="display-flex-a" />
        <Box id="display-flex-b" />
      </Frame>
      <Frame id="display-row" style={{ display: "flex" }}>
        <Box id="display-row-a" />
        <Box id="display-row-b" />
      </Frame>
      <Frame id="display-block" style={{ display: "block", flexDirection: "row" }}>
        <View testID="display-block-a" style={{ height: 20 }} />
        <Box id="display-block-b" />
      </Frame>
      {/* zIndex: the higher a sibling's, the later it comes natively (on top) */}
      <Frame id="z">
        <Box id="z-first" style={{ position: "absolute", top: 0, zIndex: 2 }} />
        <Box id="z-first" style={{ position: "absolute", top: 30, zIndex: 1 }} />
        <Box id="z-first" style={{ position: "absolute", top: 60 }} />
      </Frame>
      <Frame id="z-negative">
        <Box id="z-low" style={{ position: "absolute", top: 0 }} />
        <Box id="z-low" style={{ position: "absolute", top: 30, zIndex: -1 }} />
      </Frame>
      {/* overflow */}
      <Frame id="overflow" style={{ overflow: "hidden" }}>
        <Box id="overflow-a" style={{ width: 400, height: 150 }} />
      </Frame>
      <Frame id="overflow-visible" style={{ overflow: "visible" }}>
        <Box id="overflow-visible-a" style={{ width: 400 }} />
      </Frame>
    </View>
  );
}

export default App;
