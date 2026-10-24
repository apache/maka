// A case of the API's test suite (docs/dev/compatibility.md): items that
// stick a distance from the top (`stickyHeaderOffset`, CSS `position:
// sticky`'s `top`) rather than at it, a number or an animated value. Its
// script checks the travel the platform gets.
import { List, Text, View } from "nsh";
import { createAnimatedValue } from "nsh/animated";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function App() {
  const bar = createAnimatedValue(24);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <List each={range(8)} stickyHeaderIndices={[0, 3]} stickyHeaderOffset={24} style={{ height: 120 }}>
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Offset {item()}</Text>
          </View>
        )}
      </List>
      <List each={range(8)} stickyHeaderIndices={[0, 3]} stickyHeaderOffset={bar} style={{ height: 120 }}>
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Animated {item()}</Text>
          </View>
        )}
      </List>
    </View>
  );
}

export default App;
