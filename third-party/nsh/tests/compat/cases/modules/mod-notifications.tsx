// A case of the API's test suite (docs/dev/compatibility.md):
// `Notifications` on the headless runtime, where nothing shows them:
// `permission()` and `requestPermission()` resolve "unavailable", `show`
// resolves false (a `silent` one too), `setBadge` and `close` resolve, `on`
// returns a function that stops listening. An empty `id` and a badge that is
// not a whole number reject with a `RangeError`. Its script checks each.
import { Notifications, Text, View, signal } from "nsh";

function App() {
  const permission = signal("unknown");
  const shown = signal("unknown");
  const refused = signal("none");
  const stop = Notifications.on("press", () => {});
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Permission: ${permission()}`}</Text>
      <Text>{`Shown: ${shown()}`}</Text>
      <Text>{`Refused: ${refused()}`}</Text>
      <View
        testID="notify"
        onPress={async () => {
          stop();
          const asked = await Notifications.requestPermission();
          permission.set(`${await Notifications.permission()} ${asked}`);
          await Notifications.setBadge(2);
          await Notifications.setBadge(0);
          await Notifications.close("a");
          const empty = await Notifications.show({ id: "", title: "T" }).catch((e: Error) => e.name);
          const count = await Notifications.setBadge(1.5).catch((e: Error) => e.name);
          refused.set(`${empty} ${count}`);
          const loud = await Notifications.show({ id: "a", title: "T", body: "B" });
          const quiet = await Notifications.show({ id: "b", title: "T", silent: true });
          shown.set(`${loud} ${quiet}`);
        }}
      >
        <Text>Notify</Text>
      </View>
    </View>
  );
}

export default App;
