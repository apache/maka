import { Keyboard, keymap, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const count = signal(0);
  const dismissed = signal(0);
  keymap.bind("k", () => count.set(count() + 1));
  keymap.bind("d", () => {
    Keyboard.dismiss();
    dismissed.set(dismissed() + 1);
  });
  return <View style={{ flex: 1, paddingTop: 80 }}>
    <Input testID="field" autoCapitalize="none" style={{ height: 40 }} />
    <Text>{`shortcut: ${count()}`}</Text>
    <Text>{`dismissed: ${dismissed()}`}</Text>
  </View>;
}

mount(App);
