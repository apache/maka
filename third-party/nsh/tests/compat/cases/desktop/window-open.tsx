// A case of the API's test suite (docs/dev/compatibility.md): opening a
// window of the app's own imperatively. `Window.open` renders a component
// in a window from the app's one engine (its content reads the app's
// signals) and returns its `WindowRef`; opening the id again returns the
// same window; `Window.get` finds it, `"main"` the main window;
// `windows()` lists the main window, then the app's own in the order they
// opened; `currentWindow()` in its content is that window; `parent` takes
// a `WindowRef` or an id; `close()` closes it, its `close` listeners hear
// it, and its `WindowRef` stays usable and does nothing.
import { Text, View, signal } from "nsh";
import { Window, type WindowRef, currentWindow, windows } from "nsh/desktop";

const shared = signal(0);

function Note() {
  const win = currentWindow();
  return <Text>{`In ${win.id}: main ${win.main}, parent ${win.parent?.id ?? "none"}, shared ${shared()}`}</Text>;
}

function App() {
  const main = currentWindow();
  const result = signal("none");
  const closes = signal(0);
  let kept: WindowRef | null = null;
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Windows: ${windows().map((w) => w.id).join(",")}`}</Text>
      <Text>{`Get: ${Window.get("main") === main} ${Window.get("first")?.id ?? "none"} ${Window.get("second")?.id ?? "none"}`}</Text>
      <Text>{`Result: ${result()}`}</Text>
      <Text>{`Closes: ${closes()}`}</Text>
      <View
        testID="open"
        onPress={() => {
          const first = Window.open(Note, { id: "first", title: "First", defaultSize: { width: 320, height: 200 } });
          const again = Window.open(Note, { id: "first", title: "Again" });
          const second = Window.open(Note, { id: "second", kind: "dialog", parent: main, modal: true, defaultPosition: "parentCenter" });
          first.on("close", () => closes.set(closes() + 1));
          kept = first;
          result.set(`same ${first === again}, main ${first.main}, parent ${second.parent === main}, state ${first.state()}`);
        }}
      >
        <Text>Open</Text>
      </View>
      <View testID="shared" onPress={() => shared.set(shared() + 1)}>
        <Text>Shared</Text>
      </View>
      <View
        testID="close"
        onPress={() => {
          Window.get("first")?.close();
          Window.get("second")?.close();
          // A closed window's requests do nothing.
          kept?.focus();
          kept?.set({ title: "Closed" });
          result.set(`closed, state ${kept?.state()}, get ${Window.get("first")}`);
        }}
      >
        <Text>Close</Text>
      </View>
    </View>
  );
}

export default App;
