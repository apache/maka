// Initial RichEditor reconciliation: 200 paragraphs of 80 ASCII characters.
import { mount, View } from "nsh";
import { createRichEditor, RichEditor, StarterKit } from "nsh/base";

const content = Array.from({ length: 200 }, (_, i) =>
  (`Paragraph ${String(i).padStart(6, "0")}: ` + "ordinary text ".repeat(6)).slice(0, 80)
).join("\n\n");

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content, format: "markdown" });
  return (
    <View style={{ flex: 1 }}>
      <RichEditor editor={editor} style={{ flex: 1 }} />
    </View>
  );
}

mount(App);
