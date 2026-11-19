// Geometry fixture: fixed dimensions make selection and toolbar positions observable.
import { mount, Overlay, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Bounds } from "nsh";

function App() {
  const selected = signal("none");
  const anchor = signal<Bounds | undefined>(undefined);
  const toolbar = signal("none");
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Scroll testID="outer" style={{ height: 600, flexGrow: 0, flexShrink: 0 }}>
        <View style={{ height: 100 }} />
        <View
          selectable
          onTouchStart={() => {}}
          style={{ marginLeft: 30, width: 300 }}
          onSelectionChange={({ text, start, bounds, pageBounds }) => {
            anchor.set(pageBounds);
            selected.set(JSON.stringify({ text, start, bounds, pageBounds }));
          }}
        >
          <Scroll testID="inner" style={{ height: 160, flexGrow: 0 }}>
            <View style={{ height: 40 }} />
            <Text>Alpha beta gamma</Text>
            <Text>Delta epsilon</Text>
            <View style={{ height: 400 }} />
          </Scroll>
        </View>
        <View style={{ height: 600 }} />
      </Scroll>
      <Text>{`Selection: ${selected()}`}</Text>
      <Text>{`Toolbar: ${toolbar()}`}</Text>
      <View onTouchStart={() => {}} style={{ alignSelf: "flex-start" }}>
        <Text style={{ userSelect: "text" }}>Copy this sentence</Text>
      </View>
      <Input testID="paste" style={{ height: 44, width: 240 }} />
      <If when={anchor()}>
        <Overlay
          anchor={anchor()!}
          placement="top"
          align="start"
          offset={8}
          onPosition={({ bounds }) => toolbar.set(JSON.stringify(bounds))}
        >
          <Text>Selection actions</Text>
        </Overlay>
      </If>
    </View>
  );
}

mount(App);
