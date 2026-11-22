// A case of the API's test suite (docs/dev/compatibility.md): a toggle
// button styled by its pressed state, which the core applies without JS:
// `aria-pressed:` classes and `pressedStyle` while
// `accessibilityState.pressed` is `true` (not while it is "mixed"),
// `group-aria-pressed:` on the icon inside it; the `aria-busy:`,
// `aria-checked:`, `aria-invalid:` and `aria-selected:` classes of views
// in those states (an invalid field's `accessibilityState.invalid`);
// and the `data-*:` and `group-data-*:` classes, which a view without
// those attributes takes as known classes that do not apply (components'
// parts show them: `base-date-picker`'s days). Its script toggles the
// button and checks the styles mounted in each state.
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
      <View
        testID="invalid"
        accessibilityState={{ invalid: true }}
        class="h-4 bg-[#cccccc] aria-invalid:bg-[#ff8800]"
      />
      <View testID="data" class="group h-4 bg-[#cccccc] data-range-start:bg-[#ff0000]">
        <View testID="data-inner" class="size-2 bg-[#ffffff] group-data-range-start:bg-[#000000]" />
      </View>
    </View>
  );
}

export default App;
