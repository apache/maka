import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { RichEditor, StarterKit, createRichEditor } from "nsh/base";

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: "Drop files on the composer" });
  const revision = signal(editor.revision);
  editor.on("revision", ({ revision: r }) => revision.set(r));
  const caret = () => {
    void revision();
    const s = editor.selection as { anchor?: number; head?: number };
    return `${s.anchor}-${s.head}`;
  };
  const attached = signal("none");
  const around = signal("none");
  const droppedAt = signal("none");
  return (
    <View class="flex-1 bg-background pt-16 px-4 gap-3">
      <Text class="text-muted-foreground">{`caret: ${caret()} revision: ${revision()}`}</Text>
      <Text class="text-muted-foreground">{`attached: ${attached()}`}</Text>
      <Text class="text-muted-foreground">{`dropped at: ${droppedAt()}`}</Text>
      <RichEditor
        editor={editor}
        testID="composer"
        accessibilityLabel="Composer"
        class="h-40 text-foreground"
        onFileDrop={({ uris, mimeTypes, pagePosition }) => {
          attached.set(`${uris.join(" ")} [${mimeTypes.join(" ")}]`);
          droppedAt.set(pagePosition ? `${Math.round(pagePosition.x)} ${Math.round(pagePosition.y)}` : "none");
        }}
      />
      <Text class="text-muted-foreground">{`around: ${around()}`}</Text>
      <View onFileDrop={({ uris }) => around.set(uris.join(" "))}>
        <RichEditor testID="notes" accessibilityLabel="Notes" class="h-40 text-foreground" />
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
