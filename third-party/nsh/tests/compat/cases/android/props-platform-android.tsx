// A case of the API's test suite (docs/dev/compatibility.md): a script run
// as on Android (`platform android`), where `android={{…}}` props apply:
// one view's material shadow, beside one without. Its script
// checks it.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="card" android={{ elevation: 6 }} style={{ height: 60 }}>
        <Text>Card</Text>
      </View>
      <View testID="flat" style={{ height: 60 }}>
        <Text>Flat</Text>
      </View>
    </View>
  );
}

export default App;
