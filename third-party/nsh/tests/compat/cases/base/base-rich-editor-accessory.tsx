// A case of the API's test suite (docs/dev/compatibility.md): a
// `RichEditor`'s `inputAccessoryViewID` names the `InputAccessoryView` its
// typing input shows over the keyboard, as an `Input`'s does, on the
// headless runtime, which is iOS. Its script checks that the input the
// editor types with names the bar and finds it.
import { Text, View } from "nsh";
import { RichEditor, StarterKit, createRichEditor } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: "Notes" });
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <RichEditor editor={editor} accessibilityLabel="AccessoryNotes" inputAccessoryViewID="format" style={{ height: 120 }} />
      <InputAccessoryView nativeID="format">
        <View style={{ height: 44 }}>
          <Text>Format bar</Text>
        </View>
      </InputAccessoryView>
      <Text>Rendered</Text>
    </View>
  );
}

export default App;
