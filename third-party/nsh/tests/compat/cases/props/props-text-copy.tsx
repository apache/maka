// A case of the API's test suite (docs/dev/compatibility.md): `copyText` of
// views inside a selectable text, what a copy of the text gives in their
// place (an inline formula's source), and a view without one, which a copy
// leaves out. The script cannot select yet: it checks the app runs with
// them; the copies themselves are checked by the core's and the test
// driver's tests.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64, alignItems: "flex-start" }}>
      <Text testID="formula" style={{ userSelect: "text" }}>
        Area is <View testID="copied" copyText="$x^2$" style={{ width: 20, height: 10 }} /> here, a mark{" "}
        <View testID="plain" style={{ width: 10, height: 10 }} /> left out.
      </Text>
      <Text>Copy text</Text>
    </View>
  );
}

export default App;
