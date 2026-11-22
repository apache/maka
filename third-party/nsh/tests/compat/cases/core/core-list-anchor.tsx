// A case of the API's test suite (docs/dev/compatibility.md): a `List` at
// its start shows the rows that arrive above its first one, as a browser
// does, and one loading pages at its start (`onLoadMoreAtStart`) keeps its
// rows in place, so the page it prepends waits above them. Its script
// prepends rows to each and checks what shows.
import { List, Text, View, signal } from "nsh";

const rows = (name: string) => Array.from({ length: 12 }, (_, i) => `${name} ${i + 1}`);
const page = (name: string) => Array.from({ length: 3 }, (_, i) => `${name} new ${i + 1}`);

function App() {
  const plain = signal(rows("Row"));
  const paged = signal(rows("Page"));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="prepend-rows" onPress={() => plain.set([...page("Row"), ...plain()])}>
        <Text>Prepend rows</Text>
      </View>
      <List testID="rows" each={plain()} style={{ height: 120 }}>
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>{item()}</Text>
          </View>
        )}
      </List>
      <View testID="prepend-page" onPress={() => paged.set([...page("Page"), ...paged()])}>
        <Text>Prepend a page</Text>
      </View>
      <List testID="paged" each={paged()} style={{ height: 120 }} onLoadMoreAtStart={() => {}}>
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>{item()}</Text>
          </View>
        )}
      </List>
    </View>
  );
}

export default App;
