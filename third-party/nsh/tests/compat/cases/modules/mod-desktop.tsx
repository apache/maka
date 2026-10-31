// A case of the API's test suite (docs/dev/compatibility.md): `nsh/desktop`
// off the desktops (the headless runtime is iOS): `isAvailable` is false,
// `titleBar()` is all 0, and the window and menu functions are callable
// and do nothing, so an app that calls them runs on. Its script checks
// each.
import { Text, View, signal } from "nsh";
import { Menu, Window, isAvailable, titleBar } from "nsh/desktop";

function App() {
  const calls = signal("not called");
  const popup = signal("not shown");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Desktop: ${isAvailable}`}</Text>
      <Text>{`Title bar: ${titleBar().height} ${titleBar().left} ${titleBar().right}`}</Text>
      <Text>{`Calls: ${calls()}`}</Text>
      <Text>{`Popup: ${popup()}`}</Text>
      <View
        testID="window"
        onPress={() => {
          Window.setTitle("Compat");
          Window.setTitleBar({ style: "hidden", height: 40 });
          Window.setTitleBar({ style: "default" });
          Window.setFrame({ origin: { x: 40, y: 60 }, size: { width: 800, height: 600 }, animated: false });
          Window.setLevel("floating");
          Window.setLevel("normal");
          Window.orderFront();
          calls.set(`window done, close ${typeof Window.close}, minimize ${typeof Window.minimize}`);
        }}
      >
        <Text>Window calls</Text>
      </View>
      <View
        testID="menu"
        onPress={() => {
          Menu.setApplicationMenu([
            { label: "File", submenu: [{ label: "New", shortcut: "mod+n", onSelect: () => {} }, { type: "separator" }, { role: "quit" }] },
            { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, false, { label: "Checked", checked: true, disabled: true }] },
          ]);
          Menu.setApplicationMenu(null);
          const shown = Menu.popup([{ label: "Rename", onSelect: () => {} }], { x: 10, y: 20 });
          popup.set(typeof shown.then === "function" ? "a promise" : "no promise");
          shown.then(() => popup.set("closed"));
          calls.set("menu done");
        }}
      >
        <Text>Menu calls</Text>
      </View>
      <View
        testID="toggles"
        onPress={() => {
          Window.toggleMaximize();
          Window.toggleFullScreen();
          Window.toggleFullScreen();
          Window.toggleMaximize();
          calls.set("toggles done");
        }}
      >
        <Text>Toggle calls</Text>
      </View>
    </View>
  );
}

export default App;
