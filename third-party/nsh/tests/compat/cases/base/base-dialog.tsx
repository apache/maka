// A case of the API's test suite (docs/dev/compatibility.md): `Dialog` of
// `nsh/base`: shown while `open` is not false (open by default), its props
// as the platform receives them (defaults, every one set, the iOS ones),
// its popup styled by `style` and `class`, and what the platform reports:
// `onOpen` (it appeared), `onClose` (it went away), and the user's close
// attempts (`onCancel` every time; `onOpenChange({ open: false, reason })` and the
// dialog closing when the `closeOn*` flag of what they did lets it).
// Closed by the user while the app keeps `open` true, it stays closed until
// `open` goes from false to true. Dialogs carry a `testID` (spread, as
// `Dialog` declares none) for the script to find them. Its script checks
// each.
import { Text, View, signal } from "nsh";
import { Button, Dialog } from "nsh/base";

function Control(props: { label: string; onPress: () => void }) {
  return (
    <Button onPress={props.onPress}>
      <Text>{props.label}</Text>
    </Button>
  );
}

function App() {
  // A dialog the app keeps in sync with `onOpenChange`.
  const synced = signal(false);
  // One whose `open` the app never changes after the user closes it.
  const stubborn = signal(true);
  // One that closes only when the app says so.
  const guarded = signal(false);
  const swipes = signal(false);
  const log = signal<string[]>([]);
  const note = (line: string) => log.set([...log(), line]);
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text>{`Log: ${log().join(", ") || "empty"}`}</Text>
      <Control label="Open synced" onPress={() => synced.set(true)} />
      <Control label="Close synced" onPress={() => synced.set(false)} />
      <Control label="Stubborn off" onPress={() => stubborn.set(false)} />
      <Control label="Stubborn on" onPress={() => stubborn.set(true)} />
      <Control label="Open guarded" onPress={() => guarded.set(true)} />
      <Control label="Open swipes" onPress={() => swipes.set(true)} />
      <Control label="Clear log" onPress={() => log.set([])} />
      <Dialog {...{ testID: "plain" }}>
        <Text>Plain dialog</Text>
      </Dialog>
      <Dialog
        {...{ testID: "synced" }}
        open={synced()}
        animation="fade"
        presentation="pageSheet"
        style={{ padding: 20 }}
        onOpen={() => note("synced opened")}
        onClose={() => note("synced closed")}
        onCancel={() => note("synced cancel")}
        onOpenChange={({ open, reason }) => {
          note(`synced change ${open} ${reason}`);
          synced.set(open);
        }}
      >
        <View {...{ testID: "synced-body" }} style={{ height: 30 }}>
          <Text>Synced dialog</Text>
        </View>
      </Dialog>
      <Dialog
        {...{ testID: "stubborn" }}
        open={stubborn()}
        animation="none"
        presentation="formSheet"
        class="p-[12px]"
        ios={{ supportedOrientations: ["portrait", "landscape-left"] }}
        onOpenChange={({ open, reason }) => note(`stubborn change ${open} ${reason}`)}
      >
        <View {...{ testID: "stubborn-body" }} style={{ height: 30 }}>
          <Text>Stubborn dialog</Text>
        </View>
      </Dialog>
      <Dialog
        {...{ testID: "guarded" }}
        open={guarded()}
        closeOnEscape={false}
        closeOnBackdropPress={false}
        closeOnSwipe={false}
        onCancel={() => note("guarded cancel")}
        onOpenChange={({ open, reason }) => note(`guarded change ${open} ${reason}`)}
      >
        <Text>Guarded dialog</Text>
        <Control label="Close guarded" onPress={() => guarded.set(false)} />
      </Dialog>
      <Dialog
        {...{ testID: "swipes" }}
        open={swipes()}
        closeOnEscape={false}
        onOpenChange={({ open, reason }) => {
          note(`swipes change ${open} ${reason}`);
          swipes.set(open);
        }}
      >
        <Text>Swipes dialog</Text>
      </Dialog>
    </View>
  );
}

export default App;
