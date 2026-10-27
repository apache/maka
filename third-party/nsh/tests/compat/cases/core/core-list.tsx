// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `List` (`nsh:rt`'s `list`): the rows near the viewport rendered from
// `each`, with a header, a footer and separators, rows added when `each`
// changes, the padding of its content (`contentStyle`,
// `contentClass`), and what an empty list shows; `Scroll`'s view around its
// content (`contentStyle`, `contentClass`); the rows of the overscan around
// the viewport, rendered once the frames after the first bind them. Its
// script checks each.
import { List as NativeList, Scroll, Text, View, signal, type ListItemsProps, type ListProps } from "nsh";
import { List, type ReadonlyListSource } from "nsh";

function plumSource(name: string): ReadonlyListSource<string> {
  return { length: 1, at: () => name };
}

// Checked by `nsh check`: definite elements stay definite for both public
// entry points; a native class can provide its rows without becoming an array.
function listInferenceContract<T>(props: ListProps<T>, items: ListItemsProps<T>) {
  const rows: readonly { name: string }[] = [{ name: "Apple" }];
  List({ each: rows, children: (row) => {
    const item: { name: string } = row();
    // @ts-expect-error the inferred name is a string
    const wrong: number = row().name;
    return <Text>{item.name}{wrong}</Text>;
  } });
  NativeList({ each: [{ name: "Apple" }], children: (row) => {
    const item: { name: string } = row();
    // @ts-expect-error a definite row is not undefined
    const wrong: undefined = row();
    return <Text>{item.name}{wrong}</Text>;
  } });
  class Source {
    readonly length = 1;
    at(_index: number) { return { name: "Plum" }; }
  }
  NativeList({ each: new Source(), children: (row) => {
    const item: { name: string } = row();
    // @ts-expect-error the inferred source row is not a string
    const wrong: string = row();
    return <Text>{item.name}{wrong}</Text>;
  } });
  NativeList({ each: plumSource("Plum"), children: (row) => {
    const item: string = row();
    // @ts-expect-error the indexed source returns strings
    const wrong: number = row();
    return <Text>{item}{wrong}</Text>;
  } });
  NativeList(props);
  NativeList(items);
  return <NativeList {...props} />;
}

function App() {
  const items = signal(["Apple", "Banana", "Cherry"]);
  const plums = signal(plumSource("Plum"));
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <View testID="add" onPress={() => {
        items.set([...items(), `Item ${items().length + 1}`]);
        plums.set(plumSource("Updated plum"));
      }}>
        <Text>Add</Text>
      </View>
      <List
        testID="list"
        each={items()}
        style={{ height: 300 }}
        contentStyle={{ paddingHorizontal: 10 }}
        header={<Text>Fruits</Text>}
        footer={() => <Text>End of fruits</Text>}
        separator={() => <View testID="sep" style={{ height: 2 }} />}
      >
        {(item, index) => (
          <View testID={`row-${index()}`} style={{ height: 40 }}>
            <Text>
              {index() + 1}. {item()}
            </Text>
          </View>
        )}
      </List>
      <List
        testID="classed"
        each={plums()}
        style={{ height: 60 }}
        contentClass="px-4"
        empty={<Text>No plums</Text>}
      >
        {(item) => (
          <View testID="plum" style={{ height: 30 }}>
            <Text>{item()}</Text>
          </View>
        )}
      </List>
      <List testID="none" each={{ length: 0, at: (_index: number): string => "" }} style={{ height: 60 }} empty={() => <Text>Nothing here</Text>}>
        {(item) => <Text>{item()}</Text>}
      </List>
      <Scroll testID="scroll" style={{ height: 80 }} contentStyle={{ padding: 12 }}>
        <View testID="inner" style={{ height: 20 }} />
      </Scroll>
      <Scroll testID="scroll2" style={{ height: 80 }} contentClass="p-2">
        <View testID="inner2" style={{ height: 20 }} />
      </Scroll>
      <List testID="long" each={Array.from({ length: 30 }, (_, i) => i)} style={{ height: 100 }}>
        {(item) => (
          <View style={{ height: 40 }}>
            <Text>Long {item()}</Text>
          </View>
        )}
      </List>
    </View>
  );
}

export default App;
