// A case of the API's test suite (docs/dev/compatibility.md): the
// accessibility props of every element as the platform receives them on
// iOS (the scripts' default platform): `accessible`, `accessibilityHint`,
// `accessibilityState`, `accessibilityValue`, `accessibilityElementsHidden`,
// `accessibilityActions`, `importantForAccessibility`, which decides
// `accessible` and hides the descendants for `"no-hide-descendants"`, and
// the `"listbox"` and `"option"` roles of a select's popup, the chosen
// option `selected`. Its script checks each.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="group" accessible={true} style={{ height: 20 }}>
        <Text>Group</Text>
      </View>
      <View testID="hint" accessibilityHint="Opens the settings" style={{ height: 20 }} />
      <View
        testID="state"
        accessibilityState={{ disabled: true, checked: "mixed", expanded: false }}
        style={{ height: 20 }}
      />
      <View
        testID="value"
        accessibilityValue={{ min: 0, max: 10, now: 4, text: "four" }}
        style={{ height: 20 }}
      />
      <View testID="hidden" accessibilityElementsHidden={true} style={{ height: 20 }} />
      <View
        testID="important-no"
        importantForAccessibility="no-hide-descendants"
        style={{ height: 20 }}
      />
      <View testID="important-yes" importantForAccessibility="yes" style={{ height: 20 }} />
      <View
        testID="actions"
        accessibilityActions={[{ name: "activate" }, { name: "magicTap", label: "Magic" }]}
        style={{ height: 20 }}
      />
      <View testID="listbox" role="listbox" accessibilityLabel="Fruit">
        <View
          testID="option"
          role="option"
          accessibilityState={{ selected: true }}
          style={{ height: 20 }}
        >
          <Text>Apple</Text>
        </View>
        <View testID="other-option" role="option" style={{ height: 20 }}>
          <Text>Banana</Text>
        </View>
      </View>
      <View testID="plain" style={{ height: 20 }} />
    </View>
  );
}

export default App;
