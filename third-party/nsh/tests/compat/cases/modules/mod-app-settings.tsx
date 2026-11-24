// A case of the API's test suite (docs/dev/compatibility.md): `nsh/mobile`'s
// `AppSettings` on the headless runtime, which has no settings page of the
// app's own: `available()` resolves false and `open()` returns a promise (it
// never throws) that rejects with ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, never
// resolving as opened. Its script checks each.
import { Text, View, signal } from "nsh";
import { AppSettings } from "nsh/mobile";

function App() {
  const available = signal("unknown");
  const opened = signal("not opened");
  AppSettings.available().then((yes: boolean) => available.set(`${yes}`));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Available: ${available()}`}</Text>
      <Text>{`Settings: ${opened()}`}</Text>
      <View
        testID="settings"
        onPress={() => {
          try {
            const pending = AppSettings.open();
            opened.set(typeof pending.then === "function" ? "pending" : "not a promise");
            pending.then(
              (result) => opened.set(`resolved ${result.opened}`),
              (e: Error & { code?: string }) => opened.set(`rejected ${e.code ?? e.name}`),
            );
          } catch (e) {
            opened.set(`threw ${(e as Error).name}`);
          }
        }}
      >
        <Text>Open Settings</Text>
      </View>
    </View>
  );
}

export default App;
