// A case of the API's test suite (docs/dev/compatibility.md): `ref={…}`,
// which the JSX compiler turns into `nsh:rt`'s `ref` for a variable, a
// signal, a function and a field, on host elements and through a
// component. Each ref'd view has its own size, and measuring the node a
// ref got shows it as text, so the script sees that each form received
// its own element. Its script checks each.
import { Text, View, signal } from "nsh";
import type { ViewProps, ViewRef } from "nsh";

function Card(props: ViewProps) {
  return <View ref={props.ref} style={{ width: 150, height: 15 }} />;
}

function App() {
  let plain: ViewRef | undefined;
  const box = signal<ViewRef>();
  const calls = signal(0);
  let called: ViewRef | undefined;
  const onRef = (node: ViewRef) => {
    called = node;
    calls.set(calls() + 1);
  };
  const refs: { field?: ViewRef; card?: ViewRef } = {};
  const key = "card";
  let inline: ViewRef | undefined;
  const sizes = signal("none");
  const measure = async () => {
    const nodes = [plain, box(), called, refs.field, refs[key], inline];
    const out: string[] = [];
    for (const node of nodes) {
      const m = node ? await node.measure() : null;
      out.push(m ? `${m.bounds.size.width}x${m.bounds.size.height}` : "missing");
    }
    sizes.set(out.join(" "));
  };
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View ref={plain} style={{ width: 100, height: 10 }} />
      <View ref={box} style={{ width: 110, height: 11 }} />
      <View ref={onRef} style={{ width: 120, height: 12 }} />
      <View ref={refs.field} style={{ width: 130, height: 13 }} />
      <Card ref={refs[key]} />
      <View ref={(node) => (inline = node)} style={{ width: 160, height: 16 }} />
      <Text>Signal: {box() ? "set" : "unset"}</Text>
      <Text>Calls: {calls()}</Text>
      <Text>Sizes: {sizes()}</Text>
      <View testID="measure" onPress={measure}>
        <Text>Measure</Text>
      </View>
    </View>
  );
}

export default App;
