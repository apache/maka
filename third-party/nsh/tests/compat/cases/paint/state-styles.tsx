// A case of the API's test suite (docs/dev/compatibility.md): the styles
// of an element's interaction states, which the platform applies without
// JS: `activeStyle` while pressed, `hoverStyle` while a pointer is over it,
// `focusStyle` while it has focus, `disabledStyle` while `disabled`, which
// also takes the element's presses away (a press goes to the pressable
// around it). Its script reports the states as a platform does and checks the styles
// mounted before, during and after each.
import { Text, View, signal } from "nsh";
import { Input } from "nsh/base";

function App() {
  const presses = signal(0);
  const outer = signal(0);
  const disabled = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="active"
        style={{ height: 40, backgroundColor: "#3366ff", opacity: 1 }}
        activeStyle={{ backgroundColor: "#ff0000", opacity: 0.5 }}
        onPress={() => presses.set(presses() + 1)}
      />
      <Text>Presses: {presses()}</Text>
      <View
        testID="hover"
        style={{ height: 40, backgroundColor: "#ffffff" }}
        hoverStyle={{ backgroundColor: "#eeeeee", borderWidth: 2, borderColor: "#000000" }}
      />
      <Input
        testID="field"
        style={{ height: 40, borderWidth: 1, borderColor: "#cccccc" }}
        focusStyle={{ borderWidth: 2, borderColor: "#3366ff" }}
      />
      <View testID="outer" style={{ padding: 8 }} onPress={() => outer.set(outer() + 1)}>
        <View
          testID="target"
          disabled={disabled()}
          style={{ height: 40, backgroundColor: "#00ff00" }}
          activeStyle={{ backgroundColor: "#ff0000" }}
          hoverStyle={{ backgroundColor: "#0000ff" }}
          disabledStyle={{ backgroundColor: "#888888", opacity: 0.4 }}
          onPress={() => presses.set(presses() + 1)}
        />
      </View>
      <Text>Outer: {outer()}</Text>
      <View testID="toggle" onPress={() => disabled.set(!disabled())}>
        <Text>Toggle</Text>
      </View>
      <Text>Disabled: {String(disabled())}</Text>
    </View>
  );
}

export default App;
