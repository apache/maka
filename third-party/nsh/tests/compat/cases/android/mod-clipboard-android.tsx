// A case of the API's test suite (docs/dev/compatibility.md): `Clipboard`'s
// images as on Android (`platform android`), whose clipboard carries images
// as `content:` URIs the app's FilesProvider serves: writing one reaches the
// platform and resolves. Its script checks it.
import { Text, View, signal } from "nsh";
import { Clipboard } from "nsh";

const settle = (p: Promise<unknown>) =>
  p.then(
    (value) => `ok ${value}`,
    (e) => `rejected ${e.code}`,
  );

function App() {
  const write = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Write: ${write()}`}</Text>
      <View
        testID="paste"
        onPress={() => {
          settle(Clipboard.writeImage("data:image/png;base64,aGk=")).then((r) => write.set(r));
        }}
      >
        <Text>Paste</Text>
      </View>
    </View>
  );
}

export default App;
