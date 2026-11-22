// A case of the API's test suite (docs/dev/compatibility.md): `Tree` of
// `nsh/base`, items that hold items with no look of their own: the roles,
// names and states screen readers get (a tree of tree items, expanded,
// selected, disabled), a press selecting a row and expanding or collapsing
// a folder, the events (`onExpandedChange`, `onSelectedChange`, `onExpand`,
// `onCollapse`, and `onAction`, which a double press reports and a single
// one never does), the app's state (`expanded`, `selected`) or the tree's own
// (`defaultExpanded`, `defaultSelected`), `itemClass` with `selected:` and
// `focus:` (the row the keys act on while the tree has the focus),
// `itemStyle`, the list's `listClass` and `listStyle`, `renderItem` given
// each item's depth, a read-only tree (`disabled`), `reveal`, and the ref's
// `revealItem` and `focus`.
import { Text, View, signal } from "nsh";
import { Tree, type TreeItem, type TreeRef } from "nsh/base";

const files: TreeItem[] = [
  {
    id: "src",
    label: "src",
    children: [
      { id: "src/lib.rs", label: "lib.rs" },
      { id: "src/ui", label: "ui", children: [{ id: "src/ui/tree.rs", label: "tree.rs" }] },
    ],
  },
  { id: "docs", label: "docs", disabled: true, children: [{ id: "docs/guide.md", label: "guide.md" }] },
  { id: "README.md", label: "README.md" },
];

const notes: TreeItem[] = [
  { id: "notes", label: "notes", children: [{ id: "notes/a", label: "a.md" }] },
  { id: "todo", label: "todo.md" },
];

function App() {
  const expanded = signal<string[]>(["src"]);
  const selected = signal<string | null>(null);
  const heard = signal("none");
  const acted = signal("none");
  const changes = signal(0);
  const locked = signal(false);
  let tree!: TreeRef;
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Tree
        testID="files"
        ref={(r) => (tree = r)}
        accessibilityLabel="Files"
        items={files}
        expanded={expanded()}
        selected={selected()}
        reveal
        style={{ height: 160 }}
        listClass="bg-[#0000ff]"
        listStyle={{ opacity: 0.75 }}
        itemClass="h-[20px] selected:bg-[#00ff00] focus:opacity-50"
        itemStyle={{ borderRadius: 3 }}
        onExpandedChange={({ expanded: next }) => {
          changes.set(changes() + 1);
          expanded.set(next);
        }}
        onSelectedChange={({ selected: next }) => selected.set(next)}
        onExpand={({ id }) => heard.set(`expand ${id}`)}
        onCollapse={({ id }) => heard.set(`collapse ${id}`)}
        onAction={({ id }) => acted.set(id)}
      />
      <Tree
        testID="notes"
        accessibilityLabel="Notes"
        items={notes}
        defaultExpanded={["notes"]}
        defaultSelected="notes/a"
        disabled={locked()}
        style={{ height: 80 }}
        renderItem={(entry) => <Text>{`${entry.folder ? "+" : ""}${entry.label}@${entry.depth}`}</Text>}
      />
      <View testID="reveal" style={{ height: 20 }} onPress={() => tree.revealItem("src/ui/tree.rs")} />
      <View testID="focus" style={{ height: 20 }} onPress={() => tree.focus()} />
      <View testID="lock" style={{ height: 20 }} onPress={() => locked.set(!locked())} />
      <Text>{`Selected: ${selected() ?? "none"}`}</Text>
      <Text>{`Expanded: ${expanded().join(",")}`}</Text>
      <Text>{`Heard: ${heard()}`}</Text>
      <Text>{`Changes: ${changes()}`}</Text>
      <Text>{`Acted: ${acted()}`}</Text>
    </View>
  );
}

export default App;
