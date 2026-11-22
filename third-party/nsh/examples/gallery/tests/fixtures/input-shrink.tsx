import { keyboardFrame, mount, signal, View } from "nsh";
import { Input } from "nsh/base";

const LINE = 22;

// A chat composer: its height follows its text, and Send clears it back to one line.
function App() {
  const text = signal("");
  const height = signal(LINE);
  const send = () => {
    text.set("");
    height.set(LINE);
  };
  return (
    <View style={{ flex: 1, justifyContent: "flex-end", padding: 12, paddingBottom: 12 + keyboardFrame().height }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", borderWidth: 1, borderRadius: 12 }}>
        <Input
          testID="composer"
          placeholder="Message"
          multiline
          submitBehavior="newline"
          value={text()}
          onChange={({ value }) => text.set(value)}
          onContentSizeChange={({ size }) => height.set(Math.min(Math.max(size.height, LINE), LINE * 6))}
          style={{ flex: 1, height: height() + 20, paddingHorizontal: 8, paddingVertical: 10, fontSize: 15, lineHeight: 22 }}
        />
        <View role="button" accessibilityLabel="Send" onPress={send} style={{ width: 32, height: 32, margin: 6, backgroundColor: "#000" }} />
      </View>
    </View>
  );
}

mount(App);
