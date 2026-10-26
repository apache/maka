// A case of the API's test suite (docs/dev/compatibility.md): an app's own
// pull-to-refresh indicator (`refreshIndicator`, its height), which takes
// the platform spinner's place, and the animated value the pull feeds
// for it (`pullValue`), on a scroll view and through a list; a height of
// 0 is none. Its script checks what the platform receives.
import { List, Scroll, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const pulled = createAnimatedValue(3);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Scroll
        testID="pull"
        style={{ height: 200 }}
        pullValue={pulled}
        refreshIndicator={{ height: 72 }}
        onRefresh={() => {}}
      >
        <View style={{ height: 400 }}>
          <Text>Pull me</Text>
        </View>
      </Scroll>
      <Scroll testID="none" style={{ height: 40 }} refreshIndicator={{ height: 0 }} onRefresh={() => {}}>
        <Text>No height</Text>
      </Scroll>
      <List
        each={[0, 1, 2]}
        refreshIndicator={{ height: 60 }}
        onRefresh={() => {}}
        style={{ height: 120 }}
      >
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Row {item()}</Text>
          </View>
        )}
      </List>
    </View>
  );
}

export default App;
