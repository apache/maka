import { Text, View, signal } from "nsh";
import type { ViewRef } from "nsh";

function App() {
  let article: ViewRef | undefined;
  const selected = signal("no");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View ref={(node) => (article = node)} selectable>
        <Text>Selectable article</Text>
      </View>
      <Text>Selected all: {selected()}</Text>
      <View
        testID="select-all"
        onPress={() => {
          article?.selectAll();
          selected.set("yes");
        }}
      >
        <Text>Select all</Text>
      </View>
    </View>
  );
}

export default App;
