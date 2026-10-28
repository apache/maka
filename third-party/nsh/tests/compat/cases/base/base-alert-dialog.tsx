// A case of the API's test suite (docs/dev/compatibility.md):
// `AlertDialog.show` of `nsh/base`: it returns a promise, left pending
// while the dialog shows (no user answers it headless) for an alert and an
// action sheet with every option and action field set, and it rejects
// without actions. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { AlertDialog, type AlertDialogResult, Button } from "nsh/base";

function Control(props: { label: string; onPress: () => void }) {
  return (
    <Button onPress={props.onPress}>
      <Text>{props.label}</Text>
    </Button>
  );
}

function App() {
  const alert = signal("not shown");
  const sheet = signal("not shown");
  const empty = signal("not shown");
  const watch = (shown: Promise<AlertDialogResult>, set: (s: string) => void) => {
    set(shown instanceof Promise ? "pending" : "no promise");
    shown.then(
      ({ action }) => set(`chose ${action}`),
      (e) => set(`rejected ${String(e).includes("actions") ? "for actions" : e}`),
    );
  };
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Control
        label="Alert"
        onPress={() =>
          watch(
            AlertDialog.show({
              title: "Discard your changes?",
              description: "They are not saved.",
              actions: [
                { label: "Keep editing", role: "cancel", id: "keep" },
                { label: "Discard", role: "destructive", id: "discard" },
                { label: "Save", role: "default", id: "save" },
              ],
              presentation: "alert",
              closeOnEscape: true,
              closeOnBackdropPress: false,
            }),
            (s) => alert.set(s),
          )
        }
      />
      <Text>{`Alert: ${alert()}`}</Text>
      <Control
        label="Sheet"
        onPress={() =>
          watch(
            AlertDialog.show({
              title: null,
              description: null,
              actions: [{ label: "Copy", id: "copy" }, { label: "Cancel", role: "cancel", id: "cancel" }],
              presentation: "actionSheet",
              closeOnEscape: null,
              closeOnBackdropPress: null,
            }),
            (s) => sheet.set(s),
          )
        }
      />
      <Text>{`Sheet: ${sheet()}`}</Text>
      <Control label="Empty" onPress={() => watch(AlertDialog.show({ actions: [] }), (s) => empty.set(s))} />
      <Text>{`Empty: ${empty()}`}</Text>
    </View>
  );
}

export default App;
