// A case of the API's test suite (docs/dev/compatibility.md): the global
// control-flow components `If` (children while `when` is truthy, else
// `else`) and `Each` (rows kept by item, by a key function or by index:
// their order on screen, the state a row keeps when it moves, `index()`),
// driven by presses.
import { Text, View, signal } from "nsh";

type Item = { id: string; label: string };

const ROW = { height: 20 };

function Row(props: { id: string; label: () => string; index: () => number }) {
  // State of the row's own: it stays while the row is kept.
  const presses = signal(0);
  return (
    <View testID={"row-" + props.id} style={ROW} onPress={() => presses.set(presses() + 1)}>
      <Text>
        {props.label()} at {props.index()} pressed {presses()}
      </Text>
    </View>
  );
}

function App() {
  const shown = signal(true);
  const count = signal(0);
  const a: Item = { id: "a", label: "Alpha" };
  const b: Item = { id: "b", label: "Beta" };
  const c: Item = { id: "c", label: "Gamma" };
  const items = signal<Item[]>([a, b, c]);
  const keyed = signal<Item[]>([{ id: "k1", label: "One" }, { id: "k2", label: "Two" }]);
  const words = signal<string[]>(["red", "green"]);
  const maybe = signal<string[] | null>(null);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="toggle" onPress={() => shown.set(!shown())}>
        <Text>Toggle</Text>
      </View>
      <If when={shown()} else={<Text>If: else branch</Text>}>
        <Text>If: children</Text>
      </If>
      <If when={count()}>
        <Text>If: count is {count()}</Text>
      </If>
      <View testID="count" onPress={() => count.set(count() + 1)}>
        <Text>Count</Text>
      </View>

      <View testID="reverse" onPress={() => items.set([...items()].reverse())}>
        <Text>Reverse</Text>
      </View>
      <View testID="drop" onPress={() => items.set(items().filter((i) => i !== b))}>
        <Text>Drop Beta</Text>
      </View>
      <View testID="add" onPress={() => items.set([...items(), { id: "d", label: "Delta" }])}>
        <Text>Add Delta</Text>
      </View>
      <View testID="items">
        <Each of={items()}>{(item, index) => <Row id={item().id} label={() => item().label} index={index} />}</Each>
      </View>

      <View testID="rekey" onPress={() => keyed.set([{ id: "k2", label: "Two again" }, { id: "k1", label: "One again" }])}>
        <Text>Rekey</Text>
      </View>
      <View testID="keyed">
        <Each of={keyed()} key={(item) => item.id}>
          {(item, index) => <Row id={item().id} label={() => item().label} index={index} />}
        </Each>
      </View>

      <View testID="recolor" onPress={() => words.set(["blue", words()[1], "yellow"])}>
        <Text>Recolor</Text>
      </View>
      <View testID="words">
        <Each of={words()} key="index">
          {(word, index) => <Row id={"w" + index()} label={word} index={index} />}
        </Each>
      </View>

      <View testID="fill" onPress={() => maybe.set(maybe() ? null : ["filled"])}>
        <Text>Fill</Text>
      </View>
      <Each of={maybe()}>{(word) => <Text>Maybe: {word()}</Text>}</Each>
    </View>
  );
}

export default App;
