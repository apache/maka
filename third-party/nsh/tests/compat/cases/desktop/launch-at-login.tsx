// A case of the API's test suite (docs/dev/compatibility.md): launching at
// login (`Application.launchAtLogin`, `Application.setLaunchAtLogin`),
// granted by the domain's `application`, in a run that cannot (headless, as in a view embedded
// in another app and under `nsh run`): reading it resolves `false`, turning
// it on rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` and a wrong use
// with a `TypeError`. Its script checks each.
import { Text, View, signal } from "nsh";
import { Application } from "nsh/desktop";

function App() {
  const read = signal("not read");
  const set = signal("not set");
  const misuse = signal("not misused");
  Application.launchAtLogin().then(
    (enabled) => read.set(`${typeof enabled} ${enabled}`),
    (error) => read.set(`rejected ${error?.code}`),
  );
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Launch at login: ${read()}`}</Text>
      <Text>{`Set: ${set()}`}</Text>
      <Text>{`Misuse: ${misuse()}`}</Text>
      <View
        testID="enable"
        onPress={() =>
          Application.setLaunchAtLogin(true).then(
            (value) => set.set(`resolved ${value}`),
            (error) => set.set(`${error instanceof Error} ${error?.code}`),
          )
        }
      >
        <Text>Enable</Text>
      </View>
      <View
        testID="misuse"
        onPress={() =>
          (Application.setLaunchAtLogin as (enabled?: boolean) => Promise<void>)().then(
            () => misuse.set("resolved"),
            (error) => misuse.set(error instanceof TypeError ? "TypeError" : `${error}`),
          )
        }
      >
        <Text>Misuse</Text>
      </View>
    </View>
  );
}

export default App;
