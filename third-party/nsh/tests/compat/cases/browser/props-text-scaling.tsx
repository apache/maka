// A case of the API's test suite (docs/dev/compatibility.md): the system
// text size (the script runs under twice the default) scales the fonts of
// texts and inputs, unless `allowFontScaling` is false, up to
// `maxFontSizeMultiplier`. Its script
// checks each.
import { Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64, alignItems: "flex-start" }}>
      <Text testID="scaled" style={{ fontSize: 10 }}>
        Scaled
      </Text>
      <Text testID="fixed" allowFontScaling={false} style={{ fontSize: 10 }}>
        Fixed
      </Text>
      <Text testID="capped" maxFontSizeMultiplier={1.5} style={{ fontSize: 10 }}>
        Capped
      </Text>
      <Input testID="field" style={{ width: 200, fontSize: 10 }} />
      <Input testID="field-fixed" allowFontScaling={false} style={{ width: 200, fontSize: 10 }} />
      <Input
        testID="field-capped"
        maxFontSizeMultiplier={1.5}
        style={{ width: 200, fontSize: 10 }}
      />
    </View>
  );
}

export default App;
