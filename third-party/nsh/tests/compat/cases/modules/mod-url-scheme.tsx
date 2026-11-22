// A case of the API's test suite (docs/dev/compatibility.md):
// `UrlScheme` with the schemes the domain's nsh.json claims: `on("open")`
// returns a function that stops listening, and nothing arrives while no
// link opens the app; `url()` is `null` until `setUrl` gives the address
// (no page here), with `history: "push"` too, and a wrong `setUrl` (a
// `history` it does not know included) is a `TypeError`; `on("change")`
// hears no move of the address the app makes itself, and also returns a
// function that stops it. Its script checks each.
import { UrlScheme, Text, View, signal } from "nsh";

function App() {
  const links = signal("none");
  const stops = signal("listening");
  const address = signal(`${UrlScheme.url()}`);
  const stop = UrlScheme.on("open", ({ url }) => links.set(url));
  const changes = signal("none");
  const stopChanges = UrlScheme.on("change", ({ url, reason }) => changes.set(`${reason} ${url}`));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Links: ${links()}`}</Text>
      <Text>{`Listener: ${stops()}`}</Text>
      <Text>{`Address: ${address()}`}</Text>
      <Text>{`Changes: ${changes()}`}</Text>
      <View
        testID="set-url"
        onPress={() => {
          UrlScheme.setUrl("compat://orders/42");
          UrlScheme.setUrl("compat://orders/43", { history: "push" });
          const wrongs = [
            [42 as never],
            ["a b"],
            ["compat://orders/44", { history: "sideways" as never }],
          ].map(([url, options]) => {
            try {
              UrlScheme.setUrl(url as string, options as { history?: "replace" | "push" });
              return "none";
            } catch (error) {
              return error instanceof TypeError ? "TypeError" : String(error);
            }
          });
          const wrong = wrongs.join(" ");
          address.set(`${UrlScheme.url()}, wrong ${wrong}`);
        }}
      >
        <Text>Set the address</Text>
      </View>
      <View
        testID="stop-links"
        onPress={() => {
          stop();
          stopChanges();
          const stopped = typeof stop === "function" && typeof stopChanges === "function";
          stops.set(stopped ? "stopped" : "no function");
        }}
      >
        <Text>Stop</Text>
      </View>
    </View>
  );
}

export default App;
