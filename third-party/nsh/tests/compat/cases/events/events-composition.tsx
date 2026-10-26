// A case of the API's test suite (docs/dev/compatibility.md): an input
// method's composition in an input (pinyin before a character is chosen),
// as `onCompositionChange` reports it: started, changed, ended. The handler
// shows what it gets as text, and the text the composition committed
// arrives through `onChange`. Its script checks each.
import { Text, View, signal } from "nsh";
import { Input } from "nsh/base";

function App() {
  const composition = signal("none");
  const text = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Input
        testID="compose"
        style={{ width: 300, height: 40 }}
        onChange={(t) => text.set(t)}
        onCompositionChange={(e) => composition.set(`${e.composing ? "composing" : "ended"} [${e.text}]`)}
      />
      <Text>Composition: {composition()}</Text>
      <Text>Committed: {text()}</Text>
    </View>
  );
}

export default App;
