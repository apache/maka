// A main window nsh.json starts hidden (`window.defaultVisible: false`), as
// a tray app's: the app runs in it unseen and unfocused, a window of its own
// is there, and the app shows the main window when it wants it. While it is
// hidden its views are neither found nor pressed; the other window's button
// sits where the main window's does. That window is a normal one that does
// not activate: a panel or a dialog belongs to the window that opened it,
// and a child window shows its parent with it on macOS (GPUI's).
import { mount, signal, Text, View } from "nsh";
import { currentWindow, focusedWindow, Window, type WindowState } from "nsh/desktop";

const describe = (s: WindowState | null | undefined) =>
  s ? `visible=${s.visible} focused=${s.focused} minimized=${s.minimized}` : "none";

const presses = signal("none");

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} style={{ width: 120, height: 24 }}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  const main = currentWindow();
  return (
    <View style={{ flex: 1 }}>
      <Button label="Main button" onPress={() => presses.set("main")} />
      <Button label="Hide main" onPress={() => main.hide()} />
      <Text>{`In main: ${describe(main.state())}`}</Text>
      <Window id="tools" activate={false} defaultSize={{ width: 300, height: 200 }}>
        <Button label="Tools button" onPress={() => presses.set("tools")} />
        <Button label="Show main" onPress={() => main.show()} />
        <Button label="Focus main" onPress={() => main.focus()} />
        <Text>{`Main: ${describe(main.state())}`}</Text>
        <Text>{`Focused: ${focusedWindow()?.id ?? "none"}`}</Text>
        <Text>{`Presses: ${presses()}`}</Text>
      </Window>
    </View>
  );
}

mount(App);
