// A case of the API's test suite (docs/dev/compatibility.md): the states'
// looks of the dropdowns of `nsh/base` on a desktop. A `Select`'s list, a
// `Combobox`'s and a `DatePicker`'s calendar are made with their starting
// looks (classes: the opacity; styles: the background), take their own look
// from their first frame on, and once closed stay with their ending looks
// through their transitions' 300 ms, `onClose` after. Its script checks each.
import { Text, View, signal } from "nsh";
import { Combobox, DatePicker, Select } from "nsh/base";

function App() {
  const life = signal("Life: none");
  return (
    <View style={{ flex: 1, paddingTop: 100, paddingLeft: 20, gap: 8 }}>
      <Select
        items={[{ value: "kiwi", title: "Kiwi" }]}
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onOpen={() => life.set("Life: select open")}
        onClose={() => life.set("Life: select closed")}
        trigger={<View style={{ height: 30, width: 100 }}><Text>SelectTrigger</Text></View>}
      />
      <Combobox
        items={[{ value: "lime", title: "Lime" }]}
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onClose={() => life.set("Life: combobox closed")}
        triggerButton={<Text>ComboTrigger</Text>}
        style={{ width: 200 }}
      />
      <DatePicker
        presets={[{ label: "Someday", value: "2026-10-29" }]}
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onClose={() => life.set("Life: date picker closed")}
        trigger={<View style={{ height: 30, width: 100 }}><Text>DateTrigger</Text></View>}
      />
      <Text>{life()}</Text>
    </View>
  );
}

export default App;
