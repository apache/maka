// Retained-row update benchmark: 1,000 paragraphs of 80 ASCII characters.
// Each press inserts or removes one character in the first paragraph.
import { mount, Text, View } from "nsh";
import {
  Button, chain, createRichEditor, insertText, RichEditor, setTextSelection, StarterKit,
} from "nsh/base";

const content = Array.from({ length: 1000 }, (_, i) =>
  (`Paragraph ${String(i).padStart(6, "0")}: ` + "ordinary text ".repeat(6)).slice(0, 80)
).join("\n\n");

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content, format: "markdown" });
  let inserted = false;
  return (
    <View style={{ flex: 1 }}>
      <Button testID="edit" onPress={() => {
        editor.run(chain([
          setTextSelection(21, inserted ? 22 : 21),
          insertText(inserted ? "" : "x"),
        ]));
        inserted = !inserted;
      }}>
        <Text>Edit first paragraph</Text>
      </Button>
      <RichEditor editor={editor} testID="perf-editor" style={{ flex: 1 }} />
    </View>
  );
}

mount(App);
