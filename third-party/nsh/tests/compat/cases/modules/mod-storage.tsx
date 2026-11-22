// A case of the API's test suite (docs/dev/compatibility.md): `nsh/storage`
// (in memory on the headless runtime): values set, read back, listed in
// order, removed and cleared, each call seeing the ones before it; a value
// past the 5 MB quota rejects with `ERR_NSH_QUOTA_EXCEEDED` and is not kept.
// Its script checks each.
import { Text, View, signal } from "nsh";
import { Storage } from "nsh";

function App() {
  const state = signal("empty");
  const show = async (step: string) => {
    const keys = await Storage.keys();
    const values = await Promise.all(keys.map((k) => Storage.getItem(k)));
    const missing = await Storage.getItem("missing");
    state.set(`${step}: ${keys.map((k, i) => `${k}=${values[i]}`).join(",") || "none"} missing=${missing}`);
  };
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Storage ${state()}`}</Text>
      <View
        testID="set"
        onPress={async () => {
          await Storage.setItem("b", "2");
          await Storage.setItem("a", "1");
          await Storage.setItem("b", "two");
          await show("set");
        }}
      >
        <Text>Set</Text>
      </View>
      <View
        testID="remove"
        onPress={async () => {
          await Storage.removeItem("b");
          await show("removed");
        }}
      >
        <Text>Remove</Text>
      </View>
      <View
        testID="clear"
        onPress={async () => {
          await Storage.clear();
          await show("cleared");
        }}
      >
        <Text>Clear</Text>
      </View>
      <View
        testID="full"
        onPress={async () => {
          const refused = await Storage.setItem("big", "x".repeat(6 * 1024 * 1024)).then(
            () => "kept",
            (e) => `${e.name} ${e.code}`,
          );
          const kept = await Storage.getItem("big");
          state.set(`full: ${refused} kept=${kept !== null}`);
        }}
      >
        <Text>Fill</Text>
      </View>
    </View>
  );
}

export default App;
