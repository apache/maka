// A case of the API's test suite (docs/dev/compatibility.md): `Switch` of
// `nsh/base`, an on / off control with no look of its own: its role and
// value as screen readers get them (`accessibilityLabel`), presses
// reporting the next value (`onChange`) while the app owns it
// (`checked`), `disabled`, and the app's look of the switch
// (`checkedStyle`) and of its track and thumb (`trackClass`, `trackStyle`,
// `thumbClass`, `thumbStyle`), whose `checked:` and `disabled:` classes
// follow the switch. The parts' widths move the label after them, which
// is how its script sees them.
import { Text, View, signal } from "nsh";
import { Switch } from "nsh/base";

const parts = {
  class: "flex-row items-center",
  trackClass: "p-[2px] checked:pl-[12px]",
  trackStyle: { marginRight: 8 },
  thumbClass: "w-[20px] checked:w-[30px] disabled:w-[10px]",
  thumbStyle: { height: 20 },
};

function App() {
  const wifi = signal(false);
  const changes = signal(0);
  const asked = signal("");
  const disabled = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Switch
        testID="wifi"
        checked={wifi()}
        checkedStyle={{ backgroundColor: "#00ff00" }}
        onChange={({ checked }) => {
          changes.set(changes() + 1);
          wifi.set(checked);
        }}
        {...parts}
      >
        <Text>Wi-Fi</Text>
      </Switch>
      <Text>{`Changes: ${changes()}`}</Text>
      <Switch testID="lights" checked accessibilityLabel="Lights" onChange={({ checked }) => asked.set(String(checked))} {...parts} />
      <Text>{`Asked: ${asked()}`}</Text>
      <Switch
        testID="locked"
        disabled={disabled()}
        onChange={() => changes.set(changes() + 10)}
        {...parts}
      >
        <Text>Locked</Text>
      </Switch>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
