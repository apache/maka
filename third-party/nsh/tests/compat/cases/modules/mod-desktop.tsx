// A case of the API's test suite (docs/dev/compatibility.md): `nsh/desktop`
// off the desktops (the headless runtime is iOS): `isAvailable` is false,
// `titleBar()` is all 0, `windowState()` is null and `displays()` empty;
// the main window is the only one (`currentWindow()`, `windows()`,
// `Window.get`), its requests and `set` are callable and do nothing,
// `<Window>` renders nothing and `Window.open` throws
// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; the app and menu functions are
// callable and do nothing, so an app that calls them runs on. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { Application, Menu, Window, currentWindow, displays, focusedWindow, isAvailable, titleBar, windowState, windows } from "nsh/desktop";

function App() {
  const main = currentWindow();
  const calls = signal("not called");
  const popup = signal("not shown");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Desktop: ${isAvailable}`}</Text>
      <Text>{`Title bar: ${titleBar().height} ${titleBar().left} ${titleBar().right}`}</Text>
      <Text>{`Window state: ${windowState()} displays ${displays().length}`}</Text>
      <Text>{`Calls: ${calls()}`}</Text>
      <Text>{`Popup: ${popup()}`}</Text>
      <Text>{`Current: ${main.id} ${main.main} ${main.parent} state ${main.state()}`}</Text>
      <Text>{`Windows: ${windows().map((w) => w.id).join(",")} focused ${focusedWindow()} get ${Window.get("main") === main} ${Window.get("other")}`}</Text>
      <Window id="hidden" title="Hidden" defaultOpen>
        <Text>Inside a window</Text>
      </Window>
      <View
        testID="window"
        onPress={() => {
          main.set({ title: "Compat", titleBar: { style: "hidden", height: 40 }, level: "floating", taskbar: false });
          main.set({ titleBar: { style: "default" }, level: "normal" });
          main.setBounds({ origin: { x: 40, y: 60 }, size: { width: 800, height: 600 }, animated: false });
          main.setPlacement({ mode: "maximized", bounds: { origin: { x: -3000, y: 10 }, size: { width: 800, height: 600 } } });
          main.setMode("maximized");
          main.setMode("normal");
          main.minimize();
          main.restore();
          main.center();
          main.focus();
          main.requestAttention({ critical: true });
          const stop = main.on("closePress", () => {});
          stop();
          let open = "returned";
          try {
            Window.open(() => <Text>Never</Text>, { id: "other", kind: "dialog" });
          } catch (e) {
            open = (e as { code?: string }).code ?? "no code";
          }
          calls.set(`window done, open ${open}, close ${typeof main.close}`);
        }}
      >
        <Text>Window calls</Text>
      </View>
      <View
        testID="menu"
        onPress={() => {
          Menu.setApplicationMenu([
            { label: "File", submenu: [{ label: "New", shortcut: "mod+n", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", onSelect: () => {} }, { type: "separator" }, { role: "quit" }] },
            { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, false, { label: "Checked", checked: true, disabled: true }] },
          ]);
          Menu.setApplicationMenu(null);
          Menu.setMenuBar("autoHide");
          Menu.setMenuBar("shown");
          const shown = Menu.popup([{ label: "Rename", icon: { url: "asset:/rename.svg", size: { width: 16, height: 16 } }, onSelect: () => {} }], { x: 10, y: 20 });
          popup.set(typeof shown.then === "function" ? "a promise" : "no promise");
          shown.then(() => popup.set("closed"));
          calls.set("menu done");
        }}
      >
        <Text>Menu calls</Text>
      </View>
      <View
        testID="application"
        onPress={() => {
          Application.quit();
          Application.restart();
          calls.set(`application done, quit ${typeof Application.quit}, restart ${typeof Application.restart}`);
        }}
      >
        <Text>Application calls</Text>
      </View>
    </View>
  );
}

export default App;
