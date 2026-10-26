// A case of the API's test suite (docs/dev/compatibility.md): `nsh/mobile`'s
// `BackHandler` off Android (the headless runtime is iOS): its functions are
// callable and do nothing, so an app that calls them runs on. Its script
// checks each.
import { Text, View, platform, signal } from "nsh";
import { BackHandler } from "nsh/mobile";

function App() {
  const calls = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Android: ${platform.os === "android"}`}</Text>
      <Text>{`Exit: ${typeof BackHandler.exitApp}`}</Text>
      <Text>{`Calls: ${calls()}`}</Text>
      <View
        testID="call"
        onPress={() => {
          const remove = BackHandler.onBackPress(() => true);
          remove();
          calls.set(`done, remove ${typeof remove}`);
        }}
      >
        <Text>Call them</Text>
      </View>
    </View>
  );
}

export default App;
