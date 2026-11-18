// A case of the API's test suite (docs/dev/compatibility.md): an
// extension's node view (`addNodeView`): the app's component renders an
// inline atom with `RichNodeViewProps` (`node`, `selected`, `editor`,
// `extension`), its props follow the node in place (`updateAttributes`, a
// node selection) without calling the component again, `getPos` follows
// an edit before it, `deleteNode` is one undoable change, and a node type
// with content is refused.
import { Text, View, signal } from "nsh";
import {
  RichEditor,
  RichEditorSession,
  RichNodeViewProps,
  StarterKit,
  chain,
  createRichEditor,
  defineExtension,
  insertText,
  setNodeSelection,
  setTextSelection,
  undo,
} from "nsh/base";

let calls = 0;
const mounts = signal(0);
const facts = signal("none");
let shown: RichNodeViewProps | undefined;

function Ticker(props: RichNodeViewProps) {
  mounts.set(++calls);
  shown = props;
  facts.set(
    `${props instanceof RichNodeViewProps} ${props.editor instanceof RichEditorSession} ${props.extension.name} ${props.extension.options.exchange} ${props.node.type} ${props.node.textContent === ""}`,
  );
  return (
    <View testID="ticker" onPress={() => props.updateAttributes({ symbol: `${props.node.attrs.symbol}X` })}>
      <Text>{`Ticker ${props.node.attrs.symbol}${props.selected ? " selected" : ""}`}</Text>
    </View>
  );
}

export default function BaseRichEditorNodeView() {
  // Made when the case runs, so a check that drops `name` breaks only this case.
  const TickerTag = defineExtension({
    name: "ticker",
    addOptions: () => ({ exchange: "NYSE" }),
    node: { group: "inline", inline: true, atom: true, attrs: { symbol: { default: "" } } },
    addNodeView: () => Ticker,
  });
  const editor = createRichEditor({
    extensions: [StarterKit, TickerTag],
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Buy " }, { type: "ticker", attrs: { symbol: "IBM" } }] }],
    },
  });
  const count = () => JSON.stringify(editor.getJSON()).split('"ticker"').length - 1;
  const tickers = signal(count());
  const pos = signal("none");
  editor.on("transaction", () => tickers.set(count()));
  // A node view of a type with content is refused.
  let refused = "no";
  try {
    createRichEditor({
      extensions: [
        StarterKit,
        defineExtension({ name: "callout", node: { group: "block", content: "inline*" }, addNodeView: () => Ticker }),
      ],
    });
  } catch (e) {
    refused = (e as Error).message.includes("atoms") ? "refused" : "other";
  }
  return (
    <View style={{ gap: 4 }}>
      <Text>{`NodeViewFacts: ${facts()}`}</Text>
      <Text>{`NodeViewMounts: ${mounts()} tickers ${tickers()} pos ${pos()} content ${refused}`}</Text>
      <View onPress={() => editor.run(chain([setTextSelection(1), insertText("Go ")]))}>
        <Text>TypeBeforeTicker</Text>
      </View>
      <View onPress={() => pos.set(String(shown?.getPos()))}>
        <Text>ReadTickerPos</Text>
      </View>
      <View onPress={() => editor.run(setNodeSelection(shown?.getPos() ?? 0))}>
        <Text>SelectTicker</Text>
      </View>
      <View onPress={() => shown?.deleteNode()}>
        <Text>DeleteTicker</Text>
      </View>
      <View onPress={() => editor.run(undo())}>
        <Text>UndoTicker</Text>
      </View>
      <RichEditor editor={editor} style={{ height: 80 }} />
    </View>
  );
}
