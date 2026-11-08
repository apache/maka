// A case of the API's test suite (docs/dev/compatibility.md):
// `selectable` views of `nsh`, texts that select together: a plain
// `Text`, a `TextView` and a nested selectable `View` inside one area, a
// `userSelect: "none"` label that stays out, and a text outside every
// area. Its script checks which views are areas and what the texts carry,
// and what the areas report of their selection (`onSelectionChange`), and
// what a TextView's ref reads of it (`selectedText`, as Markdown and HTML).
import { signal, Text, View } from "nsh";
import { TextView, type TextViewRef } from "nsh/base";

function App() {
  const area = signal("none");
  const own = signal("none");
  const read = signal("none");
  let doc: TextViewRef | undefined;
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Area selected: ${area()}`}</Text>
      <Text>{`Own selected: ${own()}`}</Text>
      <View selectable testID="area" onSelectionChange={(e) => area.set(e.text || "nothing")} style={{ gap: 4 }}>
        <Text>Area first text</Text>
        <TextView testID="area-doc" markdown={"Area **document**\n\n- Area item"} />
        <Text style={{ userSelect: "none" }}>Area label</Text>
        <View selectable testID="inner">
          <Text>Inner text</Text>
        </View>
      </View>
      <Text>{`Own read: ${read()}`}</Text>
      <TextView
        ref={(r) => (doc = r)}
        testID="own"
        selectable
        markdown="**Own** selection"
        onSelectionChange={async (e) => {
          own.set(e.text || "nothing");
          const md = await doc?.selectedText({ format: "markdown" });
          const html = await doc?.selectedText({ format: "html" });
          const plain = await doc?.selectedText();
          read.set(e.text ? `${plain} | ${md} | ${html}` : `${plain || "nothing"}`);
        }}
      />
      <Text>Outside text</Text>
    </View>
  );
}

export default App;
