// A case of the API's test suite (docs/dev/compatibility.md): lists that
// follow their content: one at its end stays at the end as an item is
// added below, and one reports the items that count as viewable by its
// threshold (fully visible ones only). Its script
// checks each.
import { Text, View, signal } from "nsh";
import { List } from "nsh";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function App() {
  const items = signal(range(10));
  const viewable = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="add" onPress={() => items.set(range(items().length + 1))}>
        <Text>Add</Text>
      </View>
      <List
        each={items()}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 20 }}
        estimatedItemSize={40}
        style={{ height: 200 }}
      >
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Feed {item()}</Text>
          </View>
        )}
      </List>
      <List
        each={range(10)}
        viewabilityConfig={{ itemVisiblePercentThreshold: 100 }}
        onViewableItemsChange={(info) => viewable.set(info.viewableItems.map((t) => t.index).join(","))}
        style={{ height: 100 }}
      >
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Seen {item()}</Text>
          </View>
        )}
      </List>
      <Text>Viewable: {viewable()}</Text>
    </View>
  );
}

export default App;
