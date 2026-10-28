// A case of the API's test suite (docs/dev/compatibility.md): `Select` of
// `nsh/base` on a phone, where its list is a sheet over a backdrop: the
// items as data (sections, a disabled item), the value the app owns
// (`value`, `null` for none, one the app keeps), the select's own
// (`defaultValue`), the open state (controlled, `defaultOpen`), search and
// what shows while nothing matches (`searchable`, `empty`), the app's rows
// and headers (`renderItem`, `renderGroup`), every part styled by the app
// (row heights tell its `focus:` and `disabled:` classes), the roles and
// states screen readers get, and each change reported with its reason, the
// lifecycle (`onOpen`, `onClose`) and Escape, back or the backdrop heard
// (`onCancel`), and the clear button of a select's own value
// (`cleanable`, `onChange(null)`). Its script checks each.
import { Text, View, signal } from "nsh";
import { Select } from "nsh/base";

const FOOD = [
  { value: "apple", title: "Apple", group: "Fruits" },
  { value: "banana", title: "Banana", group: "Fruits", disabled: true },
  { value: "cherry", title: "Cherry", group: "Fruits" },
  { value: "carrot", title: "Carrot", group: "Vegetables" },
  { value: "rice", title: "Rice" },
];

const titleOf = (value: string | null) => FOOD.find((f) => f.value === value)?.title ?? "none";

function App() {
  const value = signal<string | null>(null);
  const open = signal(false);
  const changes = signal(0);
  const changed = signal("Changed: none");
  const opened = signal("Open: none");
  const life = signal("Life: none");
  const heard = signal("Heard: none");
  const asked = signal("Asked: none");
  const found = signal("Find: none");
  const cleared = signal("Own: none");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{changed()}</Text>
      <Text>{opened()}</Text>
      <Text>{life()}</Text>
      <Text>{heard()}</Text>
      <Text>{asked()}</Text>
      <Text>{found()}</Text>
      <Text>{cleared()}</Text>
      <Select
        items={[{ value: "start", title: "OpenAtStart" }]}
        defaultOpen
        trigger={<View style={{ height: 30 }}><Text>StartTrigger</Text></View>}
      />
      <Select
        items={FOOD}
        value={value()}
        defaultValue="rice"
        open={open()}
        onChange={({ value: next }) => {
          value.set(next);
          changes.set(changes() + 1);
          changed.set(`Changed: ${next} ${changes()}`);
        }}
        onOpenChange={({ open: next, reason }) => {
          open.set(next);
          opened.set(`Open: ${next} ${reason}`);
        }}
        onOpen={() => life.set("Life: open")}
        onClose={() => life.set("Life: closed")}
        onCancel={() => heard.set("Heard: cancel")}
        accessibilityLabel="Fruit"
        popupClass="bg-[#00ff00]"
        popupStyle={{ borderRadius: 12 }}
        backdropClass="bg-[#000000]"
        backdropStyle={{ opacity: 0.5 }}
        listClass="bg-[#0000ff]"
        listStyle={{ opacity: 0.75 }}
        itemClass="h-[30px] focus:h-[40px] disabled:h-[24px]"
        itemStyle={{ backgroundColor: "#ff00ff" }}
        trigger={<View testID="fruit" style={{ height: 30 }}><Text>{`Fruit: ${titleOf(value())}`}</Text></View>}
        renderItem={(item) => <Text>{`${item.highlighted ? ">" : ""}${item.title}${item.selected ? " ✓" : ""}`}</Text>}
        renderGroup={(group) => <Text>{`[${group.title}]`}</Text>}
      />
      <View onPress={() => open.set(true)} style={{ height: 30 }}><Text>ShowFruit</Text></View>
      <Select
        items={FOOD}
        value="rice"
        onChange={({ value: next }) => asked.set(`Asked: ${next}`)}
        accessibilityLabel="Pinned"
        trigger={<View testID="pinned" style={{ height: 30 }}><Text>PinnedTrigger</Text></View>}
      />
      <Select
        items={FOOD}
        defaultValue="carrot"
        accessibilityLabel="Own"
        groupClass="bg-[#ffff00]"
        groupStyle={{ opacity: 0.5 }}
        onChange={({ value: next }) => cleared.set(`Own: ${next}`)}
        cleanable
        clearButtonAccessibilityLabel="ClearOwn"
        clearButtonClass="w-[20px]"
        clearButtonStyle={{ height: 20 }}
        clearButton={<Text>X</Text>}
        trigger={<View testID="own" style={{ height: 30 }}><Text>OwnTrigger</Text></View>}
      />
      <Select
        items={FOOD}
        disabled
        accessibilityLabel="Locked"
        trigger={<View testID="locked" style={{ height: 30 }}><Text>LockedTrigger</Text></View>}
      />
      <Select
        items={FOOD}
        searchable
        searchPlaceholder="Find food"
        searchClass="bg-[#abcdef]"
        searchStyle={{ borderRadius: 4 }}
        empty={<Text>Nothing found</Text>}
        onOpenChange={({ open: next, reason }) => found.set(`Find: ${next} ${reason}`)}
        accessibilityLabel="Find"
        trigger={<View testID="find" style={{ height: 30 }}><Text>FindTrigger</Text></View>}
      />
    </View>
  );
}

export default App;
