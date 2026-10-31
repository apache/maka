import { keyboardFrame, mount, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A chat's shape: a scroll view of rows and, outside it, the field that shows the keyboard.
function App() {
  const presses = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24 }}>
      <Text>{keyboardFrame().height > 0 ? "keyboard: up" : "keyboard: down"}</Text>
      <Scroll style={{ flex: 1 }}>
        <View role="button" onPress={() => presses.set(presses() + 1)} style={{ height: 60, justifyContent: "center", padding: 16 }}>
          <Text>{`Row 1, pressed ${presses()}`}</Text>
        </View>
      </Scroll>
      <Input testID="message" placeholder="Message" style={{ height: 40, margin: 12 }} />
    </View>
  );
}

mount(App);
