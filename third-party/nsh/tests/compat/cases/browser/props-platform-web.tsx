// A case of the API's test suite (docs/dev/compatibility.md): a script run
// as in a phone's browser (`platform web`), where `web={{…}}` props apply
// (any prop of the element) and `ios={{…}}` / `android={{…}}` ones do not.
// Its
// script checks it.
import { Text, View } from "nsh";
import type { WebProps } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="link"
        accessibilityLabel="Everywhere"
        web={{ accessibilityLabel: "In a browser" } as WebProps}
        android={{ elevation: 6 }}
        ios={{ backdropMaterial: "thick" }}
        style={{ height: 60 }}
      >
        <Text>Link</Text>
      </View>
    </View>
  );
}

export default App;
