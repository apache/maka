// A case of the API's test suite (docs/dev/compatibility.md): a
// `WindowRef`'s attributes and requests. `set` takes any part of the
// attributes, every group of them; the requests return nothing whatever
// the platform does (headless, no platform reports, so `state()` stays
// `null`); `on` returns a function that stops; a wrong value throws a
// `TypeError`. The same calls work on the main window.
import { Text, View, signal } from "nsh";
import { Window, currentWindow } from "nsh/desktop";

function App() {
  const main = currentWindow();
  const result = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Result: ${result()}`}</Text>
      <View
        testID="calls"
        onPress={() => {
          const win = Window.open(() => <Text>Document</Text>, { id: "doc", defaultSize: { width: 500, height: 400 }, defaultMode: "normal", restoreBounds: true });
          for (const w of [win, main]) {
            w.set({ title: "Doc", titleBar: { style: "hidden", height: 44, controlsOffset: { x: 12, y: 14 } }, frame: "default" });
            w.set({ minSize: { width: 300, height: 200 }, maxSize: null, sizeToContent: "width" });
            w.set({ resizable: true, movable: true, minimizable: true, maximizable: true, closable: true, focusable: true, activate: true });
            w.set({ closeOnPress: false, closeOnEscape: true, closeOnBlur: false });
            w.set({ level: "aboveDock", taskbar: false, workspaces: "all", pointerEvents: "auto" });
            w.set({ transparent: false, backdrop: "window", shadow: true });
            w.set({ progress: { value: 0.4, state: "paused" } });
            w.set({ progress: null });
            w.show();
            w.hide();
            w.focus();
            w.minimize();
            w.restore();
            w.setMode("fullScreen");
            w.setMode("normal");
            w.setBounds({ origin: { x: 10 }, size: { height: 300 }, animated: true });
            w.setPlacement({ mode: "maximized", bounds: { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } } });
            w.center({});
            w.requestAttention();
            const stops = [
              w.on("closePress", ({ reason }) => void reason),
              w.on("close", () => {}),
              w.on("focusChange", ({ focused }) => void focused),
              w.on("modeChange", ({ mode, minimized }) => void [mode, minimized]),
              w.on("boundsChange", ({ bounds }) => void bounds),
              w.on("displayChange", ({ display }) => void display),
            ];
            stops.forEach((stop) => stop());
          }
          let wrong = "none";
          try {
            win.setMode("huge" as never);
          } catch (e) {
            wrong = (e as Error).name;
          }
          const bar = win.titleBar();
          result.set(`done, state ${win.state()}, title bar ${bar.height} ${bar.left} ${bar.right}, wrong mode ${wrong}`);
        }}
      >
        <Text>Calls</Text>
      </View>
      <View testID="close" onPress={() => { Window.get("doc")?.close(); result.set(`closed ${Window.get("doc")}`); }}>
        <Text>Close</Text>
      </View>
    </View>
  );
}

export default App;
