// A case of the API's test suite (docs/dev/compatibility.md): `Select` of
// `nsh/base` on macOS, where its list opens with the chosen row over the
// trigger, and with `cover={false}` below the trigger as on the other
// desktops. Its script checks each.
import { Text, View } from "nsh";
import { Select } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 300, paddingLeft: 20, gap: 8 }}>
      <Select
        items={[{ value: "lime", title: "Lime" }]}
        defaultValue="lime"
        itemClass="h-[30px]"
        trigger={<View style={{ width: 150, height: 30 }}><Text>CoverSelect</Text></View>}
      />
      <Select
        items={[{ value: "kiwi", title: "Kiwi" }]}
        defaultValue="kiwi"
        cover={false}
        itemClass="h-[30px]"
        trigger={<View style={{ width: 150, height: 30 }}><Text>BelowSelect</Text></View>}
      />
      <View onPress={() => {}} style={{ height: 30 }}><Text>Elsewhere</Text></View>
    </View>
  );
}

export default App;
