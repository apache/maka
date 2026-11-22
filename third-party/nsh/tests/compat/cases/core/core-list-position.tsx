// A case of the API's test suite (docs/dev/compatibility.md): a `List`'s
// ref tells where its viewport starts among its rows
// (`measureScrollPosition`): the row there and how far into it, as the
// list lays out its rows of different heights. Its script scrolls the
// list and reads it; a list without items answers `null`.
import { List, type ListRef, Text, View, signal } from "nsh";

const heights = [40, 60, 80];

function App() {
  const shown = signal("Not read");
  let rows!: ListRef;
  let empty!: ListRef;
  const read = async () => {
    const at = await rows.measureScrollPosition();
    const none = await empty.measureScrollPosition();
    shown.set(`${at ? `Row ${at.index}, ${at.offset} in` : "none"}; empty: ${none}`);
  };
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="read-position" onPress={read}>
        <Text>Read the position</Text>
      </View>
      <Text>{shown()}</Text>
      <List
        ref={rows}
        testID="positioned"
        each={Array.from({ length: 30 }, (_, i) => i)}
        estimatedItemSize={50}
        style={{ height: 200 }}
      >
        {(row) => (
          <View style={{ height: heights[row() % 3] }}>
            <Text>{`Positioned ${row()}`}</Text>
          </View>
        )}
      </List>
      <List ref={empty} each={[] as number[]} style={{ height: 40 }}>
        {(row) => <Text>{`Empty ${row()}`}</Text>}
      </List>
    </View>
  );
}

export default App;
