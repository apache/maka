// A case of the API's test suite (docs/dev/compatibility.md): how lists lay
// out their items: in columns, from the end (item 0 last, starting
// scrolled to the end), with items that stick to the top, and with the
// size items not measured yet count for. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { List } from "nsh";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function App() {
  const content = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <List each={range(6)} numColumns={2} style={{ height: 120 }}>
        {(item) => (
          <View testID={`grid-${item()}`} style={{ height: 40 }}>
            <Text>Grid {item()}</Text>
          </View>
        )}
      </List>
      <List each={range(10)} inverted style={{ height: 200 }}>
        {(item) => (
          <View testID={`chat-${item()}`} style={{ height: 40 }}>
            <Text>Chat {item()}</Text>
          </View>
        )}
      </List>
      <List each={range(8)} stickyHeaderIndices={[0, 3]} style={{ height: 120 }}>
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Sticky {item()}</Text>
          </View>
        )}
      </List>
      <List
        each={range(30)}
        estimatedItemSize={100}
        style={{ height: 200 }}
        onScroll={(e) => content.set(`${e.contentSize.height}`)}
      >
        {(item) => (
          <View style={{ height: 100 }}>
            <Text>Estimated {item()}</Text>
          </View>
        )}
      </List>
      <Text>Content: {content()}</Text>
    </View>
  );
}

export default App;
