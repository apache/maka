// A case of the API's test suite (docs/dev/compatibility.md): a toggle
// button styled by its pressed state, which the core applies without JS:
// `aria-pressed:` classes and `pressedStyle` while
// `accessibilityState.pressed` is `true` (not while it is "mixed"),
// `group-aria-pressed:` on the icon inside it; and the `aria-busy:`,
// `aria-checked:` and `aria-selected:` classes of views in those states.
// Its script toggles the button and checks the styles mounted in each
// state.
import { Text, View, signal } from "nsh";

function App() {
  const on = signal(false);
  const mixed = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="bold"
        role="button"
        accessibilityState={{ pressed: mixed() ? "mixed" : on() }}
        class="group h-8 w-8 bg-[#cccccc] aria-pressed:bg-[#3355ff]"
        pressedStyle={{ borderWidth: 2, borderColor: "#000000" }}
        onPress={() => on.set(!on())}
      >
        <View testID="icon" class="size-4 bg-[#ffffff] group-aria-pressed:bg-[#222222]" />
      </View>
      <Text>{`Bold: ${on()}`}</Text>
      <View testID="mixed" onPress={() => mixed.set(!mixed())}>
        <Text>Mixed</Text>
      </View>
      <View
        testID="busy"
        accessibilityState={{ busy: true }}
        class="h-4 bg-[#cccccc] aria-busy:bg-[#ff0000]"
      />
      <View
        testID="checked"
        role="checkbox"
        accessibilityState={{ checked: true }}
        class="h-4 bg-[#cccccc] aria-checked:bg-[#00ff00]"
      />
      <View
        testID="selected"
        role="option"
        accessibilityState={{ selected: true }}
        class="h-4 bg-[#cccccc] aria-selected:bg-[#0000ff]"
      />
    </View>
  );
}

export default App;
