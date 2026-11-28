import { List, mount, signal, Text, View, type TextSelectionEndpoint } from "nsh";

// A long transcript in a short selectable view: most rows are not
// rendered, and those scrolled away are recycled.
const rows = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, text: `Row ${i} of the list.` }));

function App() {
  const ends = signal("none");
  const end = (e?: TextSelectionEndpoint) => (e ? `${e.key}@${e.offset}` : "-");
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <View
        selectable
        style={{ height: 200 }}
        onSelectionChange={(e) => ends.set(e.text ? `${end(e.anchor)} ${end(e.focus)}` : "none")}
      >
        <List testID="list" each={rows} keyExtractor={(row) => row.id} style={{ flex: 1 }}>
          {(row) => (
            <View style={{ paddingVertical: 8, alignItems: "flex-start" }}>
              <Text testID={`text-${row().id}`} style={{ width: 154 }}>
                {row().text}
              </Text>
            </View>
          )}
        </List>
      </View>
      <Text>{`Ends: ${ends()}`}</Text>
    </View>
  );
}

mount(App);
