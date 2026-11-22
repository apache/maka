// A case of the API's test suite (docs/dev/compatibility.md): an imported
// image with pixel-density siblings (`images/flag@2x.png`, `flag@3x.png`)
// loads the file for the screen's pixel ratio, as a source and as a
// placeholder, and lays out at the imported file's size in points. Its
// script checks each at three ratios.
import { View } from "nsh";
import { Image } from "nsh";
import flag from "./images/flag.png";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64, alignItems: "flex-start" }}>
      <Image testID="flag" src={flag} />
      <Image
        testID="remote"
        src="https://example.com/a.png"
        placeholder={flag}
        style={{ width: 40, height: 30 }}
      />
    </View>
  );
}

export default App;
