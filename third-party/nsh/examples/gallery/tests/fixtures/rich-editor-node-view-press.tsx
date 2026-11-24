import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Button, RichEditor, StarterKit, createRichEditor, defineExtension, type RichNodeViewProps } from "nsh/base";

// Node views pressed on their own area and on a button inside them: an
// inline stock tag (at 5) and a block card (at 11), neither with a press
// handler of its own around the whole view.
const pressed = signal("none");

function Tag(props: RichNodeViewProps) {
  return (
    <View class="flex-row gap-1">
      <Text>{`Tag ${props.node.attrs.symbol}${props.selected ? " selected" : ""}`}</Text>
      <Button testID="tag-button" onPress={() => pressed.set("tag button")}>
        <Text>Trend</Text>
      </Button>
    </View>
  );
}

function Card(props: RichNodeViewProps) {
  return (
    <View class="p-3 gap-2">
      <Text>{`Card ${props.node.attrs.id}${props.selected ? " selected" : ""}`}</Text>
      <Button testID="card-button" onPress={() => pressed.set("card button")}>
        <Text>Open</Text>
      </Button>
    </View>
  );
}

const StockTag = defineExtension({
  name: "stock",
  node: { group: "inline", inline: true, atom: true, selectable: true, attrs: { symbol: { default: "" } } },
  addNodeView: () => Tag,
});

const OrderCard = defineExtension({
  name: "card",
  node: { group: "block", atom: true, selectable: true, draggable: true, attrs: { id: { default: "" } } },
  addNodeView: () => Card,
});

function App() {
  const editor = createRichEditor({
    extensions: [StarterKit, StockTag, OrderCard],
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Buy " }, { type: "stock", attrs: { symbol: "AAPL" } }, { type: "text", text: " now" }],
        },
        { type: "card", attrs: { id: "42" } },
        { type: "paragraph", content: [{ type: "text", text: "End" }] },
      ],
    },
  });
  const selection = signal("none");
  editor.on("transaction", () => {
    const s = editor.state.selection;
    selection.set(`${s.type} ${s.anchor}`);
  });
  return (
    <View class="flex-1 pt-16 px-4 gap-2">
      <Text>{`selection: ${selection()}`}</Text>
      <Text>{`pressed: ${pressed()}`}</Text>
      <RichEditor editor={editor} testID="editor" class="h-80 text-foreground" />
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
