// A case of the API's test suite (docs/dev/compatibility.md): SVG files
// imported as images, each laid out at its size in points: from its `width`
// and `height`, from its `viewBox` alone, and from one side with the other
// taken from the `viewBox`'s aspect ratio. Its script checks each source and
// size.
import { View } from "nsh";
import { Image } from "nsh";
import badge from "./svg/badge.svg";
import mark from "./svg/mark.svg";
import star from "./svg/star.svg";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64, alignItems: "flex-start" }}>
      <Image testID="sized" src={badge} />
      <Image testID="view-box" src={star} />
      <Image testID="one-side" src={mark} />
    </View>
  );
}

export default App;
