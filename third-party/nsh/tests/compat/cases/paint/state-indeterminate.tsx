// A case of the API's test suite (docs/dev/compatibility.md): a checkbox
// styled by its mixed value, which the core applies without JS:
// `indeterminate:` classes and `indeterminateStyle` while
// `accessibilityState.checked` is "mixed" (not while it is `true`),
// `group-indeterminate:` on the mark inside it, and `disabledStyle`
// winning over `indeterminateStyle`. Its script moves the value through
// mixed, checked and unchecked and checks the styles mounted in each.
import { Text, View, signal } from "nsh";

function App() {
  // "mixed", true or false, as the accessibility state takes it.
  const value = signal<boolean | "mixed">("mixed");
  const disabled = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="box"
        role="checkbox"
        accessibilityState={{ checked: value() }}
        class="group size-6 bg-[#cccccc] checked:bg-[#00aa55] indeterminate:bg-[#3355ff]"
        indeterminateStyle={{ borderWidth: 2, borderColor: "#000000" }}
        disabledStyle={{ opacity: 0.4 }}
        disabled={disabled()}
        onPress={() => value.set(value() === true ? false : true)}
      >
        <View testID="mark" class="size-4 bg-[#ffffff] group-indeterminate:bg-[#222222]" />
      </View>
      <Text>{`Value: ${value()}`}</Text>
      <View testID="mix" onPress={() => value.set("mixed")}>
        <Text>Mix</Text>
      </View>
      <View testID="disable" onPress={() => disabled.set(!disabled())}>
        <Text>Disable</Text>
      </View>
    </View>
  );
}

export default App;
