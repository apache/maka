// A case of the API's test suite (docs/dev/compatibility.md): `<Window>`, a
// window of the app's own declared in the tree. Open while `open` is true
// (or, without it, unless `defaultOpen` is false); the app setting `open`
// to false closes it without `onOpenChange`; `WindowRef.close()` tells the
// app with `onOpenChange({ open: false, reason })`; its attributes follow
// its props; `currentWindow()` in it is that window. The event props are
// taken without a platform reporting anything.
import { Text, View, signal } from "nsh";
import { Window, currentWindow, windows } from "nsh/desktop";

function Inside() {
  const win = currentWindow();
  return <Text>{`Inside ${win.id}`}</Text>;
}

function App() {
  const open = signal(false);
  const title = signal("Inspector");
  const changes = signal("none");
  const events = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Windows: ${windows().map((w) => w.id).join(",")}`}</Text>
      <Text>{`Open: ${open()} changes ${changes()} events ${events()}`}</Text>
      <View testID="toggle" onPress={() => open.set(!open())}>
        <Text>Toggle</Text>
      </View>
      <View testID="rename" onPress={() => title.set("Renamed")}>
        <Text>Rename</Text>
      </View>
      <View testID="close" onPress={() => Window.get("inspector")?.close()}>
        <Text>Close</Text>
      </View>
      <Window
        id="inspector"
        kind="panel"
        parent="main"
        title={title()}
        open={open()}
        onOpenChange={({ open: next, reason }) => {
          open.set(next);
          changes.set(`${next} ${reason}`);
        }}
        onClosePress={({ reason }) => events.set(`closePress ${reason}`)}
        onFocusChange={({ focused }) => events.set(`focus ${focused}`)}
        onModeChange={({ mode, minimized }) => events.set(`mode ${mode} ${minimized}`)}
        onBoundsChange={({ bounds }) => events.set(`bounds ${bounds.size.width}`)}
        onDisplayChange={({ display }) => events.set(`display ${display.id}`)}
        defaultSize={{ width: 280, height: 400 }}
        minSize={{ width: 240, height: 320 }}
        level="floating"
        backdrop="sidebar"
      >
        <Inside />
      </Window>
      <Window id="later" defaultOpen={false}>
        <Text>Never shown</Text>
      </Window>
    </View>
  );
}

export default App;
