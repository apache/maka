// A case of the API's test suite (docs/dev/compatibility.md): a
// `RichEditorPlugin`'s paste hooks (ProseMirror's paste props:
// `transformPasted`, `handlePaste`), each a chained call returning the
// plugin, and an editor made with it; the session's `pasteHTML` and
// `pasteText` (ProseMirror's), which paste as a paste would and answer
// whether they did. What the hooks do to a paste is checked by
// examples/gallery's rich-editor-paste-hooks test.
import { Text, View } from "nsh";
import { RichEditorPlugin, StarterKit, createRichEditor } from "nsh/base";

function App() {
  const plugin = new RichEditorPlugin("paste");
  const chained = plugin
    .transformPasted((slice) => ({ ...slice, openStart: slice.openStart ?? 0 }))
    .handlePaste((slice, clipboard) => slice.content === undefined && clipboard.html === "" && clipboard.text === "");
  const editor = createRichEditor({ extensions: [StarterKit], plugins: [chained] });
  const pasted = createRichEditor({ extensions: [StarterKit] });
  const html: boolean = pasted.pasteHTML("<p>a <em>b</em></p>");
  const text: boolean = pasted.pasteText(" c");
  const nothing: boolean = pasted.pasteHTML("");
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <Text>{`PasteHooks ${chained === plugin} ${chained.key} ${editor.getText() === ""}`}</Text>
      <Text>{`PasteHTML ${html} ${text} ${nothing} ${pasted.getHTML()}`}</Text>
    </View>
  );
}

export default App;
