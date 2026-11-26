// A case of the API's test suite (docs/dev/compatibility.md): `nsh/keymap`'s
// `overFocused: "pointer"`, run as on Windows (`platform windows`), where a popup a
// press used gives the keyboard focus back to its trigger. The app's Space
// plays: after a choice made with the pointer it takes the key from the
// trigger, which a binding without the option leaves to it (the list would
// open again). The keyboard's focus keeping Space is nsh-base's test: the
// runner moves the focus with Tab without telling the core the keyboard did.
import { keymap, signal, Text, View } from "nsh";
import { Select } from "nsh/base";

function App() {
  const plays = signal(0);
  keymap.bind("space", () => plays.set(plays() + 1), { when: "notEditing", overFocused: "pointer", scope: "app" });
  return (
    <View style={{ flex: 1, paddingTop: 64, paddingLeft: 20 }}>
      <Text>{`Plays: ${plays()}`}</Text>
      <Select
        items={[{ value: "sd", title: "SD" }, { value: "hd", title: "HD" }]}
        defaultValue="sd"
        itemClass="h-[30px]"
        trigger={<View testID="quality" style={{ width: 150, height: 30 }}><Text>Quality</Text></View>}
      />
    </View>
  );
}

export default App;
