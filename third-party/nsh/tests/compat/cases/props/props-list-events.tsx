// A case of the API's test suite (docs/dev/compatibility.md): what lists
// report and where they start: `onLoadMore` once the user scrolls within
// `loadMoreThreshold` viewports of the end (a fifth of one here, not
// the default whole one), a pull to refresh (`onRefresh`, the platform's
// event) that the app answers with `refreshing`, a list that starts
// scrolled to an item (`initialScrollIndex`), and the keys
// `keyExtractor` gives the items `onViewableItemsChange` reports. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { List } from "nsh";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function App() {
  const ends = signal(0);
  const refreshes = signal(0);
  const refreshing = signal(false);
  const keys = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <List
        testID="feed"
        each={range(20)}
        loadMoreThreshold={0.2}
        onLoadMore={() => ends.set(ends() + 1)}
        refreshing={refreshing()}
        onRefresh={() => {
          refreshes.set(refreshes() + 1);
          refreshing.set(true);
        }}
        style={{ height: 200 }}
      >
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Feed {item()}</Text>
          </View>
        )}
      </List>
      <Text>Ends: {ends()}</Text>
      <Text>Refreshes: {refreshes()}</Text>
      <View testID="done" onPress={() => refreshing.set(false)}>
        <Text>Done refreshing</Text>
      </View>
      <List
        testID="jump"
        each={range(20)}
        initialScrollIndex={5}
        estimatedItemSize={40}
        keyExtractor={(item) => `k${item}`}
        onViewableItemsChange={(info) => keys.set(info.viewableItems.map((t) => t.key).join(","))}
        style={{ height: 100 }}
      >
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Jump {item()}</Text>
          </View>
        )}
      </List>
      <Text>Keys: {keys()}</Text>
    </View>
  );
}

export default App;
