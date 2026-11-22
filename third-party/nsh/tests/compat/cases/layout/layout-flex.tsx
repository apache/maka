// A case of the API's test suite (docs/dev/compatibility.md): flexbox
// layout as React Native defines it (column by default, no shrinking, lines
// packed at the start), each key with several of its values: the four
// directions, every justification and alignment, growing, shrinking and
// bases, wrapping lines and their distribution, and gaps. Every test lays
// its boxes out in a frame of its own, and the script checks each box's
// frame relative to it.
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
      <Text>Flex layout</Text>
      {/* flexDirection */}
      <Frame id="row" style={{ flexDirection: "row" }}>
        <Box id="row-a" />
        <Box id="row-b" />
      </Frame>
      <Frame id="column" style={{ flexDirection: "column" }}>
        <Box id="column-a" />
        <Box id="column-b" />
      </Frame>
      <Frame id="row-reverse" style={{ flexDirection: "row-reverse" }}>
        <Box id="row-reverse-a" />
        <Box id="row-reverse-b" />
      </Frame>
      <Frame id="column-reverse" style={{ flexDirection: "column-reverse" }}>
        <Box id="column-reverse-a" />
        <Box id="column-reverse-b" />
      </Frame>
      {/* justifyContent, along a row */}
      <Frame id="jc-start" style={{ flexDirection: "row", justifyContent: "flex-start" }}>
        <Box id="jc-start-a" />
        <Box id="jc-start-b" />
      </Frame>
      <Frame id="jc-center" style={{ flexDirection: "row", justifyContent: "center" }}>
        <Box id="jc-center-a" />
        <Box id="jc-center-b" />
      </Frame>
      <Frame id="jc-end" style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Box id="jc-end-a" />
        <Box id="jc-end-b" />
      </Frame>
      <Frame id="jc-between" style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Box id="jc-between-a" />
        <Box id="jc-between-b" />
      </Frame>
      <Frame id="jc-around" style={{ flexDirection: "row", justifyContent: "space-around" }}>
        <Box id="jc-around-a" />
        <Box id="jc-around-b" />
      </Frame>
      <Frame id="jc-evenly" style={{ width: 250, flexDirection: "row", justifyContent: "space-evenly" }}>
        <Box id="jc-evenly-a" />
        <Box id="jc-evenly-b" />
      </Frame>
      {/* justifyContent, along a column */}
      <Frame id="jc-column" style={{ justifyContent: "flex-end" }}>
        <Box id="jc-column-a" />
      </Frame>
      {/* alignItems, across a row */}
      <Frame id="ai-start" style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <Box id="ai-start-a" />
      </Frame>
      <Frame id="ai-center" style={{ flexDirection: "row", alignItems: "center" }}>
        <Box id="ai-center-a" />
      </Frame>
      <Frame id="ai-end" style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <Box id="ai-end-a" />
      </Frame>
      <Frame id="ai-stretch" style={{ flexDirection: "row", alignItems: "stretch" }}>
        <View testID="ai-stretch-a" style={{ width: 50 }} />
      </Frame>
      <Frame id="ai-baseline" style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Box id="ai-baseline-a" />
        <Box id="ai-baseline-b" style={{ height: 40 }} />
      </Frame>
      {/* alignItems, across a column (stretch is the default) */}
      <Frame id="ai-column" style={{ alignItems: "center" }}>
        <Box id="ai-column-a" />
        <View testID="ai-column-b" style={{ height: 20 }} />
      </Frame>
      {/* alignSelf against the frame's alignItems */}
      <Frame id="as" style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <Box id="as-start" style={{ alignSelf: "flex-start" }} />
        <Box id="as-center" style={{ alignSelf: "center" }} />
        <Box id="as-end" style={{ alignSelf: "flex-end" }} />
        <View testID="as-stretch" style={{ width: 50, alignSelf: "stretch" }} />
        <Box id="as-auto" style={{ alignSelf: "auto" }} />
      </Frame>
      {/* flexGrow: the free 200 points shared 1 : 3 */}
      <Frame id="grow" style={{ flexDirection: "row" }}>
        <Box id="grow-a" style={{ flexGrow: 1 }} />
        <Box id="grow-b" style={{ flexGrow: 3 }} />
      </Frame>
      {/* flexGrow in a column */}
      <Frame id="grow-column">
        <Box id="grow-column-a" />
        <Box id="grow-column-b" style={{ flexGrow: 1 }} />
      </Frame>
      {/* flexShrink: 100 points too many, taken 1 : 3 weighted by size */}
      <Frame id="shrink" style={{ flexDirection: "row" }}>
        <Box id="shrink-a" style={{ width: 200, flexShrink: 1 }} />
        <Box id="shrink-b" style={{ width: 200, flexShrink: 3 }} />
      </Frame>
      {/* without flexShrink nothing shrinks: the row overflows */}
      <Frame id="no-shrink" style={{ flexDirection: "row" }}>
        <Box id="no-shrink-a" style={{ width: 200 }} />
        <Box id="no-shrink-b" style={{ width: 200 }} />
      </Frame>
      {/* flexBasis in points and percent, then growing from bases */}
      <Frame id="basis" style={{ flexDirection: "row" }}>
        <View testID="basis-a" style={{ flexBasis: 120, height: 20 }} />
        <View testID="basis-b" style={{ flexBasis: "50%", height: 20 }} />
      </Frame>
      <Frame id="basis-grow" style={{ flexDirection: "row" }}>
        <View testID="basis-grow-a" style={{ flexBasis: 100, flexGrow: 1, height: 20 }} />
        <View testID="basis-grow-b" style={{ flexBasis: 0, flexGrow: 1, height: 20 }} />
      </Frame>
      {/* flex: CSS's shorthand. A number n is n 1 0, the keywords, grow
          shrink basis written out; `0` shrinks to the minimum, 0 unless set */}
      <Frame id="flex-number" style={{ flexDirection: "row" }}>
        <View testID="flex-number-a" style={{ flex: 1, height: 20 }} />
        <View testID="flex-number-b" style={{ flex: 2, height: 20 }} />
      </Frame>
      <Frame id="flex-auto" style={{ flexDirection: "row" }}>
        <View testID="flex-auto-a" style={{ flex: "auto", width: 100, height: 20 }} />
        <View testID="flex-auto-b" style={{ width: 50, height: 20 }} />
      </Frame>
      <Frame id="flex-none" style={{ flexDirection: "row" }}>
        <View testID="flex-none-a" style={{ flex: "none", width: 200, height: 20 }} />
        <View testID="flex-none-b" style={{ width: 200, flexShrink: 1, height: 20 }} />
      </Frame>
      <Frame id="flex-written" style={{ flexDirection: "row" }}>
        <View testID="flex-written-a" style={{ flex: "1 0 100px", height: 20 }} />
        <View testID="flex-written-b" style={{ flex: 1, height: 20 }} />
      </Frame>
      <Frame id="flex-zero" style={{ flexDirection: "row" }}>
        <View testID="flex-zero-a" style={{ flex: 0, height: 20 }}>
          <View style={{ width: 80, height: 20 }} />
        </View>
      </Frame>
      {/* flexWrap: three 50-point boxes in 120 points */}
      <Frame id="wrap" style={{ width: 120, flexDirection: "row", flexWrap: "wrap" }}>
        <Box id="wrap-a" />
        <Box id="wrap-b" />
        <Box id="wrap-c" />
      </Frame>
      <Frame id="nowrap" style={{ width: 120, flexDirection: "row", flexWrap: "nowrap" }}>
        <Box id="nowrap-a" />
        <Box id="nowrap-b" />
        <Box id="nowrap-c" />
      </Frame>
      <Frame id="wrap-reverse" style={{ width: 120, flexDirection: "row", flexWrap: "wrap-reverse" }}>
        <Box id="wrap-reverse-a" />
        <Box id="wrap-reverse-b" />
        <Box id="wrap-reverse-c" />
      </Frame>
      <Frame id="wrap-column" style={{ height: 50, flexWrap: "wrap" }}>
        <Box id="wrap-column-a" />
        <Box id="wrap-column-b" />
        <Box id="wrap-column-c" />
      </Frame>
      {/* alignContent: two lines of 20 points in 100 */}
      <Frame id="ac-start" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "flex-start" }}>
        <Box id="ac-start-a" />
        <Box id="ac-start-b" />
        <Box id="ac-start-c" />
      </Frame>
      <Frame id="ac-center" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "center" }}>
        <Box id="ac-center-a" />
        <Box id="ac-center-b" />
        <Box id="ac-center-c" />
      </Frame>
      <Frame id="ac-end" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "flex-end" }}>
        <Box id="ac-end-a" />
        <Box id="ac-end-b" />
        <Box id="ac-end-c" />
      </Frame>
      <Frame id="ac-between" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "space-between" }}>
        <Box id="ac-between-a" />
        <Box id="ac-between-b" />
        <Box id="ac-between-c" />
      </Frame>
      <Frame id="ac-around" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "space-around" }}>
        <Box id="ac-around-a" />
        <Box id="ac-around-b" />
        <Box id="ac-around-c" />
      </Frame>
      <Frame id="ac-evenly" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "space-evenly" }}>
        <Box id="ac-evenly-a" />
        <Box id="ac-evenly-b" />
        <Box id="ac-evenly-c" />
      </Frame>
      <Frame id="ac-stretch" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", alignContent: "stretch" }}>
        <View testID="ac-stretch-a" style={{ width: 50 }} />
        <View testID="ac-stretch-b" style={{ width: 50 }} />
        <View testID="ac-stretch-c" style={{ width: 50 }} />
      </Frame>
      {/* gap, rowGap and columnGap */}
      <Frame id="gap-row" style={{ flexDirection: "row", gap: 10 }}>
        <Box id="gap-row-a" />
        <Box id="gap-row-b" />
      </Frame>
      <Frame id="gap-column" style={{ gap: 8 }}>
        <Box id="gap-column-a" />
        <Box id="gap-column-b" />
      </Frame>
      <Frame id="gap-wrap" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Box id="gap-wrap-a" />
        <Box id="gap-wrap-b" />
        <Box id="gap-wrap-c" />
      </Frame>
      <Frame id="gaps" style={{ width: 120, flexDirection: "row", flexWrap: "wrap", rowGap: 10, columnGap: 5 }}>
        <Box id="gaps-a" />
        <Box id="gaps-b" />
        <Box id="gaps-c" />
      </Frame>
      <Frame id="gap-override" style={{ flexDirection: "row", gap: 30, columnGap: 4 }}>
        <Box id="gap-override-a" />
        <Box id="gap-override-b" />
      </Frame>
    </View>
  );
}

export default App;
