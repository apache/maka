// A case of the API's test suite (docs/dev/compatibility.md): `Dialog` of
// `nsh/base` run as on Android (`platform android`), where its
// `android={{…}}` props apply and its `ios={{…}}` ones do not, and the
// back button closes it (`onCancel` with no reason is `"cancel"`). Dialogs
// carry a `testID` (spread, as `Dialog` declares none) for the script to
// find them. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { Dialog } from "nsh/base";

function App() {
  const open = signal(true);
  const reason = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text>{`Reason: ${reason()}`}</Text>
      <Dialog
        {...{ testID: "translucent" }}
        open={open()}
        android={{ statusBarTranslucent: true }}
        ios={{ supportedOrientations: ["landscape"] }}
        onOpenChange={(e) => {
          reason.set(e.reason);
          open.set(e.open);
        }}
      >
        <Text>Translucent dialog</Text>
      </Dialog>
      <Dialog {...{ testID: "opaque" }}>
        <Text>Opaque dialog</Text>
      </Dialog>
    </View>
  );
}

export default App;
