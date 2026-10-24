// A case of the API's test suite (docs/dev/compatibility.md): a list that
// loads at its start, as a chat opened at an old message loads the newer
// ones: `onLoadMoreAtStart` once the user scrolls back within
// `loadMoreAtStartThreshold` viewports of the start (a quarter of one here,
// not the default whole one), not where the list opens. The page it
// prepends keeps the rows on screen in place. Its script checks each.
import { List, Text, View, signal } from "nsh";

function App() {
  const items = signal(Array.from({ length: 20 }, (_, i) => i));
  const starts = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <List
        testID="feed"
        each={items()}
        estimatedItemSize={40}
        loadMoreAtStartThreshold={0.25}
        onLoadMoreAtStart={() => {
          starts.set(starts() + 1);
          const first = items()[0];
          items.set([...Array.from({ length: 5 }, (_, i) => first - 5 + i), ...items()]);
        }}
        style={{ height: 200 }}
      >
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Item {item()}</Text>
          </View>
        )}
      </List>
      <Text>Starts: {starts()}</Text>
    </View>
  );
}

export default App;
