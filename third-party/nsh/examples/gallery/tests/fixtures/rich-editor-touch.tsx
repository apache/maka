import { mount, signal, Text, View } from "nsh";
import { Button, RichEditor, StarterKit, createRichEditor, toggleMark, undo } from "nsh/base";

// A rich editor with a toolbar that follows the selection, as a chat's
// full-screen composer has: touch selection (long press, handles, the
// system's edit menu) selects, and the toolbar formats what it selected.
const DOC = "Hold a word to select it\n\nThen drag the handles, open the menu, or make it bold with the button above";

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: DOC, format: "markdown" });
  const revision = signal(editor.revision);
  editor.on("revision", ({ revision: r }) => revision.set(r));
  const selected = () => {
    void revision();
    const s = editor.selection as { type: string; anchor?: number; head?: number };
    if (s.anchor === undefined || s.head === undefined) return editor.textBetween(undefined, undefined, " ");
    return editor.textBetween(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head), " ");
  };
  const bold = () => {
    void revision();
    return editor.isActive("bold");
  };
  return (
    <View class="flex-1 bg-background pt-16 px-4 gap-3">
      <View class="flex-row gap-2 items-center">
        <Button
          accessibilityLabel="Bold"
          class={`px-3 py-2 rounded-md ${bold() ? "bg-primary" : "bg-muted"}`}
          onPress={() => editor.run(toggleMark("bold"))}
        >
          <Text class={`font-bold ${bold() ? "text-primary-foreground" : "text-foreground"}`}>B</Text>
        </Button>
        <Button accessibilityLabel="Undo" class="px-3 py-2 rounded-md bg-muted" onPress={() => editor.run(undo())}>
          <Text class="text-foreground">Undo</Text>
        </Button>
        <Text class="text-muted-foreground">{`bold: ${bold()}`}</Text>
      </View>
      <Text class="text-muted-foreground">{`selected: ${selected()}`}</Text>
      <RichEditor
        editor={editor}
        accessibilityLabel="Document"
        class="flex-1 text-foreground"
        classes={{ content: "p-3", marks: { bold: "font-bold" } }}
      />
    </View>
  );
}

mount(App);
