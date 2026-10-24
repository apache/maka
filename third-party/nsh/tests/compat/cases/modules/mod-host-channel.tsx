// A case of the API's test suite (docs/dev/compatibility.md): `nsh/host`
// on the headless runtime, which runs the app without an embedding app: the
// launch parameters are empty, a listener is added and removed, a post goes
// nowhere and a call fails at once with the reason. Its script checks each.
import { Text, View, signal } from "nsh";
import { host } from "nsh/host";

function App() {
  const calls = signal("not called");
  const failed = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Params: ${Object.keys(host.params).length} ${typeof host.params}`}</Text>
      <Text>{`Calls: ${calls()}`}</Text>
      <Text>{`Call failed: ${failed()}`}</Text>
      <View
        testID="call"
        onPress={() => {
          const off = host.on<{ id: string }>("conversation.open", ({ id }) => failed.set(`opened ${id}`));
          off();
          host.post("analytics", { screen: "home" });
          host.call<{ name: string }>("profile", { id: 7 }).then(
            (profile) => failed.set(`answered ${profile.name}`),
            (e: Error) => failed.set(e.message),
          );
          calls.set(`${typeof off}, post done`);
        }}
      >
        <Text>Call</Text>
      </View>
    </View>
  );
}

export default App;
