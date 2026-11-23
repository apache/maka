// Node view benchmark: one paragraph holding 300 inline stock tags, each
// rendered by the app's component (`addNodeView`). Each press inserts or
// removes one character at the paragraph's start: every tag moves and its
// span is made again, yet no tag's value changes, so no JS runs for them.
// Runtimes without `addNodeView` draw the tags as plain atoms.
import { mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import {
  Button, chain, createRichEditor, defineExtension, insertText, RichEditor, type RichNodeJSON,
  type RichNodeViewProps, setTextSelection, StarterKit,
} from "nsh/base";

function Tag(props: RichNodeViewProps) {
  return (
    <View style={{ paddingHorizontal: 4, borderRadius: 4, borderWidth: 1, borderColor: props.selected ? "#2563eb" : "#d4d4d8" }}>
      <Text>{`$${props.node.attrs.symbol}`}</Text>
    </View>
  );
}

const Stock = defineExtension({
  name: "stock",
  node: { group: "inline", inline: true, atom: true, attrs: { symbol: { default: "" } } },
  addNodeView: () => Tag,
});

const content: RichNodeJSON[] = [];
for (let i = 0; i < 300; i++) {
  content.push({ type: "text", text: " and " });
  content.push({ type: "stock", attrs: { symbol: `S${String(i).padStart(3, "0")}` } });
}

function App() {
  const editor = createRichEditor({
    extensions: [StarterKit, Stock],
    doc: { type: "doc", content: [{ type: "paragraph", content }] },
  });
  let inserted = false;
  return (
    <View style={{ flex: 1 }}>
      <Button testID="edit" onPress={() => {
        editor.run(chain([setTextSelection(1, inserted ? 2 : 1), insertText(inserted ? "" : "x")]));
        inserted = !inserted;
      }}>
        <Text>Edit before the tags</Text>
      </Button>
      <RichEditor editor={editor} testID="perf-editor" style={{ flex: 1 }} />
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
