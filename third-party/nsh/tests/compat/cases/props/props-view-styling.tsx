// A case of the API's test suite (docs/dev/compatibility.md): how an
// element gets its style and its node: `style` (an object, or a nested
// list merged left to right, falsy entries skipped), `class` (Tailwind
// classes resolved natively; `style` wins over them), `classList` (classes
// while their value is truthy, following a signal), `ref` (a function gets
// the element's node) and `nativeID`, which names an `InputAccessoryView`
// that an input's `ios.inputAccessoryViewID` shows over the keyboard. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { Input } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function App() {
  const busy = signal(true);
  const measured = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="styled" style={{ height: 20, backgroundColor: "#3366ff", opacity: 0.5 }} />
      <View
        testID="list"
        style={[{ height: 20, backgroundColor: "#ff0000" }, [false, { backgroundColor: "#00ff00" }]]}
      />
      <View testID="classes" class="h-5 bg-red-500 rounded-lg" />
      <View testID="over" class="h-5 bg-red-500" style={{ backgroundColor: "#0000ff" }} />
      <View
        testID="toggled"
        class="h-5"
        classList={{ "opacity-50": busy(), "bg-blue-500": !busy() }}
      />
      <View testID="toggle" onPress={() => busy.set(!busy())} style={{ height: 20 }}>
        <Text>{busy() ? "Busy" : "Idle"}</Text>
      </View>
      <View
        ref={(node) => {
          node.measure().then((m) => measured.set(`${m.bounds.size.width}x${m.bounds.size.height}`));
        }}
        style={{ width: 120, height: 12 }}
      />
      <Text>{`Ref: ${measured()}`}</Text>
      <InputAccessoryView nativeID="bar">
        <View style={{ height: 44 }}>
          <Text>Accessory bar</Text>
        </View>
      </InputAccessoryView>
      <Input testID="field" ios={{ inputAccessoryViewID: "bar" }} style={{ height: 40 }} />
      <Input testID="other" ios={{ inputAccessoryViewID: "missing" }} style={{ height: 40 }} />
    </View>
  );
}

export default App;
