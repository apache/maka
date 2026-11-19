import { mount, signal, Text, View } from "nsh";
import { ContextMenu, MenuItem, Select, TextView } from "nsh/base";

// A context menu whose trigger holds a text view (#2010), and a select
// whose `testID` names its trigger (#1999).
function App() {
  const chose = signal("none");
  const value = signal("a");
  return (
    <View style={{ flex: 1, paddingTop: 40, gap: 8 }}>
      <ContextMenu
        trigger={
          <View>
            <TextView markdown="Hallo" />
          </View>
        }
      >
        <MenuItem onSelect={() => chose.set("delete")}>
          <Text>Delete message</Text>
        </MenuItem>
      </ContextMenu>
      <Text>{`chose: ${chose()}`}</Text>
      <Select
        testID="field-kind"
        value={value()}
        items={[
          { value: "a", title: "Alpha" },
          { value: "b", title: "Beta" },
        ]}
        onChange={(e) => value.set(e.value!)}
        trigger={
          <View style={{ height: 30 }}>
            <Text>{value() === "a" ? "Alpha" : "Beta"}</Text>
          </View>
        }
      />
      <Text>{`value: ${value()}`}</Text>
    </View>
  );
}

mount(App);
