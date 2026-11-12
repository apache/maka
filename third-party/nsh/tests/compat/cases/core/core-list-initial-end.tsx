// Opening at the end keeps short content at the top and pins the end as
// estimated rows shrink, including a last row taller than the viewport.
import { List, type ListRef, Text, View, signal } from "nsh";

export default function App() {
  let shrink!: ListRef;
  let tall!: ListRef;
  let short!: ListRef;
  let empty!: ListRef;
  const position = signal("Unread");
  const read = async () => {
    const a = await shrink.measureScrollPosition();
    const b = await tall.measureScrollPosition();
    const c = await short.measureScrollPosition();
    const d = await empty.measureScrollPosition();
    position.set(`Shrink ${a?.index}/${a?.offset}; Tall ${b?.index}/${b?.offset}; Short ${c?.index}/${c?.offset}; Empty ${d}`);
  };
  const rows = Array.from({ length: 50 }, (_, i) => i);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="read-initial-end" onPress={read}><Text>Read initial positions</Text></View>
      <Text>{position()}</Text>
      <List ref={shrink} testID="initial-shrink" each={rows} initialScrollAtEnd initialScrollIndex={0}
        estimatedItemSize={170} style={{ height: 120 }}>
        {(row) => <View style={{ height: 60 }}><Text>{`Shrink ${row()}`}</Text></View>}
      </List>
      <List ref={tall} testID="initial-tall" each={rows} initialScrollAtEnd
        estimatedItemSize={170} style={{ height: 120 }}>
        {(row) => <View style={{ height: row() === 49 ? 300 : 60 }}><Text>{`Tall ${row()}`}</Text></View>}
      </List>
      <List ref={short} testID="initial-short" each={[0, 1]} initialScrollAtEnd
        estimatedItemSize={170} style={{ height: 120 }}>
        {(row) => <View style={{ height: 30 }}><Text>{`Short ${row()}`}</Text></View>}
      </List>
      <List ref={empty} testID="initial-empty" each={[] as number[]} initialScrollAtEnd style={{ height: 120 }}>
        {(row) => <Text>{row()}</Text>}
      </List>
    </View>
  );
}
