// A case of the API's test suite (docs/dev/compatibility.md): `Combobox`
// of `nsh/base` on a phone, where its list is a sheet: an array value the
// app owns, toggled with `multiple` while the list stays open
// (`onChange({ value })`), confirmed as it closes (`onConfirm`), the app's
// query (`query`, `onQueryChange`), the footer and its part, and a single
// combobox whose choice replaces the value and closes. Its script checks
// each.
import { Text, View, signal } from "nsh";
import { Combobox } from "nsh/base";

const TAGS = [
  { value: "red", title: "Red" },
  { value: "green", title: "Green" },
  { value: "blue", title: "Blue" },
];

function App() {
  const tags = signal<string[]>(["red"]);
  const query = signal("");
  const one = signal<string[]>([]);
  const confirmed = signal("Confirmed: none");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Tags: ${tags().join(",")}`}</Text>
      <Text>{`Query: ${query()}`}</Text>
      <Text>{`One: ${one().join(",")}`}</Text>
      <Text>{confirmed()}</Text>
      <Combobox
        items={TAGS}
        multiple
        value={tags()}
        onChange={({ value }) => tags.set(value)}
        onConfirm={({ value }) => confirmed.set(`Confirmed: ${value.join(",")}`)}
        searchable
        searchPlaceholder="FindTag"
        query={query()}
        onQueryChange={({ query: next }) => query.set(next)}
        accessibilityLabel="Tags"
        footerClass="h-[20px]"
        footerStyle={{ backgroundColor: "#ff0000" }}
        footer={<Text>TagFooter</Text>}
        trigger={<View testID="tags" style={{ height: 30 }}><Text>TagsTrigger</Text></View>}
      />
      <Combobox
        items={TAGS}
        defaultValue={["blue"]}
        onChange={({ value }) => one.set(value)}
        accessibilityLabel="One"
        trigger={<View testID="one" style={{ height: 30 }}><Text>OneTrigger</Text></View>}
      />
    </View>
  );
}

export default App;
