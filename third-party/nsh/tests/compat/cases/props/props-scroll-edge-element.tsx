// A case of the API's test suite (docs/dev/compatibility.md): a bar
// floating over the bottom of a scroll view names it as the scroll view
// whose edge effect it shapes (`ios={{ scrollEdgeElement }}`), as the
// platform receives it. Its script checks it.
import { Scroll, Text, View, type ViewRef, signal } from "nsh";

function App() {
  const rows = signal<ViewRef>();
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Scroll ref={rows} testID="rows" style={{ flex: 1 }} contentInset={{ bottom: 64 }}>
        <View style={{ height: 900 }}>
          <Text>Rows</Text>
        </View>
      </Scroll>
      <View
        testID="bar"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 64 }}
        ios={{ scrollEdgeElement: rows() ? { scrollView: rows()!, edge: "bottom" } : null }}
      >
        <Text>New chat</Text>
      </View>
    </View>
  );
}

export default App;
