// A case of the API's test suite (docs/dev/compatibility.md): `registerFont`
// while the app runs. The app's own font registered again by its `asset:/`
// URL resolves to `{ family }`, and data that is no font rejects with an
// `Error`. Its script checks each.
import { Text, View, registerFont, signal } from "nsh";
import Pacifico from "./fonts/Pacifico-Regular.ttf";

function App() {
  const family = signal("pending");
  const noFont = signal("pending");
  registerFont("asset:/fonts/Pacifico-Regular.ttf").then(
    font => family.set(`${font.family}, ${font.family === Pacifico}`),
    e => family.set(`refused: ${e}`),
  );
  registerFont(new Uint8Array([0, 1, 0, 0, 7])).then(
    () => noFont.set("registered"),
    e => noFont.set(`refused, ${e instanceof Error}`),
  );
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Text>Registered: {family()}</Text>
      <Text>No font: {noFont()}</Text>
    </View>
  );
}

export default App;
