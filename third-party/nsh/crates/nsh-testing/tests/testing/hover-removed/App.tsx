import { mount, signal, Text, View } from "nsh";

// A picker of two panels, one shown at a time, each closing when the
// pointer leaves it. Switching panels removes the one under the pointer:
// it must hear no `onMouseLeave` when the pointer later moves, or it
// closes the panel that replaced it.
function Panel(props: { name: string; open: { set(value: string): void } }) {
  // The handler holds the view through its ref: a cycle, so the view
  // outlives its removal until the garbage collector runs.
  let view: unknown;
  return (
    <View
      ref={(node) => (view = node)}
      testID={`panel-${props.name}`}
      onMouseLeave={() => view && props.open.set("none")}
      style={{ height: 100 }}
    >
      <Text>{`Panel ${props.name}`}</Text>
    </View>
  );
}

function App() {
  const open = signal("a");
  return (
    <View style={{ flex: 1 }}>
      <View onPress={() => open.set("b")} style={{ height: 40 }}>
        <Text>Open B</Text>
      </View>
      <If when={open() === "a"}>
        <Panel name="a" open={open} />
      </If>
      <If when={open() === "b"}>
        <Panel name="b" open={open} />
      </If>
      <Text>{`Open: ${open()}`}</Text>
    </View>
  );
}

mount(App);
