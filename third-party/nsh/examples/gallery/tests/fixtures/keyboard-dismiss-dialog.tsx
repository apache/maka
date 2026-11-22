import { Keyboard, mount, signal, Text, View } from "nsh";
import { Dialog, Input } from "nsh/base";

/** An input in a Dialog: Keyboard.dismiss must blur it (Android: another window). */
function App() {
  const focused = signal(false);
  return (
    <View style={{ flex: 1, backgroundColor: "#f5f5f5" }}>
      <Dialog
        open
        animation="fade"
        closeOnBackdropPress={false}
        class="m-auto gap-3 rounded-2xl bg-white p-5"
        style={{ width: 320 }}
        backdropStyle={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      >
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Note</Text>
        <Input
          testID="note"
          autoFocus
          placeholder="Add a note"
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          style={{ height: 44, borderWidth: 1, borderColor: "#d4d4d4", borderRadius: 8, paddingHorizontal: 12 }}
        />
        <View testID="blank" role="button" onPress={() => Keyboard.dismiss()} style={{ height: 44, justifyContent: "center" }}>
          <Text>Blank</Text>
        </View>
        <Text>{focused() ? "Focused: yes" : "Focused: no"}</Text>
      </Dialog>
    </View>
  );
}

mount(App);
