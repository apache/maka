// A case of the API's test suite (docs/dev/compatibility.md): `nsh/desktop`
// off the desktops (the headless runtime is iOS): `isAvailable` is false,
// `titleBar()` is all 0, `windowState()` is null and `displays()` empty;
// the app surface is the main window (`windows()` lists it,
// `currentWindow()` in a handler is called outside a render, so it throws
// as it always did there, `focusedWindow()` and `Window.get` are null),
// `<Window>` renders its content in the app's one surface and `Window.open`
// throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; the app and menu functions
// are callable and do nothing, so an app that calls them runs on. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { Application, Menu, Window, currentWindow, displays, focusedWindow, isAvailable, titleBar, windowState, windows } from "nsh/desktop";

function App() {
  const calls = signal("not called");
  const popup = signal("not shown");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Desktop: ${isAvailable}`}</Text>
      <Text>{`Title bar: ${titleBar().height} ${titleBar().left} ${titleBar().right}`}</Text>
      <Text>{`Window state: ${windowState()} displays ${displays().length}`}</Text>
      <Text>{`Calls: ${calls()}`}</Text>
      <Text>{`Popup: ${popup()}`}</Text>
      <Window id="hidden" title="Hidden" defaultOpen>
        <Text>Inside a window</Text>
      </Window>
      <View
        testID="window"
        onPress={() => {
          let current = "returned";
          try {
            currentWindow();
          } catch (e) {
            current = (e as { code?: string }).code ?? "no code";
          }
          let open = "returned";
          try {
            Window.open(() => <Text>Never</Text>, { id: "other", kind: "dialog" });
          } catch (e) {
            open = (e as { code?: string }).code ?? "no code";
          }
          calls.set(
            `window done, current ${current}, open ${open}, windows ${windows().length} focused ${focusedWindow()} get ${Window.get("main")}`,
          );
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
          const stop = Application.on("quit", async () => {});
          stop();
          const stopRequests = Application.on("quitRequest", () => {});
          stopRequests();
          Application.setQuitRequestOptions({ system: true, mainWindowClose: true });
          Application.cancelQuitRequest();
          Application.setQuitRequestOptions({});
          Application.quit();
          Application.restart();
          calls.set(`application done, quit ${typeof Application.quit}, restart ${typeof Application.restart}, stop ${typeof stop}`);
        }}
      >
        <Text>Application calls</Text>
      </View>
    </View>
  );
}

export default App;
