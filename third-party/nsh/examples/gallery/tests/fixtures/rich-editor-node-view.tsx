import { context, mount, signal, Text, View } from "nsh";
import {
  RichEditor, StarterKit, chain, createRichEditor, defineExtension, insertText, setNodeSelection, setTextSelection, undo,
  type RichNodeViewProps,
} from "nsh/base";

// An inline stock tag rendered by the app's component (`addNodeView`): it
// shows its attributes and whether it is selected, and changes or deletes
// its node through the editor. `mounts` counts the component's calls: a
// change of the node updates its props, it does not call it again.
const mounts = signal(0);
let calls = 0;
const pressedAt = signal<number | null>(null);
let shown: RichNodeViewProps | undefined;
// Provided around the editor: its node views read it as any child would.
const Market = context("none");

function Stock(props: RichNodeViewProps) {
  mounts.set(++calls);
  shown = props;
  const press = () => {
    pressedAt.set(props.getPos());
    props.updateAttributes({ symbol: `${props.node.attrs.symbol}X` });
  };
  return (
    <View testID="stock" onPress={press}>
      <Text>{`Tag ${props.node.attrs.symbol}${props.selected ? " selected" : ""} of ${props.extension.name} in ${Market()}`}</Text>
    </View>
  );
}

const StockTag = defineExtension({
  name: "stock",
  node: { group: "inline", inline: true, atom: true, attrs: { symbol: { default: "" } } },
  addNodeView: () => Stock,
});

function App() {
  const editor = createRichEditor({
    extensions: [StarterKit, StockTag],
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Buy " }, { type: "stock", attrs: { symbol: "AAPL" } }, { type: "text", text: " now" }],
        },
      ],
    },
  });
  const read = () => `${editor.getText()} tags ${JSON.stringify(editor.getJSON()).split('"stock"').length - 1}`;
  const doc = signal(read());
  editor.on("transaction", () => doc.set(read()));
  return (
    <View class="flex-1 pt-16 px-4 gap-2">
      <Text>{`doc: ${doc()}`}</Text>
      <Text>{`mounts: ${mounts()} pressed at: ${pressedAt()}`}</Text>
      <Text testID="type" onPress={() => editor.run(chain([setTextSelection(1), insertText("Hey ")]))}>TypeBefore</Text>
      <Text testID="select" onPress={() => editor.run(setNodeSelection(shown?.getPos() ?? 0))}>SelectTag</Text>
      <Text testID="delete" onPress={() => shown?.deleteNode()}>DeleteTag</Text>
      <Text testID="undo" onPress={() => editor.run(undo())}>Undo</Text>
      <Market.Provider value="NASDAQ">
        <RichEditor editor={editor} testID="editor" class="h-40 text-foreground" />
      </Market.Provider>
    </View>
  );
}

mount(App);
