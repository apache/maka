import { signal, Text, View } from "nsh";
import { RichEditor, StarterKit, createRichEditor, defineExtension, redo, type RichNodeJSON, type RichNodeViewProps, undo } from "nsh/base";
import { alpha, colors, mono, plural, richEditorClasses } from "../ui";
import { IconButton, TOOL_GAP, ToolbarSeparator } from "./RichEditorUi";

// An extension's node view (`addNodeView`): the app's own component renders
// every node of the extension's type, here a stock tag in the text and a
// stock card between paragraphs. Both are atoms: the caret steps over them
// as one character or one block, Backspace deletes them. Typing never calls the components: they run when a node appears,
// and their props (`node`, `selected`) change in place when its attributes
// or its selection do. `updateAttributes` and `deleteNode` change the
// document through the editor, one undoable change each.

type Quote = { name: string; price: number; change: number };

const QUOTES: Record<string, Quote> = {
  AAPL: { name: "Apple", price: 228.52, change: 1.24 },
  NVDA: { name: "NVIDIA", price: 141.98, change: 3.87 },
  TSLA: { name: "Tesla", price: 352.56, change: -2.13 },
  MSFT: { name: "Microsoft", price: 415.49, change: -0.42 },
};

const percent = (change: number) => `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
const tone = (change: number) => (change >= 0 ? colors.up : colors.down);

/** A stock in the text: its symbol and today's change, a ring while selected. */
function StockTag(props: RichNodeViewProps) {
  const quote = () => QUOTES[props.node.attrs.symbol as string];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 5,
        borderRadius: 5,
        backgroundColor: alpha(colors.accent, 0.1),
        borderWidth: 1,
        borderColor: props.selected ? colors.accent : "transparent",
      }}
    >
      <Text style={{ fontWeight: "600", color: colors.accent }}>{`$${props.node.attrs.symbol}`}</Text>
      <Text style={{ fontSize: 12, color: tone(quote()?.change ?? 0), fontVariant: ["tabular-nums"] }}>
        {quote() ? percent(quote().change) : "—"}
      </Text>
    </View>
  );
}

/** A stock between paragraphs: the quote, a refresh that writes the node's
 * `price` attribute and a remove button. */
function StockCard(props: RichNodeViewProps) {
  const symbol = () => props.node.attrs.symbol as string;
  const price = () => Number(props.node.attrs.price ?? QUOTES[symbol()]?.price ?? 0);
  const change = () => QUOTES[symbol()]?.change ?? 0;
  const refresh = () => props.updateAttributes({ price: Math.round(price() * (1 + (Math.random() - 0.5) / 50) * 100) / 100 });
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: props.selected ? colors.accent : colors.border,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, color: colors.muted }}>{QUOTES[symbol()]?.name ?? symbol()}</Text>
        <Text style={{ fontSize: 22, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{price().toFixed(2)}</Text>
        <Text style={{ fontSize: 13, color: tone(change()), fontVariant: ["tabular-nums"] }}>{`${symbol()} ${percent(change())}`}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: TOOL_GAP }}>
        <IconButton icon="refresh-cw" label="Refresh the price" onPress={refresh} />
        <IconButton icon="trash" label="Remove the card" onPress={() => props.deleteNode()} />
      </View>
    </View>
  );
}

const Stock = defineExtension({
  name: "stock",
  node: { group: "inline", inline: true, atom: true, attrs: { symbol: { default: "AAPL" } } },
  addNodeView: () => StockTag,
});

const StockCardNode = defineExtension({
  name: "stockCard",
  node: { group: "block", atom: true, attrs: { symbol: { default: "NVDA" }, price: { default: null } } },
  addNodeView: () => StockCard,
});

// The tags sit centered on the text's line.
const classes = { ...richEditorClasses, nodes: { ...richEditorClasses.nodes, stock: "align-middle" } };

const tag = (symbol: string): RichNodeJSON => ({ type: "stock", attrs: { symbol } });
const text = (value: string): RichNodeJSON => ({ type: "text", text: value });

const DOC = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("Morning notes")] },
    { type: "paragraph", content: [text("Chips led the open: "), tag("NVDA"), text(" and "), tag("AAPL"), text(" both gained, while "), tag("TSLA"), text(" gave back yesterday's rally.")] },
    { type: "stockCard", attrs: { symbol: "NVDA", price: 141.98 } },
    { type: "paragraph", content: [text("Watching "), tag("MSFT"), text(" into the close. Type around the tags, select one and press Backspace, or undo.")] },
  ],
};

export function NodeViewDemo() {
  const editor = createRichEditor({ extensions: [StarterKit, Stock, StockCardNode], doc: DOC });
  const count = () => {
    const json = JSON.stringify(editor.getJSON());
    return { tags: json.split('"type":"stock"').length - 1, cards: json.split('"type":"stockCard"').length - 1 };
  };
  const counts = signal(count());
  editor.on("transaction", () => counts.set(count()));
  const insert = (content: RichNodeJSON) => {
    editor.insertContent(content);
    editor.focus();
  };
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <View style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: TOOL_GAP, padding: 8, borderBottomWidth: 1, borderColor: colors.border }}>
          <IconButton icon="undo-2" label="Undo" onPress={() => editor.run(undo())} />
          <IconButton icon="redo-2" label="Redo" onPress={() => editor.run(redo())} />
          <ToolbarSeparator />
          <IconButton icon="chart-candlestick" label="Insert a $TSLA tag" onPress={() => insert(tag("TSLA"))} />
          <IconButton icon="plus" label="Insert an AAPL card" onPress={() => insert({ type: "stockCard", attrs: { symbol: "AAPL" } })} />
        </View>
        <RichEditor editor={editor} testID="node-view-editor" classes={classes} style={{ flex: 1 }} />
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderColor: colors.border }}>
          <Text style={{ fontSize: 12, color: colors.muted, fontFamily: mono, fontVariant: ["tabular-nums"] }}>
            {`${plural(counts().tags, "tag")} · ${plural(counts().cards, "card")}`}
          </Text>
        </View>
      </View>
    </View>
  );
}
