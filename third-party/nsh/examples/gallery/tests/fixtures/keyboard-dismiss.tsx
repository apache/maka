import { Keyboard, keyboardFrame, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const editing = signal(true);
  const next = () => {
    editing.set(false);
    setTimeout(() => Keyboard.dismiss(), 100);
  };
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24, gap: 16 }}>
      {editing() ? <Input testID="name" placeholder="Name" style={{ height: 40 }} /> : <Text>Next screen</Text>}
      <View role="button" onPress={next} style={{ height: 44 }}>
        <Text>Next</Text>
      </View>
      <Text>{keyboardFrame().height > 0 ? "keyboard: up" : "keyboard: down"}</Text>
    </View>
  );
}

mount(App);
