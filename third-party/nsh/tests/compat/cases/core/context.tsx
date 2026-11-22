// A case of the API's test suite (docs/dev/compatibility.md): a context
// provided and read below, the device's locale, a press found by its testID
// and the layout of a few style keys. Its script checks each.
import { Text, View, context, signal } from "nsh";
import { locale } from "nsh";

const Theme = context("light");

function Label() {
  return <Text>Theme: {Theme()}</Text>;
}

function App() {
  const taps = signal(0);
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Label />
      <Theme.Provider value="dark">
        <Label />
      </Theme.Provider>
      <Text>{typeof locale() === "string" && locale().length > 0 ? "Locale read" : "No locale"}</Text>
      <View testID="tap" onPress={() => taps.set(taps() + 1)}>
        <Text>Taps: {taps()}</Text>
      </View>
      <View testID="box" style={{ width: 120, height: 40, marginLeft: 16, marginTop: 8 }} />
    </View>
  );
}

export default App;
