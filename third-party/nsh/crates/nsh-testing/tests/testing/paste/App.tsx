import { type InputRef, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A field that decides what each paste does before anything is inserted:
// it keeps plain text, writes "shout:" pastes in capitals and drops pastes
// that look like secrets.
function App() {
  const value = signal("");
  const last = signal("none");
  let field: InputRef | undefined;
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Input
        testID="field"
        ref={(r) => (field = r)}
        value={value()}
        pasteBehavior="report"
        onChange={({ value: v }) => value.set(v)}
        onPaste={(e) => {
          if (e.text.startsWith("secret")) {
            last.set("cancelled");
          } else if (e.text.startsWith("shout:")) {
            last.set("rewritten");
            field?.insertText(e.text.slice("shout:".length).toUpperCase());
          } else {
            last.set("allowed");
            field?.insertText(e.text);
          }
        }}
      />
      <Text>{`Paste: ${last()}`}</Text>
    </View>
  );
}

mount(App);
