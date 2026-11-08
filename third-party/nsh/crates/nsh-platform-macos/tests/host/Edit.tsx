// An `Editor` under an application menu with the Edit roles: its own undo
// and redo (Command+Z, Shift+Command+Z) must still work with the menu's
// Undo and Redo around. `Edit.test.tsx` runs it on the macOS host.
import { mount, signal, Text, View, WebView } from "nsh";
import { Editor } from "nsh/base";
import { Menu } from "nsh/desktop";

function App() {
  const text = signal("one");
  const real = signal("asking");
  WebView.inputAvailable().then((available) => real.set(`${available}`));
  Menu.setApplicationMenu([
    { label: "Fixture", submenu: [{ role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "selectAll" }] },
  ]);
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Text>{`Real host: ${real()}`}</Text>
      <Text>{`Text: ${text()}`}</Text>
      <View style={{ height: 120 }}>
        <Editor class="flex-1" defaultValue="one" accessibilityLabel="Notes" onChange={({ value }) => text.set(value)} />
      </View>
    </View>
  );
}

mount(App);
