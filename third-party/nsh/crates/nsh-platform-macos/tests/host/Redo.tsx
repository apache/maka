// Two inputs and a rich editor under the Edit menu's Undo and Redo: their
// keys (Cmd+Z, Cmd+Shift+Z) must undo and redo once, in the input edited.
import { mount, signal, Text, View } from "nsh";
import { createRichEditor, Input, RichEditor, StarterKit } from "nsh/base";
import { Menu, Window } from "nsh/desktop";

function App() {
  const value = signal("");
  const other = signal("");
  Menu.setApplicationMenu([
    { label: "Fixture", submenu: [{ role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }] },
  ]);
  const editor = createRichEditor({ extensions: [StarterKit], content: "" });
  return (
    <View style={{ flex: 1, padding: 12, gap: 6 }}>
      <Text>{`Text: ${value()}`}</Text>
      <Input
        testID="field"
        value={value()}
        onChange={(e) => value.set(e.value)}
        style={{ height: 28 }}
      />
      <Text>{`Other: ${other()}`}</Text>
      <Input
        testID="other"
        value={other()}
        onChange={(e) => other.set(e.value)}
        style={{ height: 28 }}
      />
      <RichEditor testID="editor" editor={editor} style={{ height: 60, borderWidth: 1 }} />
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
