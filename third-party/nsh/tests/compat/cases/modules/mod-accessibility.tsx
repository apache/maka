// A case of the API's test suite (docs/dev/compatibility.md):
// `nsh/accessibility` as the headless runtime reports it (no screen reader,
// full motion), and the calls that speak or move a screen reader's focus
// going through. Its script checks each.
import { Text, View, signal } from "nsh";
import { announce, reduceMotion, screenReaderEnabled, setAccessibilityFocus } from "nsh";

function App() {
  const calls = signal("not called");
  let note: any;
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Screen reader: ${screenReaderEnabled()}`}</Text>
      <Text>{`Reduce motion: ${reduceMotion()}`}</Text>
      <Text ref={note}>{`Calls: ${calls()}`}</Text>
      <View
        testID="call"
        onPress={() => {
          announce("Hello");
          setAccessibilityFocus(note);
          calls.set("done");
        }}
      >
        <Text>Call them</Text>
      </View>
    </View>
  );
}

export default App;
