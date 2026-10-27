// A case of the API's test suite (docs/dev/compatibility.md): the
// `RichEditor` view's bubble menu: the app's content shown next to the
// selection while the app passes it, gone when it does not.
import { Text, View, signal } from "nsh";
import { RichEditor, StarterKit, createRichEditor } from "nsh/base";

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: "Some text" });
  const open = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <View onPress={() => open.set(!open())}>
        <Text>ToggleMenu</Text>
      </View>
      <RichEditor
        editor={editor}
        style={{ height: 120 }}
        bubbleMenu={open() ? <Text>BubbleMenu</Text> : undefined}
        bubbleMenuPlacement="bottom"
        bubbleMenuOffset={4}
      />
    </View>
  );
}

export default App;
