// A case of the API's test suite (docs/dev/compatibility.md): views with
// `position: "sticky"` (its `top` a length or an animated value), laid
// out in the flow and sticking in the viewport of the scroll view around
// them. Its script checks where they are laid out and the travel the
// scroll view gets.
import { Scroll, Text, View } from "nsh";
import { createAnimatedValue } from "nsh/animated";

function App() {
  const bar = createAnimatedValue(20);
  return (
    <View style={{ flex: 1 }}>
      <Scroll testID="sticky-bar-page" style={{ height: 300 }}>
        <View style={{ height: 100 }}>
          <Text>Bar page header</Text>
        </View>
        <View testID="sticky-bar" style={{ position: "sticky", top: 16, height: 40 }}>
          <Text>Sticky bar</Text>
        </View>
        <View style={{ height: 1000 }} />
      </Scroll>
      <Scroll testID="sticky-style-page" style={{ height: 300 }}>
        <View style={{ height: 50 }} />
        <View style={{ height: 400 }}>
          <View testID="sticky-heading" style={{ position: "sticky", top: 0, height: 30 }}>
            <Text>Sticky heading</Text>
          </View>
          <View style={{ height: 370 }} />
        </View>
        <View style={{ height: 1000 }} />
      </Scroll>
      <Scroll style={{ height: 200 }}>
        <View style={{ height: 60 }} />
        <View testID="sticky-animated" style={{ position: "sticky", top: bar, height: 30 }}>
          <Text>Sticky animated</Text>
        </View>
        <View style={{ height: 600 }} />
      </Scroll>
    </View>
  );
}

export default App;
