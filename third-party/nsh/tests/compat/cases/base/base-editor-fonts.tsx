// A case of the API's test suite (docs/dev/compatibility.md): `Editor`'s
// decorations set the font of their text (`fontFamily`, `fontSize` of a
// decoration in `decorations`), as a Markdown notes app's headings and
// code. A 26 point heading in a 13 point editor with 20 point rows takes a
// row of 40, the caret there is as tall and the next row starts below it;
// the code's row, in another family at the editor's size, keeps its 20.
import { Text, View, signal } from "nsh";
import { Editor, type EditorRef } from "nsh/base";

const range = (line: number, start: number, end: number) => ({
  start: { line, column: start },
  end: { line, column: end },
});

export default function BaseEditorFonts() {
  const rows = signal("none");
  let editor!: EditorRef;
  // The caret's box at the start of `line`, in the editor's box.
  const caretAt = async (line: number) => {
    editor.setSelections([{ anchor: { line, column: 0 }, head: { line, column: 0 } }]);
    return (await editor.caretBounds())?.bounds;
  };
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 300, height: 120 }}>
        <Editor
          ref={r => (editor = r)}
          defaultValue={"# Notes\nuse `code` here\nend"}
          fontSize={13}
          lineHeight={20}
          lineNumbers={false}
          decorations={[
            { range: range(0, 0, 7), fontSize: 26 },
            { range: range(1, 4, 10), fontFamily: "monospace" },
          ]}
          style={{ flex: 1 }}
        />
      </View>
      <Text>{() => `Rows: ${rows()}`}</Text>
      <View
        testID="measure"
        style={{ height: 20 }}
        onPress={async () => {
          const heading = await caretAt(0);
          const code = await caretAt(1);
          if (!heading || !code) return rows.set("none");
          const below = code.origin.y - heading.origin.y;
          rows.set(`${heading.size.height} ${code.size.height} ${below}`);
        }}
      />
    </View>
  );
}
