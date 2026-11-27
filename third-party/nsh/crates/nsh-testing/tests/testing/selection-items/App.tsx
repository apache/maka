import { computed, List, mount, signal, Text, View, type TextSelectionEndpoint } from "nsh";
import { TextView } from "nsh/base";

type Item = { id: string; text?: string; markdown?: string };

// A transcript in a selectable view: two rows with the same text, a row
// of two paragraphs, and buttons that arm a change of the rows.
function App() {
  const items = signal<Item[]>([
    { id: "a", text: "All tests passed." },
    { id: "b", text: "All tests passed." },
    { id: "c", markdown: "First para.\n\nSecond para." },
  ]);
  const ends = signal("none");
  const start = signal(-1);
  const end = (e?: TextSelectionEndpoint) => (e ? `${e.key}@${e.offset}` : "-");
  // A change the buttons arm, made once the next selection is reported:
  // the rows change under the selection.
  let armed: (() => void) | undefined;
  const change = () => {
    const run = armed;
    armed = undefined;
    if (run) setTimeout(run, 0);
  };
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <View
        testID="transcript"
        selectable
        style={{ height: 400 }}
        onSelectionChange={(e) => {
          ends.set(e.text ? `${end(e.anchor)} ${end(e.focus)} ${JSON.stringify(e.text)}` : "none");
          start.set(e.start ?? -1);
          if (e.text) change();
        }}
      >
        <List each={items()} keyExtractor={(item) => item.id} style={{ flex: 1 }}>
          {(item) => {
            // A row given another item of its kind keeps its text, as a
            // list's recycled cells do.
            const markdown = computed(() => item().markdown);
            return (
              <View testID={`row-${item().id}`} style={{ paddingVertical: 8, alignItems: "flex-start" }}>
                {markdown() ? (
                  <TextView markdown={markdown()!} style={{ width: 300 }} />
                ) : (
                  <Text testID={`text-${item().id}`} style={{ width: 154 }}>
                    {item().text}
                  </Text>
                )}
              </View>
            );
          }}
        </List>
      </View>
      <View testID="insert" onPress={() => (armed = () => items.set([{ id: "z", text: "Inserted above." }, ...items()]))}>
        <Text>Insert</Text>
      </View>
      <View
        testID="replace"
        onPress={() => (armed = () => items.set(items().map((i) => (i.id === "b" ? { id: "d", text: i.text } : i))))}
      >
        <Text>Replace</Text>
      </View>
      <Text>{`Ends: ${ends()}`}</Text>
      <Text>{`Start: ${start()}`}</Text>
    </View>
  );
}

mount(App);
