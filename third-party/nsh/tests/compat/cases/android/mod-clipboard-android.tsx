// A case of the API's test suite (docs/dev/compatibility.md): `Clipboard`'s
// images as on Android (`platform android`), where the clipboard carries
// text: writing and reading an image reject with
// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `hasImage` answers `false`. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { Clipboard } from "nsh";

const settle = (p: Promise<unknown>) =>
  p.then(
    (value) => `ok ${value}`,
    (e) => `rejected ${e.code}`,
  );

function App() {
  const write = signal("not called");
  const read = signal("not called");
  const has = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Write: ${write()}`}</Text>
      <Text>{`Read: ${read()}`}</Text>
      <Text>{`Has: ${has()}`}</Text>
      <View
        testID="paste"
        onPress={() => {
          settle(Clipboard.writeImage("data:image/png;base64,aGk=")).then((r) => write.set(r));
          settle(Clipboard.readImage()).then((r) => read.set(r));
          settle(Clipboard.hasImage()).then((r) => has.set(r));
        }}
      >
        <Text>Paste</Text>
      </View>
    </View>
  );
}

export default App;
