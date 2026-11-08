// A case of the API's test suite (docs/dev/compatibility.md):
// `UrlScheme` with the schemes the domain's nsh.json claims: `on("open")`
// returns a function that stops listening, and nothing arrives while no
// link opens the app. Its script checks both.
import { UrlScheme, Text, View, signal } from "nsh";

function App() {
  const links = signal("none");
  const stops = signal("listening");
  const stop = UrlScheme.on("open", ({ url }) => links.set(url));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Links: ${links()}`}</Text>
      <Text>{`Listener: ${stops()}`}</Text>
      <View
        testID="stop-links"
        onPress={() => {
          stop();
          stops.set(typeof stop === "function" ? "stopped" : "no function");
        }}
      >
        <Text>Stop</Text>
      </View>
    </View>
  );
}

export default App;
