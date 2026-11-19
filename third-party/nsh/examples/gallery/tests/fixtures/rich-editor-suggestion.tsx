import { mount, signal, Text, View } from "nsh";
import { RichEditor, createRichEditor, setSuggestionOpen, starterKit, starterSchema, suggestion, withMention } from "nsh/base";

// A chat composer's @-mention list: it is open while people match, so
// Enter picks one while some do and goes on to the editor when none does.
const people = ["Alice", "Bob", "Carol"];

function App() {
  const editor = createRichEditor({
    schema: withMention(starterSchema()),
    plugins: [suggestion({ key: "mention", char: "@", captureKeys: ["ArrowDown", "Enter"] }), starterKit()],
  });
  const paragraphs = signal(1);
  const list = signal("none");
  const lastKey = signal("none");
  editor.on("transaction", () => {
    paragraphs.set(editor.getJSON().content.length);
    const s = editor.suggestion("mention");
    lastKey.set(s?.lastKey ?? "none");
    if (!s?.active) return list.set("none");
    const query = (s.query ?? "").toLowerCase();
    editor.run(setSuggestionOpen(people.some((p) => p.toLowerCase().startsWith(query)), "mention"));
    list.set(editor.suggestion("mention")?.open ? "open" : "closed");
  });
  return (
    <View class="flex-1 pt-16 px-4 gap-2">
      <Text>{`paragraphs: ${paragraphs()}`}</Text>
      <Text>{`list: ${list()}`}</Text>
      <Text>{`lastKey: ${lastKey()}`}</Text>
      <RichEditor editor={editor} testID="composer" class="h-40 text-foreground" />
    </View>
  );
}

mount(App);
