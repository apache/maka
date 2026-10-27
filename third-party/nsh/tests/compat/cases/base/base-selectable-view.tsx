// A case of the API's test suite (docs/dev/compatibility.md):
// `selectable` views of `nsh`, texts that select together: a plain
// `Text`, a `TextView` and a nested selectable `View` inside one area, a
// `selectable={false}` label that stays out, and a text outside every
// area. Its script checks which views are areas and what the texts carry.
import { Text, View } from "nsh";
import { TextView } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <View selectable testID="area" style={{ gap: 4 }}>
        <Text>Area first text</Text>
        <TextView testID="area-doc" markdown={"Area **document**\n\n- Area item"} />
        <Text selectable={false}>Area label</Text>
        <View selectable testID="inner">
          <Text>Inner text</Text>
        </View>
      </View>
      <TextView testID="own" selectable markdown="Own selection" />
      <Text>Outside text</Text>
    </View>
  );
}

export default App;
