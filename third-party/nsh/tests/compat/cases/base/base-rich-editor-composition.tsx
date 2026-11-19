// RichEditor reports composition state through its generated component
// event after its native sink/session are updated, including cancellation
// that leaves the document revision unchanged.
import { Text, View, signal } from "nsh";
import { RichEditor, StarterKit, createRichEditor } from "nsh/base";

function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: "Seed" });
  const baseline = editor.revision;
  const transitions = signal<boolean[]>([]);
  const observed = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <RichEditor
        editor={editor}
        accessibilityLabel="CompositionSink"
        style={{ height: 120 }}
        onCompositionChange={({ composing }) => {
          transitions.set([...transitions(), composing]);
          observed.set(`${editor.composing === composing} ${editor.revision - baseline} ${editor.getText()}`);
        }}
      />
      <Text>{`Transitions: ${transitions().join(",")}`}</Text>
      <Text>{`Observed: ${observed()}`}</Text>
    </View>
  );
}

export default App;
