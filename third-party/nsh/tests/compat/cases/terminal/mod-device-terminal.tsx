// A case of the API's test suite (docs/dev/compatibility.md): a script run
// as in a terminal on Linux (`platform linux terminal`): `platform` reports
// the Terminal idiom with the real OS, and desktop behavior applies
// (`platform.select`'s `desktop` key, `desktop={{…}}` props). Its script
// checks each.
import { Text, View, platform } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`OS: ${platform.os}`}</Text>
      <Text>{`Idiom: ${platform.idiom}`}</Text>
      <Text>{`Select: ${platform.select({ mobile: "mobile", desktop: "desktop" })}`}</Text>
      <View testID="bar" desktop={{ windowDrag: true }}>
        <Text>Bar</Text>
      </View>
    </View>
  );
}

export default App;
