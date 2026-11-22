// A case of the API's test suite (docs/dev/compatibility.md):
// `ResizablePanelGroup` and `ResizablePanel` of `nsh/base`, panels whose
// sizes a drag of the handle between them changes, with no look of their
// own: the panels laid out from `size` (the rest shared by the others),
// a handle per boundary of visible panels (`adjustable` for screen
// readers, `handleAccessibilityLabel`), its indicator the app's
// (`handleClass`, `handleStyle`) with its content (`renderHandle`, told
// the handle's state), a drag clamped to `minSize` /
// `maxSize` and reported once it ends (`onResize` of the group and of
// the panel, whose size the app passes back), a hidden panel
// (`visible`) taking no space, and the group's width changing what the
// panels get but not what they want: a `fixed` one keeps its size.
import { Text, View, signal } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";

function App() {
  const sidebar = signal(150);
  const reported = signal("none");
  const aside = signal(false);
  const locked = signal(false);
  const width = signal(400);
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: width(), height: 100 }}>
        <ResizablePanelGroup
          testID="group"
          axis="horizontal"
          disabled={locked()}
          handleClass="w-[1px] h-[40px] opacity-50"
          handleStyle={{ backgroundColor: "#ff0000" }}
          handleAccessibilityLabel="Resize"
          renderHandle={handle => <Text>{`Grip ${handle.index} ${handle.axis} ${handle.state}`}</Text>}
          onResize={({ sizes }) => reported.set(sizes.map(Math.round).join(", "))}
        >
          <ResizablePanel
            testID="sidebar"
            size={sidebar()}
            minSize={120}
            maxSize={200}
            onResize={({ size }) => sidebar.set(Math.round(size))}
          >
            <Text>Sidebar</Text>
          </ResizablePanel>
          <ResizablePanel testID="main">
            <Text>Main</Text>
          </ResizablePanel>
          <ResizablePanel testID="aside" size={100} minSize={60} fixed visible={aside()}>
            <Text>Aside</Text>
          </ResizablePanel>
        </ResizablePanelGroup>
      </View>
      <View style={{ width: 100, height: 200 }}>
        <ResizablePanelGroup axis="vertical">
          <ResizablePanel testID="top" />
          <ResizablePanel testID="bottom" />
        </ResizablePanelGroup>
      </View>
      <Text>{`Reported: ${reported()}`}</Text>
      <Text>{`Sidebar: ${sidebar()}`}</Text>
      <View testID="aside-toggle" onPress={() => aside.set(!aside())} style={{ height: 20 }} />
      <View testID="widen" onPress={() => width.set(500)} style={{ height: 20 }} />
      <View testID="narrow" onPress={() => width.set(300)} style={{ height: 20 }} />
      <View testID="lock" onPress={() => locked.set(!locked())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
