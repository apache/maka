// A case of the API's test suite (docs/dev/compatibility.md): `nsh`
// on a platform without a host (the headless runtime's): `available()` is
// false, a call rejects at once with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`
// (messages are for people: an app branches on `code`), and the root's
// host events reach
// `host.on`'s listeners until they are removed. Its script checks each.
import { Text, View, signal } from "nsh";
import { host } from "nsh";

function App() {
  const called = signal("not called");
  const heard = signal<unknown[]>([]);
  const stop = host.on("tick", (payload) => heard.update((h) => [...h, payload]));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Host available: ${host.available()}`}</Text>
      <Text>{`Host call: ${called()}`}</Text>
      <Text testID="heard">{`Host heard: ${JSON.stringify(heard())}`}</Text>
      <View
        testID="call"
        onPress={() =>
          host.call("echo", { n: 1 }, { timeout: 1000 }).then(
            (value) => called.set(`ok ${JSON.stringify(value)}`),
            (e: Error & { code?: string }) => called.set(`rejected ${e.name} ${e.code}`),
          )
        }
      >
        <Text>Call</Text>
      </View>
      <View testID="stop" onPress={() => stop()}>
        <Text>Stop</Text>
      </View>
    </View>
  );
}

export default App;
