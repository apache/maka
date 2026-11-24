// A list with no `orientation` (both pairs of arrows move), a horizontal
// one (Left and Right move, Up and Down are the page's) and a vertical one
// (Up and Down move, Left and Right are the page's), each with the text of
// the selected tab. `tabs-orientation.test.tsx` runs it.
import { mount, signal, Text, View } from "nsh";
import { Tab, Tabs } from "nsh/base";

function List(props: { name: string; orientation?: "horizontal" | "vertical" }) {
  const selected = signal("one");
  const tab = (value: string) => (
    <Tab selected={selected() === value} onPress={() => selected.set(value)} class="px-3 py-2">
      <Text>{`${props.name} ${value}`}</Text>
    </Tab>
  );
  return (
    <View style={{ gap: 8 }}>
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

mount(() => (
  <View style={{ gap: 24, padding: 16 }}>
    <List name="Default" />
    <List name="Row" orientation="horizontal" />
    <List name="Column" orientation="vertical" />
  </View>
));
