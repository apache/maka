// `Tree`'s `header`, shown above the rows in the tree's scroll view, and
// `empty`, shown while no item shows.
import { Text, View, signal } from "nsh";
import { Tree, type TreeItem } from "nsh/base";

const files: TreeItem[] = [
  { id: "src", label: "src" },
  { id: "README.md", label: "README.md" },
];

export default function App() {
  const items = signal<TreeItem[]>([]);
  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <View testID="tree-slots-fill" onPress={() => items.set(files)}><Text>Fill tree</Text></View>
      <Tree
        testID="tree-slots"
        accessibilityLabel="Files"
        items={items()}
        style={{ height: 160 }}
        itemClass="h-[20px]"
        header={<Text>Pinned files</Text>}
        empty={<Text>No files</Text>}
      />
    </View>
  );
}
