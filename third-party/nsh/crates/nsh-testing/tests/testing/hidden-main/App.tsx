// A window that is hidden while the app runs, as a tray app's: the app
// opens it, hides it, and shows it again when it wants it. While it is
// hidden its views are neither found nor pressed; the other window's
// button sits where the hidden window's does. The app root declares both
// windows; the host itself is never a window.
import { effect, mount, signal, Text, View } from "nsh";
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

function Main() {
  const main = currentWindow();
  return (
    <View style={{ flex: 1 }}>
      <Button label="Main button" onPress={() => presses.set("main")} />
      <Button label="Hide main" onPress={() => main.hide()} />
      <Text>{`In main: ${describe(main.state())}`}</Text>
    </View>
  );
}

function Tools() {
  const main = Window.get("main");
  // Opened shown by the app root, then hidden here: a window that starts
  // unseen, without a privileged host window behind it.
  effect(() => {
    main?.hide();
  });
  return (
    <View style={{ flex: 1 }}>
      <Button label="Tools button" onPress={() => presses.set("tools")} />
      <Button label="Show main" onPress={() => main?.show()} />
      <Button label="Focus main" onPress={() => main?.focus()} />
      <Text>{`Main: ${describe(main?.state())}`}</Text>
      <Text>{`Focused: ${focusedWindow()?.id ?? "none"}`}</Text>
      <Text>{`Presses: ${presses()}`}</Text>
    </View>
  );
}

function App() {
  return (
    <>
      <Window id="main">
        <Main />
      </Window>
      <Window id="tools" activate={false} defaultSize={{ width: 300, height: 200 }}>
        <Tools />
      </Window>
    </>
  );
}

mount(App);
