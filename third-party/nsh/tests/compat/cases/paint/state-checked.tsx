// A case of the API's test suite (docs/dev/compatibility.md): a switch
// styled by its value, which the core applies without JS: `checked:`
// classes and `checkedStyle` while `accessibilityState.checked` is `true`
// (not while it is "mixed"), `group-checked:` on the thumb inside it, and
// `disabledStyle` winning over `checkedStyle`. Its script toggles
// the value and checks the styles mounted in each state.
import { Text, View, signal } from "nsh";

function App() {
  const on = signal(false);
  const mixed = signal(false);
  const disabled = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="switch"
        role="switch"
        accessibilityState={{ checked: mixed() ? "mixed" : on() }}
        class="group h-6 w-10 bg-[#cccccc] p-0.5 checked:bg-[#00aa55]"
        checkedStyle={{ borderWidth: 2, borderColor: "#000000" }}
        disabledStyle={{ opacity: 0.4 }}
        disabled={disabled()}
        onPress={() => on.set(!on())}
      >
        <View testID="thumb" class="size-5 bg-[#ffffff] group-checked:bg-[#222222]" />
      </View>
      <Text>{`On: ${on()}`}</Text>
      <View testID="mixed" onPress={() => mixed.set(!mixed())}>
        <Text>Mixed</Text>
      </View>
      <View testID="disable" onPress={() => disabled.set(!disabled())}>
        <Text>Disable</Text>
      </View>
    </View>
  );
}

export default App;
