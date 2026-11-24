// A case of the API's test suite (docs/dev/compatibility.md): a `Tabs`
// list's `orientation` (`"horizontal"` or `"vertical"`) picks the arrow
// keys that move between its tabs: Left and Right in a row, Up and Down in
// a column; the other pair is left to the page. A list with no
// `orientation` moves with both pairs, as before.
import { Text, signal, View } from "nsh";
import { Tab, Tabs } from "nsh/base";

function List(props: { name: string; orientation?: "horizontal" | "vertical" }) {
  const selected = signal("one");
  const tab = (value: string) => (
    <Tab
      testID={`${props.name.toLowerCase()}-${value}`}
      selected={selected() === value}
      onPress={() => selected.set(value)}
    >
      <Text>{`${props.name} ${value}`}</Text>
    </Tab>
  );
  return (
    <View style={{ gap: 4 }}>
      <Tabs
        orientation={props.orientation}
        accessibilityLabel={props.name}
        class={props.orientation === "vertical" ? "flex-col" : "flex-row"}
      >
        {tab("one")}
        {tab("two")}
        {tab("three")}
      </Tabs>
      <Text>{`${props.name} selected: ${selected()}`}</Text>
    </View>
  );
}

export default function BaseTabsOrientation() {
  return (
    <View style={{ paddingTop: 20, gap: 12 }}>
      <List name="Default" />
      <List name="Row" orientation="horizontal" />
      <List name="Column" orientation="vertical" />
    </View>
  );
}
