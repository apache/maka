// A case of the API's test suite (docs/dev/compatibility.md): `nsh/mobile`'s
// `InputAccessoryView` on the headless runtime, which is iOS: it takes no
// room where it is placed. Its script checks each.
import { Text, View, platform } from "nsh";
import { Input } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`iOS: ${platform.os === "ios"}`}</Text>
      <View testID="column">
        <View testID="above" style={{ height: 30 }} />
        <InputAccessoryView nativeID="bar">
          <View style={{ height: 44 }}>
            <Text>Accessory bar</Text>
          </View>
        </InputAccessoryView>
        <View testID="below" style={{ height: 30 }} />
      </View>
      <Input ios={{ inputAccessoryViewID: "bar" }} style={{ height: 40 }} />
      <Text>Rendered</Text>
    </View>
  );
}

export default App;
