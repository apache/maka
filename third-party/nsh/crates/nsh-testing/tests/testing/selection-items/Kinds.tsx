import { List, mount, signal, Text, View, type TextSelectionEndpoint } from "nsh";
import { TextView, Tree } from "nsh/base";

type Row = {
  id?: string;
  key?: string;
  text?: string;
  markdown?: string;
  inner?: { id: string; text: string }[];
  tree?: boolean;
};

// Rows a list without a keyExtractor names by their key, id or index: a
// plain text, a markdown list, a list of its own and a tree (a Rust
// component's list). A title outside the list is selectable with them, and
// so is a list whose keyExtractor throws once `Break` is pressed.
const rows: Row[] = [
  { id: "x", text: "Row with an id." },
  { key: "k", text: "Row with a key." },
  { text: "Row by its index." },
  { id: "m", markdown: "- First item\n- Second item" },
  {
    id: "n",
    inner: [
      { id: "i1", text: "Inner one." },
      { id: "i2", text: "Inner two." },
    ],
  },
  { id: "t", tree: true },
];

const leaves = [
  { id: "l1", label: "Tree leaf one." },
  { id: "l2", label: "Tree leaf two." },
];

function App() {
  const ends = signal("none");
  const end = (e?: TextSelectionEndpoint) => (e ? `${e.key}@${e.offset}` : "-");
  let broken = false;
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Text>{`Ends: ${ends()}`}</Text>
      <View testID="break" onPress={() => (broken = true)}>
        <Text>Break</Text>
      </View>
      <View
        selectable
        style={{ height: 520 }}
        onSelectionChange={(e) => ends.set(e.text ? `${end(e.anchor)} ${end(e.focus)} ${JSON.stringify(e.text)}` : "none")}
      >
        <Text style={{ width: 154 }}>Transcript title</Text>
        <List each={rows} style={{ flex: 1 }}>
          {(row) => (
            <View style={{ paddingVertical: 8, alignItems: "flex-start" }}>
              {row().tree ? (
                <Tree
                  items={leaves}
                  accessibilityLabel="Leaves"
                  style={{ height: 60, width: 300 }}
                  renderItem={(entry) => (
                    <View style={{ height: 24, justifyContent: "center" }}>
                      <Text style={{ width: 154 }}>{entry.label}</Text>
                    </View>
                  )}
                />
              ) : row().inner ? (
                <List each={row().inner!} keyExtractor={(inner) => inner.id} style={{ height: 70, width: 300 }}>
                  {(inner) => (
                    <View style={{ paddingVertical: 4 }}>
                      <Text style={{ width: 154 }}>{inner().text}</Text>
                    </View>
                  )}
                </List>
              ) : row().markdown ? (
                <TextView markdown={row().markdown!} style={{ width: 300 }} />
              ) : (
                <Text style={{ width: 154 }}>{row().text}</Text>
              )}
            </View>
          )}
        </List>
        <List
          each={[{ id: "b1", text: "Row without a key." }]}
          keyExtractor={(row) => {
            if (broken) throw new Error("no key for this row");
            return row.id;
          }}
          style={{ height: 40 }}
        >
          {(row) => (
            <View style={{ paddingVertical: 8, alignItems: "flex-start" }}>
              <Text style={{ width: 154 }}>{row().text}</Text>
            </View>
          )}
        </List>
      </View>
    </View>
  );
}

mount(App);
