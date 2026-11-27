// The app binds Cmd+Z, Cmd+Shift+Z (Redo's key on macOS) and Cmd+A.
import { keymap, mount, signal, Text, View } from "nsh";
import { Menu, Window } from "nsh/desktop";

function App() {
  const log = signal<string[]>([]);
  Menu.setApplicationMenu([
    { label: "Fixture", submenu: [{ role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "selectAll" }] },
  ]);
  for (const keys of ["mod+z", "mod+shift+z", "mod+a"]) {
    keymap.bind(keys, () => log.set([...log(), keys]));
  }
  return (
    <View style={{ flex: 1, padding: 12 }}>
      <Text>{`log: ${log().join(" ")}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
