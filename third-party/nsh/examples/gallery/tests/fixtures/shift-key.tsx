import { keymap, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const count = signal(0);
  keymap.bind("shift+8", () => count.set(count() + 1), { when: "always" });
  return <View style={{ flex: 1, paddingTop: 80 }}>
    <Input testID="field" style={{ height: 40 }} />
    <Text>{`shortcut: ${count()}`}</Text>
  </View>;
}

mount(App);
