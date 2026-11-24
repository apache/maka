import { Text, View, signal } from "nsh";
import type { ViewRef } from "nsh";

function App() {
  let article: ViewRef | undefined;
  const cleared = signal("no");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View ref={(node) => (article = node)} selectable>
        <Text>Selectable article</Text>
      </View>
      <Text>Cleared: {cleared()}</Text>
      <View
        testID="clear"
        onPress={() => {
          article?.clearSelection();
          cleared.set("yes");
        }}
      >
        <Text>Clear</Text>
      </View>
    </View>
  );
}

export default App;
