// A case of the API's test suite (docs/dev/compatibility.md): the
// `RichEditor` view's bubble menu: the app's content shown next to the
// selection while the app passes it, gone when it does not; and a table
// shown as a grid of its cells, with the table parts' classes.
import { Text, View, signal } from "nsh";
import { RichEditor, StarterKit, TableKit, createRichEditor } from "nsh/base";

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: "Some text" });
  const open = signal(true);
  const tables = createRichEditor({
    extensions: [StarterKit, TableKit],
    content: "| CellA | CellB |\n| --- | --- |\n| CellC | CellD |\n",
    format: "markdown",
  });
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <View onPress={() => open.set(!open())}>
        <Text>ToggleMenu</Text>
      </View>
      <RichEditor
        editor={editor}
        style={{ height: 120 }}
        bubbleMenu={open() ? <Text>BubbleMenu</Text> : undefined}
        bubbleMenuPlacement="bottom"
        bubbleMenuOffset={4}
      />
      <RichEditor
        editor={tables}
        style={{ height: 120 }}
        classes={{
          selectedCell: "bg-blue-500/20",
          tableGrip: "bg-neutral-400",
          tableResizeHandle: "bg-blue-500",
          tableDropIndicator: "bg-blue-500",
          nodes: { tableHeader: "font-semibold", tableCell: "px-2" },
        }}
        styles={{ selectedCell: { opacity: 0.5 } }}
      />
    </View>
  );
}

export default App;
