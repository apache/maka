// A case of the API's test suite (docs/dev/compatibility.md): `Select` of
// `nsh/base` on a desktop, where its list is a popup at the trigger: on a
// side of it (`placement`, `align`, `offset`, `margin`), at least as wide as
// the trigger and as tall as its rows, its search field taking the keyboard
// at once, and a press outside closing it. Its script checks each.
import { Text, View, signal } from "nsh";
import { Select } from "nsh/base";

function App() {
  const log = signal("Desk: none");
  return (
    <View style={{ flex: 1, paddingTop: 300, paddingLeft: 20, gap: 8 }}>
      <Select
        items={[{ value: "kiwi", title: "Kiwi" }]}
        searchable
        placement="right"
        align="end"
        offset={7}
        margin={5}
        popupStyle={{ width: 120, height: 600 }}
        onOpenChange={({ open, reason }) => log.set(`Desk: ${open} ${reason}`)}
        trigger={<View style={{ width: 100, height: 30 }}><Text>SideSelect</Text></View>}
      />
      <Select
        items={[{ value: "lime", title: "Lime" }]}
        itemClass="h-[30px]"
        trigger={<View style={{ width: 150, height: 30 }}><Text>WideSelect</Text></View>}
      />
      <View onPress={() => {}} style={{ height: 30 }}><Text>Elsewhere</Text></View>
      <Text>{log()}</Text>
    </View>
  );
}

export default App;
